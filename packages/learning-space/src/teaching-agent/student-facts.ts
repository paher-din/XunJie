import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { spaceIdentitySchema, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import {
  studentFactSchema, studentFactScopeSchema, studentFactsReadInputSchema, studentFactsReadResultSchema,
  type StudentFact, type StudentFactScope, type StudentFactsReadResult,
} from '@xunjie/contracts/student-facts';
import { canonicalDigest, operationId } from './identity.js';

/**
 * Student explicit facts are an independent teaching-agent owner fact table. The
 * table never stores inferred learning ability, only explicit preference
 * statements with their original event identity.
 */
export const studentFactsMigration: Migration = { version: 13, name: 'student-explicit-facts-read', sql: `
  CREATE TABLE teaching_student_facts(fact_id uuid PRIMARY KEY,activity_id uuid NOT NULL,owner_key text NOT NULL,
    kind text NOT NULL DEFAULT 'preference' CHECK(kind='preference'),topic text NOT NULL,statement text NOT NULL,
    source_event_id uuid NOT NULL,source_event_seq bigint NOT NULL,source_input_id uuid,
    content_version integer NOT NULL CHECK(content_version>0),scope jsonb NOT NULL,
    review_status text NOT NULL CHECK(review_status IN ('unreviewed','confirmed','corrected','retracted')),
    supersedes uuid,retracted_by uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(activity_id,source_event_id,topic));
  CREATE INDEX teaching_student_facts_owner ON teaching_student_facts(owner_key,activity_id,created_at);
` };

/** Activity metadata needed to scope an explicit personal continuation without reading another owner's table. */
export const studentFactsGoalMigration: Migration = { version: 14, name: 'student-explicit-facts-activity-goal', sql: `
  ALTER TABLE teaching_student_facts ADD COLUMN activity_goal text NOT NULL DEFAULT '';
  ALTER TABLE teaching_student_facts ADD COLUMN activity_course_id uuid;
` };

type Row = Record<string, unknown>;
const ownerKey = (identity: SpaceIdentity) => [identity.environmentId, identity.spaceId, identity.principalId].join('/');
/** Only the activity facts needed by this owner module; host fixtures need not carry every learning field. */
const activityViewSchema = z.object({ activityId: z.uuid(), identity: spaceIdentitySchema, goal: z.string(),
  question: z.string().optional().default(''),
  course: z.object({ courseId: z.uuid() }).passthrough().nullable().optional() }).passthrough();
type ActivityView = z.infer<typeof activityViewSchema>;

export interface TeachingStudentFactCandidate { topic: string; statement: string; correction: boolean }
export interface TeachingStudentFactRecordInput {
  identity: SpaceIdentity;
  activity: LearningActivity;
  inputId?: string | null;
  eventId: string;
  eventSeq: number;
  contentVersion?: number;
  text: string;
  createdAt?: string;
}
export interface TeachingStudentFactsOptions {
  /** Host-owned activity read. The narrow owner storage cannot read another owner's `activities` table. */
  activity?(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  authorize?(identity: SpaceIdentity): Promise<void>;
}

const PLACEHOLDER = /^(?:无|暂无|没有|略|空|待定|随便|都可以|都行|无所谓|看着办|n\/?a|none|null|-+|—+|\.{2,}|…+)$/iu;
const NON_STUDENT = /^(?:演示画像|示例画像|样例画像|busyinputmode|busyInputMode)/iu;
const QUESTION_START = /^(?:请问|为什么|怎么|如何|什么|哪|是否|能不能|可不可以|有没有|do\b|does\b|did\b|can\b|could\b|would\b|should\b|is\b|are\b|what\b|why\b|how\b|when\b|where\b|which\b|who\b)/iu;
const ZH_EXPLICIT = /(?:我(?:们)?(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要)|我(?:们)?想(?!知道|了解|问)|我(?:以后|之后)|请(?:你)?(?:以后|之后|尽量|优先|用|把|按|给|帮|不要|别|记得|记住)|以后|之后|今后|未来|从现在(?:起|开始)|不要|不用|别再|别总|别老|别用|务必|一定|尽量|优先|记得|改成|改为|换成|不再|取消|收回|撤销)/u;
const EN_EXPLICIT = /(?:\bi(?:\s+really)?\s+(?:like|love|prefer|usually|always|never|want|hope|need|require)\b|\bi'?d\s+(?:like|prefer)\b|\bwe\s+(?:like|prefer|usually|always|never|want|hope|need|require)\b|\bplease\s+(?:always|never|use|don'?t|do not|from now on)\b|\bfrom now on\b|\bdon'?t\b|\bdo not\b|\bnever\b|\balways\b|\bprefer\b|\binstead\b|\bmake sure\b|\bremember to\b)/i;
const CORRECTION = /(?:不再|别再|别总|别老|别用|别把|别给|别问|别写|别做|别讲|别说|别催|别改|不要再用|不用再|改成|改为|换成|改掉|取消|收回|撤销)/u;
const COURSE_SCOPE = /(?:这门课|本课程|这个课程|该课程|这门课程)/u;
const GLOBAL_SCOPE = /(?:以后|之后|今后|未来|从现在|所有|一直|不论哪门课|不管哪门课|任何课程|所有课程|每门课|全部课程)/u;
const CONTINUATION_TEXT = /(?:继续这个目标|继续这个主题|延续这个目标|延续这个主题|同一主题|same goal|same topic)/iu;

const TOPIC_MARKERS = /(?:我(?:们)?|本人|学生)?(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要|想)|请(?:你)?|以后都?|之后都?|今后|未来|从现在(?:起|开始)|不要|不用|别再|别总|别老|别用|别把|别给|记住|不再|改成|改为|换成|改掉|取消|收回|撤销|务必|一定|尽量|优先|记得/gu;
const EN_TOPIC_MARKERS = /^(?:i(?:'?d| would)?\s+(?:really\s+)?(?:like|love|prefer|want|hope|need|require)|we\s+(?:really\s+)?(?:like|love|prefer|want|hope|need|require)|please|always|never|from now on|instead)\s+/iu;

/** Keyword buckets keep one stable topic across corrections of the same preference dimension. */
const TOPIC_CATEGORIES: readonly [string, RegExp][] = [
  ['解释语言', /中文|英文|英语|汉语|日文|日语|语言|chinese|english|language/iu],
  ['例子', /例子|举例|示例|案例|实例|example|instance/iu],
  ['格式', /格式|表格|列表|清单|要点|大纲|思维导图|代码块|标题|format|table|bullet|outline/iu],
  ['详略', /详细|简短|简洁|展开|概括|总结|步骤|一步一步|原理|深入|通俗|short|brief|concise|detailed|detail|steps?|principle/iu],
  ['节奏', /慢一点|快一点|节奏|速度|语速|pace|speed|slow|fast/iu],
  ['难度', /简单|基础|进阶|难度|difficult|beginner|advanced|easy/iu],
  ['互动', /提问|互动|讨论|对话|question|discussion|interactive/iu],
  ['练习', /作业|练习|习题|题目|practice|exercise|homework/iu],
  ['材料', /资料|材料|课本|教材|视频|文章|material|textbook|video|article/iu],
  ['时间', /时间|分钟|小时|每天|每周|日程|minute|hour|daily|weekly/iu],
  ['语气', /语气|严肃|幽默|轻松|亲切|tone|humou?r|friendly/iu],
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，,。.!！?？;；:：、"'“”‘’()（）【】\[\]{}<>《》]/gu, '');
}
function bigrams(value: string): Set<string> {
  const chars = [...value];
  if (chars.length < 2) return new Set(chars);
  const result = new Set<string>();
  for (let index = 0; index < chars.length - 1; index++) result.add(chars[index]! + chars[index + 1]!);
  return result;
}
function containment(left: string, right: string): number {
  const a = bigrams(left), b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / Math.min(a.size, b.size);
}
function topicSimilarity(left: TeachingStudentFactCandidate | { topic: string; statement: string },
  right: { topic: string; statement: string }): number {
  const a = normalize(left.topic), b = normalize(right.topic);
  if (a && a === b) return 1;
  const topicScore = containment(a, b);
  const statementScore = containment(normalize(left.statement), normalize(right.statement));
  return Math.max(topicScore, statementScore * 0.9);
}

function isQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  return /[?？]\s*$/u.test(trimmed) || QUESTION_START.test(trimmed) || /(?:吗|呢)\s*$/u.test(trimmed);
}

function splitSentences(text: string): string[] {
  return text.replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+|(?<=[.])\s+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function topicOf(value: string): string {
  const source = value.trim().replace(TOPIC_MARKERS, '').replace(EN_TOPIC_MARKERS, '')
    .replace(/^(?:please|always|never|from now on|instead)\s+/iu, '').replace(/^[，,、：:\s]+/u, '');
  for (const [topic, pattern] of TOPIC_CATEGORIES) if (pattern.test(value) || pattern.test(source)) return topic;
  const cleaned = source.replace(/[，,。.!！?？；;：:\s]+$/u, '').slice(0, 200);
  return cleaned || normalize(value).slice(0, 200);
}

/** A sentence with several explicitly marked clauses yields one fact per clause. */
function clausesOf(sentence: string): string[] {
  if (CORRECTION.test(sentence)) return [sentence];
  const parts = sentence.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return [sentence];
  const marked = parts.filter(part => (ZH_EXPLICIT.test(part) || EN_EXPLICIT.test(part))
    && !PLACEHOLDER.test(part) && !isQuestion(part));
  return marked.length >= 2 ? marked : [sentence];
}

/**
 * Conservative extraction: one explicit preference per sentence. Questions,
 * empty placeholders and non-student profile text never produce a fact.
 */
export function extractStudentFacts(text: string): TeachingStudentFactCandidate[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const facts: TeachingStudentFactCandidate[] = [];
  for (const sentence of splitSentences(text)) {
    for (const clause of clausesOf(sentence)) {
      const statement = clause.trim();
      if (statement.length < 2 || statement.length > 4000) continue;
      if (PLACEHOLDER.test(statement.replace(/[。.!！?？；;\s]+$/u, '')) || NON_STUDENT.test(statement)
        || isQuestion(statement)) continue;
      if (!ZH_EXPLICIT.test(statement) && !EN_EXPLICIT.test(statement)) continue;
      const correction = CORRECTION.test(statement);
      let topicSource = statement;
      if (correction) {
        const match = CORRECTION.exec(statement);
        if (match) {
          const before = statement.slice(0, match.index).replace(/^(?:我(?:们)?|本人|请(?:你)?|以后|之后|今后|从现在(?:起|开始))\s*/u, '')
            .replace(/^(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要)\s*/u, '').trim();
          topicSource = before || statement.slice(match.index + match[0].length);
        }
      }
      const topic = topicOf(topicSource);
      if (!topic || topic.length < 2) continue;
      facts.push({ topic, statement, correction });
    }
  }
  return facts;
}

function scopeOf(statement: string, activity: ActivityView): StudentFactScope {
  if (activity.course && COURSE_SCOPE.test(statement)) return { kind: 'course', courseId: activity.course.courseId };
  if (GLOBAL_SCOPE.test(statement)) return { kind: 'global' };
  return { kind: 'activity', activityId: activity.activityId };
}

function toFact(row: Row): StudentFact {
  return studentFactSchema.parse({
    factId: row.fact_id, kind: row.kind, topic: row.topic, statement: row.statement,
    source: { eventId: row.source_event_id, seq: Number(row.source_event_seq), activityId: row.activity_id,
      ...(row.source_input_id ? { inputId: row.source_input_id } : {}),
      createdAt: new Date(row.created_at as string).toISOString() },
    contentVersion: Number(row.content_version), scope: row.scope, reviewStatus: row.review_status,
    supersedes: row.supersedes ?? null, retractedBy: row.retracted_by ?? null,
  });
}

/**
 * Owner module for explicit student preferences. `record` is safe to call inside
 * the same transaction that appends the source input event; without a
 * transaction it derives one durable receipt from the event identity.
 */
export function createTeachingStudentFacts(storage: OwnedStorage, options: TeachingStudentFactsOptions = {}) {
  async function loadActivity(identity: SpaceIdentity, activityId: string): Promise<ActivityView> {
    if (!options.activity) throw new StorageError('unavailable');
    const activity = activityViewSchema.parse(await options.activity(identity, activityId));
    if (activity.activityId !== activityId || activity.identity.environmentId !== identity.environmentId
      || activity.identity.spaceId !== identity.spaceId || activity.identity.principalId !== identity.principalId)
      throw new StorageError('forbidden');
    return activity;
  }

  async function correctionTarget(tx: OwnedTransaction, input: {
    identity: SpaceIdentity; activityId: string; eventId: string; courseId: string | null; candidate: TeachingStudentFactCandidate;
  }): Promise<Row | null> {
    const { rows } = await tx.query(`SELECT * FROM teaching_student_facts
      WHERE owner_key=$1 AND review_status<>'retracted' AND NOT(activity_id=$2 AND source_event_id=$3)
        AND (activity_id=$2 OR scope->>'kind'='global'
          OR ($4::text IS NOT NULL AND scope->>'kind'='course' AND scope->>'courseId'=$4))
      ORDER BY (activity_id=$2) DESC,created_at DESC,fact_id`,
    [ownerKey(input.identity), input.activityId, input.eventId, input.courseId]);
    let best: Row | null = null, bestScore = 0;
    for (const row of rows) {
      const score = topicSimilarity(input.candidate, { topic: String(row.topic), statement: String(row.statement) });
      if (score > bestScore) { best = row; bestScore = score; }
    }
    return bestScore >= 0.6 ? best : null;
  }

  async function writeFacts(tx: OwnedTransaction, input: {
    identity: SpaceIdentity; activity: ActivityView; inputId: string | null; eventId: string;
    eventSeq: number; contentVersion: number; text: string; createdAt: string;
  }): Promise<StudentFact[]> {
    const { rows: [event] } = await tx.query('SELECT activity_id,seq,event_id FROM teaching_events WHERE event_id=$1',
      [input.eventId]);
    if (!event || event.activity_id !== input.activity.activityId || Number(event.seq) !== input.eventSeq)
      throw new StorageError('corrupt');
    const facts: StudentFact[] = [];
    for (const candidate of extractStudentFacts(input.text)) {
      // Event identity plus topic is the durable idempotency key; a retry never retracts twice.
      const { rows: [prior] } = await tx.query(`SELECT * FROM teaching_student_facts
        WHERE activity_id=$1 AND source_event_id=$2 AND topic=$3`, [input.activity.activityId, input.eventId, candidate.topic]);
      if (prior) { facts.push(toFact(prior)); continue; }
      const factId = operationId(`student-fact:${input.activity.activityId}:${input.eventId}:${candidate.topic}`);
      let supersedes: string | null = null;
      let reviewStatus: 'unreviewed' | 'corrected' = 'unreviewed';
      if (candidate.correction) {
        const target = await correctionTarget(tx, { identity: input.identity, activityId: input.activity.activityId,
          eventId: input.eventId, courseId: input.activity.course?.courseId ?? null, candidate });
        if (target) {
          const updated = await tx.query(`UPDATE teaching_student_facts SET review_status='retracted',retracted_by=$2
            WHERE fact_id=$1 AND review_status<>'retracted' RETURNING fact_id`, [target.fact_id, factId]);
          if (updated.rows.length) { supersedes = String(target.fact_id); reviewStatus = 'corrected'; }
        }
      }
      const { rows: [inserted] } = await tx.query(`INSERT INTO teaching_student_facts(fact_id,activity_id,owner_key,kind,
        topic,statement,source_event_id,source_event_seq,source_input_id,content_version,scope,review_status,
        supersedes,retracted_by,created_at,activity_goal,activity_course_id)
        VALUES($1,$2,$3,'preference',$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15)
        ON CONFLICT(activity_id,source_event_id,topic) DO NOTHING RETURNING *`,
      [factId, input.activity.activityId, ownerKey(input.identity), candidate.topic, candidate.statement,
        input.eventId, input.eventSeq, input.inputId, input.contentVersion, JSON.stringify(scopeOf(candidate.statement, input.activity)),
        reviewStatus, supersedes, input.createdAt, input.activity.goal, input.activity.course?.courseId ?? null]);
      if (inserted) facts.push(toFact(inserted));
      else {
        const { rows: [existing] } = await tx.query(`SELECT * FROM teaching_student_facts
          WHERE activity_id=$1 AND source_event_id=$2 AND topic=$3`, [input.activity.activityId, input.eventId, candidate.topic]);
        if (existing) facts.push(toFact(existing));
      }
    }
    return facts;
  }

  /**
   * Integration contract used by `accept`: the caller supplies the transaction
   * that just appended the input event, so the fact write is atomic with it.
   */
  async function record(tx: OwnedTransaction, value: TeachingStudentFactRecordInput): Promise<StudentFact[]>;
  /** Standalone convenience for maintenance/tests; idempotent by event identity. */
  async function record(value: TeachingStudentFactRecordInput): Promise<StudentFact[]>;
  async function record(first: OwnedTransaction | TeachingStudentFactRecordInput,
    second?: TeachingStudentFactRecordInput): Promise<StudentFact[]> {
    const input = second ?? first as TeachingStudentFactRecordInput;
    const transaction = second ? first as OwnedTransaction : undefined;
    if (!extractStudentFacts(input.text).length) return [];
    const identity = spaceIdentitySchema.parse(input.identity);
    const activity = activityViewSchema.parse(input.activity);
    if (activity.identity.environmentId !== identity.environmentId || activity.identity.spaceId !== identity.spaceId
      || activity.identity.principalId !== identity.principalId) throw new StorageError('forbidden');
    const eventId = z.uuid().parse(input.eventId);
    const eventSeq = z.number().int().nonnegative().parse(input.eventSeq);
    const contentVersion = z.number().int().positive().parse(input.contentVersion ?? 1);
    const createdAt = input.createdAt ? z.iso.datetime().parse(input.createdAt) : new Date().toISOString();
    const inputId = input.inputId ? z.uuid().parse(input.inputId) : null;
    const write = (tx: OwnedTransaction) => writeFacts(tx, { identity, activity, inputId, eventId, eventSeq,
      contentVersion, text: input.text, createdAt });
    if (transaction) return write(transaction);
    const saved = await storage.request({ requestId: 'student-facts-record:' + eventId,
      fingerprint: canonicalDigest({ owner: ownerKey(identity), activityId: activity.activityId, eventId,
        contentVersion, text: input.text }) }, write);
    return saved.result as StudentFact[];
  }

  async function read(identity: SpaceIdentity, activityId: string, input: unknown = {}): Promise<StudentFactsReadResult> {
    const who = spaceIdentitySchema.parse(identity);
    z.uuid().parse(activityId);
    const parsed = studentFactsReadInputSchema.parse(input);
    if (options.authorize) await options.authorize(who);
    const activity = await loadActivity(who, activityId);
    const courseId = activity.course?.courseId ?? null;
    const shared = parsed.scope !== 'current-activity';
    const continuationText = [activity.goal, activity.question, parsed.query ?? ''].join('\n');
    const personalContinuation = shared && !activity.course && CONTINUATION_TEXT.test(continuationText);
    const { rows } = await storage.read(`SELECT * FROM teaching_student_facts
      WHERE owner_key=$1 AND review_status<>'retracted'
        AND (activity_id=$2 OR ($3::boolean AND (scope->>'kind'='global'
          OR (scope->>'kind'='course' AND $4::text IS NOT NULL AND scope->>'courseId'=$4)))
          OR ($5::boolean AND scope->>'kind'='activity' AND activity_course_id IS NULL AND activity_id<>$2
            AND activity_goal<>'' AND (position(activity_goal in $6)>0 OR position($6 in activity_goal)>0)))
      ORDER BY created_at,fact_id`, [ownerKey(who), activityId, shared, courseId, personalContinuation, activity.goal.trim()]);
    const needle = parsed.query?.trim().toLowerCase() ?? '';
    const facts = rows.map(toFact).filter(fact => !needle || fact.topic.toLowerCase().includes(needle)
      || fact.statement.toLowerCase().includes(needle)).slice(0, 100);
    let continuation: StudentFactsReadResult['continuation'];
    if (!activity.course) {
      continuation = personalContinuation
        ? { state: 'same-activity', detail: '个人活动：文本明确继续同一目标或主题，沿用本空间个人活动中明确表达的偏好与全局偏好。' }
        : { state: 'ambiguous', detail: '个人活动没有课程归属；除明确“继续这个目标/同一主题”外，其他活动的偏好不作为本活动延续。' };
    } else if (parsed.scope === 'current-activity') {
      continuation = { state: 'same-activity', detail: '只读取当前活动的明确偏好。' };
    } else {
      continuation = { state: 'same-course', detail: '读取当前活动、同课程其他活动的课程级偏好以及全局偏好。' };
    }
    const unknown = needle && !facts.length ? [`没有找到与「${parsed.query}」相关的明确偏好记录`] : [];
    return studentFactsReadResultSchema.parse({ facts, activity: { activityId: activity.activityId, goal: activity.goal,
      courseId }, continuation, unknown });
  }

  return { record, read, validate: () => validateTeachingStudentFacts(storage) };
}

/** Recovery validation never reinterprets text; it only proves stored facts still cite real source events. */
export async function validateTeachingStudentFacts(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM teaching_student_facts ORDER BY created_at,fact_id');
  const byId = new Map(rows.map(row => [String(row.fact_id), row]));
  for (const row of rows) {
    const fact = toFact(row);
    if (fact.kind !== 'preference' || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i.test(String(row.owner_key)))
      throw new StorageError('corrupt');
    const { rows: [event] } = await storage.read('SELECT activity_id,seq,event_id FROM teaching_events WHERE event_id=$1',
      [fact.source.eventId]);
    if (!event || event.activity_id !== fact.source.activityId || Number(event.seq) !== fact.source.seq)
      throw new StorageError('corrupt');
    if (fact.source.inputId) {
      const { rows: [saved] } = await storage.read('SELECT activity_id FROM teaching_inputs WHERE input_id=$1',
        [fact.source.inputId]);
      if (!saved || saved.activity_id !== fact.source.activityId) throw new StorageError('corrupt');
    }
    if (fact.supersedes) {
      const older = byId.get(fact.supersedes);
      if (!older || older.owner_key !== row.owner_key || older.review_status !== 'retracted'
        || String(older.retracted_by) !== fact.factId || fact.reviewStatus === 'unreviewed') throw new StorageError('corrupt');
      const olderScope = studentFactScopeSchema.parse(older.scope);
      const related = older.activity_id === row.activity_id || olderScope.kind === 'global' || fact.scope.kind === 'global'
        || (olderScope.kind === 'course' && fact.scope.kind === 'course' && olderScope.courseId === fact.scope.courseId);
      if (!related) throw new StorageError('corrupt');
    }
    if (fact.retractedBy) {
      const newer = byId.get(fact.retractedBy);
      if (!newer || newer.supersedes !== fact.factId || fact.reviewStatus !== 'retracted')
        throw new StorageError('corrupt');
    }
    if (fact.reviewStatus === 'retracted' && !fact.retractedBy) throw new StorageError('corrupt');
  }
}
