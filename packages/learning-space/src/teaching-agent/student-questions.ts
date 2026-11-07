import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { ModelTool, ModelToolIntent } from '@xunjie/contracts/model-connections';
import { teachingStudentAskInputSchema, teachingStudentQuestionSchema, teachingStudentResponseInputSchema,
  teachingStudentResponseReceiptSchema, teachingStudentPresentationInputSchema, teachingStudentPresentationReceiptSchema,
  type TeachingEventKind, type TeachingRun,
  type TeachingStudentResponseReceipt } from '@xunjie/contracts/teaching-agent';
import { canonicalDigest, operationId } from './identity.js';
import type { TeachingPreparedTool, TeachingToolOutcome, TeachingToolScope } from './tool-types.js';
import { teachingPublicArguments } from './help-policy.js';

type Row = Record<string, unknown>;
const terminal = (state: unknown) => ['completed', 'failed', 'stopped', 'paused'].includes(String(state));
export const studentQuestionMigration: Migration = { version: 3, name: 'explicit-student-questions-and-responses', sql: `
  ALTER TABLE teaching_waits ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
  CREATE TABLE teaching_student_questions(question_id uuid PRIMARY KEY,activity_id uuid NOT NULL,
    run_id uuid NOT NULL REFERENCES teaching_runs(run_id),command_id uuid NOT NULL UNIQUE REFERENCES teaching_commands(command_id),
    wait_id uuid NOT NULL UNIQUE REFERENCES teaching_waits(wait_id),version integer NOT NULL CHECK(version=1),body jsonb NOT NULL,
    state text NOT NULL CHECK(state IN ('pending','answered','skipped','expired','cancelled')),
    response jsonb,presented_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX teaching_student_questions_activity ON teaching_student_questions(activity_id,created_at);
  CREATE TABLE teaching_student_responses(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL,question_id uuid NOT NULL,
    input_digest text NOT NULL,input jsonb NOT NULL,receipt jsonb NOT NULL);
  CREATE TABLE teaching_student_presentations(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL,question_id uuid NOT NULL,
    input_digest text NOT NULL,input jsonb NOT NULL,receipt jsonb NOT NULL);
` };

/** Fixed semantic capability student.ask; native names use the existing cross-protocol alphabet. */
export const studentAskDefinition: ModelTool = {
  name: 'student_ask',
  description: 'v1 student.ask. Ask one brief question needed for the current learning request, then wait for an explicit student response. Explain its source. Respect the course help policy; never ask for credentials, unrelated personal information or internal identifiers. Display, focus, silence and closing a page are not answers.',
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', minLength: 1, maxLength: 1000 }, source: { type: 'string', minLength: 1, maxLength: 500 },
    options: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
      id: { type: 'string', minLength: 1, maxLength: 64 }, label: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['id', 'label'], additionalProperties: false } }, allowText: { type: 'boolean' }, skippable: { type: 'boolean' },
  }, required: ['question', 'source', 'options', 'allowText', 'skippable'], additionalProperties: false },
};
export function prepareStudentAsk(scope: TeachingToolScope, intent: ModelToolIntent, commandId: string): TeachingPreparedTool {
  const parsed = teachingStudentAskInputSchema.safeParse(intent.arguments);
  if (!parsed.success) throw new StorageError('invalid');
  if (teachingPublicArguments(scope.activity, parsed.data) !== parsed.data) throw new StorageError('forbidden');
  if (scope.activity.status !== 'open' || scope.activity.course && scope.activity.course.helpPolicy?.questions !== 'allowed')
    throw new StorageError('forbidden');
  return { version: 1, commandId, name: studentAskDefinition.name, arguments: parsed.data, effect: 'ask', location: 'owner',
    conflictKey: scope.activity.activityId + ':student-question', basis: { capability: 'student.ask',
      activityId: scope.activity.activityId, sourceLabel: (scope.activity.course?.taskTitle || scope.activity.goal || '当前学习请求').slice(0, 500) } };
}

export function createStudentQuestions(storage: OwnedStorage, owner: {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>): Promise<unknown>;
}) {
  const event = owner.appendEvent;
  function question(row: Row) {
    return teachingStudentQuestionSchema.parse({ ...(row.body as object), state: row.state, response: row.response ?? null,
      presentedAt: row.presented_at ? new Date(row.presented_at as string).toISOString() : null });
  }
  async function list(activityId: string) {
    const { rows } = await storage.read('SELECT * FROM teaching_student_questions WHERE activity_id=$1 ORDER BY created_at,question_id', [activityId]);
    return rows.map(question);
  }
  /** Called inside the same authority-checked command transaction, before any projection can display it. */
  async function open(tx: OwnedTransaction, run: TeachingRun, step: Row, command: TeachingPreparedTool) {
    const input = teachingStudentAskInputSchema.parse(command.arguments);
    const questionId = operationId('student-question:' + command.commandId), waitId = operationId('teaching-wait:' + command.commandId);
    const { rows: [budget] } = await tx.query('SELECT wait_ms FROM teaching_budgets WHERE run_id=$1', [run.runId]);
    const { rows: [wait] } = await tx.query(`INSERT INTO teaching_waits(wait_id,run_id,step_id,command_id,purpose,state,reason,
      identity,command_digest,deadline,next_check_at) VALUES($1,$2,$3,$4,'result','pending','student',
      (SELECT identity FROM teaching_runs WHERE run_id=$2),$5,
      LEAST(clock_timestamp()+($6 || ' milliseconds')::interval,(SELECT deadline FROM teaching_budgets WHERE run_id=$2)),clock_timestamp())
      RETURNING deadline,clock_timestamp() AS created_at`, [waitId, run.runId, step.step_id, command.commandId,
      canonicalDigest(command), String(budget?.wait_ms ?? 86_400_000)]);
    const body = { ...input, source: { label: String(command.basis.sourceLabel), detail: input.source },
      questionId, version: 1, capability: 'student.ask', runId: run.runId, stepId: step.step_id,
      commandId: command.commandId, sourceInputId: run.inputId, waitId, waitVersion: 1,
      createdAt: new Date(wait!.created_at as string).toISOString(), deadline: new Date(wait!.deadline as string).toISOString() };
    await tx.query(`INSERT INTO teaching_student_questions(question_id,activity_id,run_id,command_id,wait_id,version,body,state)
      VALUES($1,$2,$3,$4,$5,1,$6,'pending')`, [questionId, run.activityId, run.runId, command.commandId, waitId, JSON.stringify(body)]);
    const outcome: TeachingToolOutcome = { state: 'accepted', feedback: { outcome: 'success', images: [],
      text: '问题已可靠保存，等待学生明确回应；呈现、忽略或关闭页面都不表示已回答。' },
      result: { questionId, questionVersion: 1, waitId, waitVersion: 1, answerState: 'pending' }, source: { label: '当前学习提问' } };
    await tx.query(`UPDATE teaching_commands SET state='waiting',outcome=$2,initial_outcome=$2,updated_at=clock_timestamp()
      WHERE command_id=$1`, [command.commandId, JSON.stringify(outcome)]);
    await tx.query("UPDATE teaching_runs SET state='waiting',updated_at=clock_timestamp() WHERE run_id=$1", [run.runId]);
    await event(tx, run.activityId, 'question-created', body);
    await event(tx, run.activityId, 'wait-created', { runId: run.runId, stepId: step.step_id, commandId: command.commandId,
      waitId, version: 1, purpose: 'result', source: 'student.ask' });
    await event(tx, run.activityId, 'tool-result', { runId: run.runId, stepId: step.step_id, commandId: command.commandId, outcome });
  }
  async function response(identity: SpaceIdentity, activityId: string, requestId: string) {
    await owner.activity(identity, activityId);
    teachingStudentResponseInputSchema.shape.requestId.parse(requestId);
    const { rows: [row] } = await storage.read('SELECT receipt FROM teaching_student_responses WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ? teachingStudentResponseReceiptSchema.parse(row.receipt) : null;
  }
  /** Ordered with explicit responses and input acceptance; supersession is never recorded as an answer. */
  async function supersede(tx: OwnedTransaction, activityId: string, runId: string, inputId: string) {
    const { rows } = await tx.query(`SELECT * FROM teaching_student_questions WHERE activity_id=$1 AND run_id=$2
      AND state='pending' ORDER BY created_at FOR UPDATE`, [activityId, runId]);
    for (const row of rows) {
      const saved = question(row);
      const outcome: TeachingToolOutcome = { state: 'completed', feedback: { outcome: 'success', images: [],
        text: '学生另发补充取代了尚未回应的问题。原提问已暂缓；没有记录学生回答。' },
        result: { questionId: saved.questionId, questionVersion: saved.version, answerState: 'superseded',
          reason: 'question-superseded', supersededByInputId: inputId }, source: { label: '已暂缓的原学习提问' } };
      await tx.query("UPDATE teaching_student_questions SET state='superseded' WHERE question_id=$1", [saved.questionId]);
      await tx.query("UPDATE teaching_waits SET state='consumed',consumed_at=clock_timestamp() WHERE wait_id=$1 AND state='pending'", [saved.waitId]);
      await tx.query("UPDATE teaching_commands SET state='settled',outcome=$2,updated_at=clock_timestamp() WHERE command_id=$1",
        [saved.commandId, JSON.stringify(outcome)]);
      await event(tx, activityId, 'question-superseded', { runId, questionId: saved.questionId, inputId, reason: 'new-steering' });
      await event(tx, activityId, 'wait-consumed', { runId, waitId: saved.waitId, commandId: saved.commandId,
        source: 'question-superseded', answered: false });
      await event(tx, activityId, 'tool-result', { runId, commandId: saved.commandId, outcome });
    }
  }
  async function present(identity: SpaceIdentity, activityId: string, questionId: string, value: unknown) {
    const activity = await owner.activity(identity, activityId);
    teachingStudentQuestionSchema.shape.questionId.parse(questionId);
    const input = teachingStudentPresentationInputSchema.parse(value), inputDigest = canonicalDigest({ activityId, questionId, input });
    const receipt = await storage.request({ requestId: 'student-question-presentation:' + input.requestId, fingerprint: inputDigest }, async tx => {
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT DO NOTHING', [activityId]);
      const { rows: [row] } = await tx.query(`SELECT q.*,w.version AS wait_version,w.deadline>clock_timestamp() AS live
        FROM teaching_student_questions q JOIN teaching_waits w USING(wait_id)
        WHERE q.question_id=$1 AND q.activity_id=$2 FOR UPDATE OF q`, [questionId, activityId]);
      const reason = !row ? 'question-missing' : row.version !== input.questionVersion || row.wait_version !== input.waitVersion
        ? 'version-mismatch' : row.state !== 'pending' || !row.live ? 'question-not-pending' : activity.status !== 'open' ? 'activity-closed' : '';
      const presentedAt = !reason ? row!.presented_at ? new Date(row!.presented_at as string).toISOString() : new Date().toISOString() : null;
      const result = { ...input, questionId, status: reason ? 'ignored' : 'presented', reason, presentedAt };
      if (!reason) await tx.query('UPDATE teaching_student_questions SET presented_at=COALESCE(presented_at,$2) WHERE question_id=$1', [questionId, presentedAt]);
      await tx.query('INSERT INTO teaching_student_presentations VALUES($1,$2,$3,$4,$5,$6)',
        [input.requestId, activityId, questionId, inputDigest, JSON.stringify(input), JSON.stringify(result)]);
      await event(tx, activityId, 'question-presented', { ...result, runId: row?.run_id ?? null });
      return result;
    });
    return teachingStudentPresentationReceiptSchema.parse(receipt.result);
  }
  async function cancelRun(run: TeachingRun) {
    await storage.request({ requestId: 'student-question-cancel:' + run.runId, fingerprint: run.runId }, async tx => {
      const { rows: [current] } = await tx.query('SELECT state,stop_requested FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [run.runId]);
      if (!current || !current.stop_requested && !terminal(current.state)) throw new StorageError('conflict');
      const { rows } = await tx.query("SELECT * FROM teaching_student_questions WHERE run_id=$1 AND state='pending' ORDER BY question_id FOR UPDATE", [run.runId]);
      for (const row of rows) {
        const saved = question(row);
        const outcome: TeachingToolOutcome = { state: 'failed', feedback: { outcome: 'error', images: [],
          text: '原任务已停止，这次提问已取消；没有记录学生回答。' },
          result: { questionId: saved.questionId, answerState: 'cancelled', reason: 'run-stopped' }, source: { label: '原学习提问' } };
        await tx.query("UPDATE teaching_student_questions SET state='cancelled' WHERE question_id=$1", [saved.questionId]);
        await tx.query("UPDATE teaching_waits SET state='expired' WHERE wait_id=$1 AND state='pending'", [saved.waitId]);
        await tx.query("UPDATE teaching_commands SET state='settled',outcome=$2,updated_at=clock_timestamp() WHERE command_id=$1",
          [saved.commandId, JSON.stringify(outcome)]);
        await event(tx, run.activityId, 'question-cancelled', { runId: run.runId, questionId: saved.questionId,
          questionVersion: saved.version, waitId: saved.waitId, waitVersion: saved.waitVersion, reason: 'run-stopped' });
      }
      return null;
    });
  }
  async function expireQuestion(tx: OwnedTransaction, row: Row) {
    const saved = question(row);
    const outcome: TeachingToolOutcome = { state: 'failed', feedback: { outcome: 'error', images: [],
      text: '学生回应的等待期限已到，原问题未收到明确回应；运行已暂停，没有重新生成。' },
      result: { questionId: saved.questionId, answerState: 'expired', reason: 'student-response-expired' }, source: { label: '原学习提问' } };
    await tx.query("UPDATE teaching_student_questions SET state='expired' WHERE question_id=$1", [saved.questionId]);
    await tx.query("UPDATE teaching_waits SET state='expired' WHERE wait_id=$1 AND state='pending'", [saved.waitId]);
    await tx.query("UPDATE teaching_commands SET state='settled',outcome=$2,updated_at=clock_timestamp() WHERE command_id=$1", [saved.commandId, JSON.stringify(outcome)]);
    await tx.query(`UPDATE teaching_runs SET state='waiting',reason='student-response-expired',lease_owner=NULL,lease_expires_at=NULL,
      updated_at=clock_timestamp() WHERE run_id=$1 AND state='waiting' AND stop_requested=false`, [saved.runId]);
    for (const kind of ['question-expired', 'wait-expired'] as const) await event(tx, String(row.activity_id), kind,
      { runId: saved.runId, questionId: saved.questionId, questionVersion: saved.version, waitId: saved.waitId,
        waitVersion: saved.waitVersion, reason: 'student-response-expired' });
  }
  async function expire() {
    const { rows } = await storage.read(`SELECT q.question_id,q.run_id FROM teaching_student_questions q JOIN teaching_waits w USING(wait_id)
      WHERE q.state='pending' AND w.deadline<=clock_timestamp() ORDER BY w.deadline,q.question_id LIMIT 20`);
    for (const candidate of rows) await storage.request({ requestId: 'student-question-expire:' + candidate.question_id,
      fingerprint: String(candidate.question_id) }, async tx => {
      const { rows: [run] } = await tx.query('SELECT stop_requested FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [candidate.run_id]);
      if (!run || run.stop_requested) return null;
      const { rows: [row] } = await tx.query(`SELECT q.*,w.deadline<=clock_timestamp() AS expired FROM teaching_student_questions q
        JOIN teaching_waits w USING(wait_id) WHERE q.question_id=$1 FOR UPDATE OF q,w`, [candidate.question_id]);
      if (row?.state === 'pending' && row.expired) await expireQuestion(tx, row);
      return null;
    });
  }
  async function respond(identity: SpaceIdentity, activityId: string, questionId: string, value: unknown) {
    const activity = await owner.activity(identity, activityId);
    teachingStudentQuestionSchema.shape.questionId.parse(questionId);
    const input = teachingStudentResponseInputSchema.parse(value), inputDigest = canonicalDigest({ activityId, questionId, input });
    const { rows: [original] } = await storage.read('SELECT run_id FROM teaching_student_questions WHERE question_id=$1 AND activity_id=$2', [questionId, activityId]);
    const result = await storage.request({ requestId: 'student-response:' + input.requestId, fingerprint: inputDigest }, async tx => {
      await tx.query('INSERT INTO teaching_sessions(activity_id) VALUES($1) ON CONFLICT DO NOTHING', [activityId]);
      const runId = original ? String(original.run_id) : null;
      const run = runId ? (await tx.query('SELECT * FROM teaching_runs WHERE run_id=$1 FOR UPDATE', [runId])).rows[0] : null;
      const { rows: [row] } = await tx.query('SELECT * FROM teaching_student_questions WHERE question_id=$1 AND activity_id=$2 FOR UPDATE', [questionId, activityId]);
      const saved = row ? question(row) : null;
      const wait = saved ? (await tx.query('SELECT *,deadline>clock_timestamp() AS live FROM teaching_waits WHERE wait_id=$1 FOR UPDATE', [saved.waitId])).rows[0] : null;
      let reason = !saved || !run || !wait ? 'question-missing'
        : input.questionVersion !== saved.version || input.waitVersion !== Number(wait.version) ? 'version-mismatch'
        : saved.state === 'superseded' ? 'question-superseded'
        : ['answered', 'skipped'].includes(saved.state) || wait.state === 'consumed' ? 'already-answered'
        : run.stop_requested || saved.state === 'cancelled' ? 'cancelled'
        : saved.state === 'expired' || !wait.live ? 'expired'
        : saved.state !== 'pending' || wait.state !== 'pending' ? 'question-closed'
        : terminal(run.state) ? 'run-terminated'
        : activity.status !== 'open' ? 'activity-closed'
        : activity.course && activity.course.helpPolicy?.questions !== 'allowed' ? 'course-help-policy-disabled' : '';
      let text = '';
      if (!reason && saved) {
        const answer = input.answer;
        if (answer.kind === 'choice') {
          const option = saved.options.find(option => option.id === answer.optionId);
          if (!option) reason = 'invalid-answer'; else text = option.label;
        } else if (answer.kind === 'text') {
          if (!saved.allowText) reason = 'invalid-answer'; else text = answer.text;
        } else if (!saved.skippable) reason = 'invalid-answer'; else text = '跳过这次提问';
      }
      const receipt: TeachingStudentResponseReceipt = { requestId: input.requestId, questionId, questionVersion: input.questionVersion,
        waitVersion: input.waitVersion, runId, inputDigest, status: reason ? 'rejected' : 'accepted',
        reason: reason || (input.answer.kind === 'skip' ? 'skipped' : 'answered'), processedAt: new Date().toISOString() };
      if (reason === 'expired' && row?.state === 'pending') await expireQuestion(tx, row);
      if (!reason && saved && row && run) {
        const explicit = { requestId: input.requestId, answer: input.answer, text, processedAt: receipt.processedAt };
        const outcome: TeachingToolOutcome = { state: 'completed', feedback: { outcome: 'success', images: [],
          text: input.answer.kind === 'skip' ? '学生明确跳过了本次提问；完整回应及来源另以明确回应观察提供。'
            : '学生已明确回应本次提问；完整原文及来源另以明确回应观察提供。' },
          result: { questionId, questionVersion: saved.version, waitVersion: saved.waitVersion, responseId: input.requestId,
            answerState: input.answer.kind === 'skip' ? 'skipped' : 'answered', question: saved.question, source: saved.source, response: explicit },
          source: { label: '学生对当前提问的明确回应' } };
        await tx.query(`UPDATE teaching_student_questions SET state=$2,response=$3 WHERE question_id=$1`,
          [questionId, input.answer.kind === 'skip' ? 'skipped' : 'answered', JSON.stringify(explicit)]);
        await tx.query("UPDATE teaching_waits SET state='consumed',consumed_at=clock_timestamp() WHERE wait_id=$1", [saved.waitId]);
        await tx.query("UPDATE teaching_commands SET state='settled',outcome=$2,updated_at=clock_timestamp() WHERE command_id=$1", [saved.commandId, JSON.stringify(outcome)]);
        await tx.query(`UPDATE teaching_runs SET state=CASE WHEN state='waiting' AND lease_owner IS NULL THEN 'received' ELSE state END,
          updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
        await event(tx, activityId, 'wait-consumed', { runId, stepId: saved.stepId, commandId: saved.commandId, waitId: saved.waitId,
          version: saved.waitVersion, responseId: input.requestId, source: 'student-response' });
      }
      await tx.query('INSERT INTO teaching_student_responses(request_id,activity_id,question_id,input_digest,input,receipt) VALUES($1,$2,$3,$4,$5,$6)',
        [input.requestId, activityId, questionId, inputDigest, JSON.stringify(input), JSON.stringify(receipt)]);
      await event(tx, activityId, 'student-response', { runId, questionId, questionVersion: input.questionVersion,
        waitVersion: input.waitVersion, responseId: input.requestId, status: receipt.status, reason: receipt.reason,
        ...(receipt.status === 'accepted' ? { text, answer: input.answer, source: saved!.source } : {}) });
      return receipt;
    });
    return teachingStudentResponseReceiptSchema.parse(result.result);
  }
  return { list, open, response, respond, present, cancelRun, expire, supersede };
}

/** New facts belong to the same owner maintenance and are checked without invoking tools or models. */
export async function validateStudentQuestions(storage: OwnedStorage) {
  const { rows } = await storage.read(`SELECT q.*,w.state AS wait_state,w.version AS wait_version,c.state AS command_state,
    c.run_id AS command_run FROM teaching_student_questions q JOIN teaching_waits w USING(wait_id)
    JOIN teaching_commands c ON c.command_id=q.command_id`);
  const { rows: [count] } = await storage.read('SELECT count(*) AS total FROM teaching_student_questions');
  if (rows.length !== Number(count!.total)) throw new StorageError('corrupt');
  for (const row of rows) {
    const saved = teachingStudentQuestionSchema.parse({ ...(row.body as object), state: row.state, response: row.response ?? null,
      presentedAt: row.presented_at ? new Date(row.presented_at as string).toISOString() : null });
    if (saved.questionId !== row.question_id || saved.version !== row.version || saved.commandId !== row.command_id
      || saved.waitId !== row.wait_id || saved.runId !== row.run_id || row.command_run !== row.run_id
      || saved.waitVersion !== row.wait_version || saved.questionId !== operationId('student-question:' + saved.commandId)
      || !!saved.response !== ['answered', 'skipped'].includes(saved.state)
      || saved.response && (row.wait_state !== 'consumed' || row.command_state !== 'settled')
      || saved.state === 'superseded' && (saved.response || row.wait_state !== 'consumed' || row.command_state !== 'settled')) throw new StorageError('corrupt');
  }
  const { rows: responses } = await storage.read('SELECT * FROM teaching_student_responses');
  for (const row of responses) {
    const input = teachingStudentResponseInputSchema.parse(row.input), receipt = teachingStudentResponseReceiptSchema.parse(row.receipt);
    if (input.requestId !== row.request_id || receipt.requestId !== row.request_id || receipt.questionId !== row.question_id
      || receipt.inputDigest !== row.input_digest || receipt.inputDigest !== canonicalDigest({ activityId: row.activity_id, questionId: row.question_id, input }))
      throw new StorageError('corrupt');
  }
  const { rows: presentations } = await storage.read('SELECT * FROM teaching_student_presentations');
  for (const row of presentations) {
    const input = teachingStudentPresentationInputSchema.parse(row.input), receipt = teachingStudentPresentationReceiptSchema.parse(row.receipt);
    if (input.requestId !== row.request_id || receipt.requestId !== row.request_id || receipt.questionId !== row.question_id
      || row.input_digest !== canonicalDigest({ activityId: row.activity_id, questionId: row.question_id, input })) throw new StorageError('corrupt');
  }
}
