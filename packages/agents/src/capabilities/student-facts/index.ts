import { StorageError } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { activitySchema, type LearningActivity } from '@xunjie/contracts/learning-data';
import { learningTargetSchema, spaceIdentitySchema, type SpaceIdentity, type LearningTarget } from '@xunjie/contracts/spaces';
import { agentSessionSchema, type AgentSession } from '@xunjie/contracts/agent-sessions';
import { agentEventSchema, type AgentEvent } from '@xunjie/contracts/agent-runtime';
import { agentSessionSnapshotSchema, agentSnapshotSchema, agentConversationSchema, sameAgentSubject, type AgentSessionSnapshot, type AgentSessionPort } from '@xunjie/contracts/agent-service';
import { studentFactSchema, studentFactsReadInputSchema, studentFactsReadResultSchema,
  type StudentFact, type StudentFactsPort, type StudentFactsReadResult } from '@xunjie/contracts/student-facts';
import { extractStudentFacts, scopeOf, topicSimilarity, CONTINUATION_TEXT } from './extraction.ts';
export { extractStudentFacts } from './extraction.ts';
export type { StudentFactsPort } from '@xunjie/contracts/student-facts';

/** Generic core read ports. Neither a database nor a legacy teaching service is accepted. */
export type StudentFactsCorePort = {
  events(identity: SpaceIdentity, sessionId: string, after?: number): Promise<AgentEvent[]>;
} & ({ sessionSnapshot(identity: SpaceIdentity, sessionId: string): Promise<AgentSessionSnapshot> } | Pick<AgentSessionPort, 'snapshot' | 'conversation'>);
export interface StudentFactsSource {
  sourceId: string;
  identity: SpaceIdentity;
  target: LearningTarget;
  learning: { list(identity: SpaceIdentity): Promise<LearningActivity[]>; open(identity: SpaceIdentity, activityId: string): Promise<LearningActivity> };
  sessions: { list(identity: SpaceIdentity): Promise<AgentSession[]>; read(identity: SpaceIdentity, sessionId: string): Promise<AgentSession> };
  /** Resolve the session's fixed, freshly authorized original Agent owner, including remote owners. */
  core(session: AgentSession): Promise<StudentFactsCorePort>;
}
export interface StudentFactsOptions {
  /** The calling workspace's real source owner, never an activity chosen by tool arguments. */
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  sources(identity: SpaceIdentity): Promise<readonly StudentFactsSource[]>;
}
interface SourcedFact { fact: StudentFact; activity: LearningActivity; correction: boolean; }
const equal = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
function activityOf(value: unknown, identity: SpaceIdentity, activityId?: string, target?: LearningTarget) {
  const activity = activitySchema.parse(value);
  if (!sameAgentSubject(activity.identity, identity) || activityId && activity.activityId !== activityId
    || target && !equal(activity.target, target)) throw new StorageError('forbidden');
  return activity;
}
function sessionOf(value: unknown, identity: SpaceIdentity, activity: LearningActivity) {
  const session = agentSessionSchema.parse(value);
  if (!sameAgentSubject(session.identity, identity) || session.scenario !== 'workspace-assistant'
    || session.workspace?.activityId !== activity.activityId || !equal(session.workspace.target, activity.target)) throw new StorageError('forbidden');
  return session;
}
async function readEvents(core: StudentFactsCorePort, identity: SpaceIdentity, sessionId: string) {
  const events: AgentEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await core.events(identity, sessionId, cursor);
    if (!page.length) return events;
    for (const value of page) {
      const event = agentEventSchema.parse(value);
      if (event.sessionId !== sessionId || event.seq <= cursor) throw new StorageError('corrupt');
      cursor = event.seq; events.push(event);
    }
  }
}
async function inputView(core: StudentFactsCorePort, identity: SpaceIdentity, sessionId: string) {
  const check = (session: AgentSessionSnapshot['session']) => {
    if (session.sessionId !== sessionId || session.scenario !== 'workspace-assistant' || !sameAgentSubject(session.identity, identity))
      throw new StorageError('forbidden');
  };
  if ('sessionSnapshot' in core) {
    const snapshot = agentSessionSnapshotSchema.parse(await core.sessionSnapshot(identity, sessionId)); check(snapshot.session);
    return { session: snapshot.session, inputs: snapshot.inputs.filter(input => input.state !== 'removed')
      .map(({ inputId, runId, version, input }) => ({ inputId, runId, version, input })) };
  }
  let session: AgentSessionSnapshot['session'] | undefined;
  const inputs: Pick<AgentSessionSnapshot['inputs'][number], 'inputId' | 'runId' | 'version' | 'input'>[] = [];
  const conversation = agentConversationSchema.parse(await core.conversation(identity, sessionId));
  if (conversation.sessionId !== sessionId) throw new StorageError('forbidden');
  for (const { runId } of conversation.runs) {
    const snapshot = agentSnapshotSchema.parse(await core.snapshot(identity, sessionId, runId)); check(snapshot.session);
    if (snapshot.run.runId !== runId || session && !equal(snapshot.session, session)) throw new StorageError('corrupt');
    session = snapshot.session;
    inputs.push(...snapshot.inputs.map(({ inputId, version, input }) => ({ inputId, runId, version, input })));
  }
  const expected = conversation.inputs.filter(input => input.state !== 'removed');
  if (expected.length !== inputs.length || inputs.some(input => !expected.some(current => current.inputId === input.inputId
    && current.runId === input.runId && current.version === input.version && current.mode === input.input.mode && current.text === input.input.text)))
    throw new StorageError('conflict');
  inputs.sort((a, b) => a.inputId.localeCompare(b.inputId));
  return { session: session ?? null, inputs };
}
async function sourceFacts(source: StudentFactsSource, identity: SpaceIdentity): Promise<SourcedFact[]> {
  const target = learningTargetSchema.parse(source.target);
  const activities = new Map((await source.learning.list(identity)).map(value => {
    const activity = activityOf(value, identity, undefined, target); return [activity.activityId, activity] as const;
  }));
  const facts: SourcedFact[] = [];
  for (const listed of await source.sessions.list(identity)) {
    if (listed.scenario !== 'workspace-assistant' || !listed.workspace || listed.deleted || listed.state !== 'ready') continue;
    const found = activities.get(listed.workspace.activityId);
    if (!found || found.purpose === 'preview') continue;
    const activity = activityOf(await source.learning.open(identity, found.activityId), identity, found.activityId, target);
    const session = sessionOf(await source.sessions.read(identity, listed.sessionId), identity, activity);
    if (!equal(session, listed) || session.deleted || session.state !== 'ready') throw new StorageError('conflict');
    const core = await source.core(session);
    const before = await inputView(core, identity, session.sessionId);
    const events = await readEvents(core, identity, session.sessionId);
    const after = await inputView(core, identity, session.sessionId);
    if (!equal(before, after)) throw new StorageError('conflict');
    const owner = learningTargetSchema.parse({ version: 1,
      environmentId: session.owner.target.environmentId, serviceId: session.owner.target.serviceId });
    for (const input of before.inputs) {
      const original = events.find(event => event.kind === 'input-received' && event.body.inputId === input.inputId);
      if (!original || original.body.input === null || typeof original.body.input !== 'object'
        || Array.isArray(original.body.input) || original.body.input.requestId !== input.input.requestId) throw new StorageError('corrupt');
      const event = input.version === 1 ? original : events.find(event => ['input-edited', 'input-moved'].includes(event.kind)
        && event.body.inputId === input.inputId && event.body.version === input.version);
      if (!event || event.body.runId !== input.runId || input.version === 1 && !equal(original.body.input, input.input)) throw new StorageError('corrupt');
      const topics = new Set<string>();
      for (const candidate of extractStudentFacts(input.input.text)) {
        if (topics.has(candidate.topic)) continue;
        topics.add(candidate.topic);
        const fact = studentFactSchema.parse({ factId: operationId(`student-fact:${owner.environmentId}:${owner.serviceId}:${session.sessionId}:${event.eventId}:${candidate.topic}`),
          kind: 'preference', topic: candidate.topic, statement: candidate.statement,
          source: { activityId: activity.activityId, eventId: event.eventId, seq: event.seq, inputId: input.inputId, createdAt: event.createdAt,
            sessionId: session.sessionId, runId: input.runId, owner, learningTarget: activity.target, inputDigest: canonicalDigest(input.input) },
          contentVersion: input.version, scope: scopeOf(candidate.statement, activity), reviewStatus: 'unreviewed', supersedes: null, retractedBy: null });
        facts.push({ fact, activity, correction: candidate.correction });
      }
    }
    if (!equal(activityOf(await source.learning.open(identity, activity.activityId), identity, activity.activityId, target), activity)
      || !equal(await source.sessions.read(identity, session.sessionId), session)) throw new StorageError('conflict');
  }
  return facts;
}

/** A deterministic projection of real owner facts. Reading does not infer ability or confirm a preference. */
export function createStudentFacts(options: StudentFactsOptions): StudentFactsPort {
  return { async read(value, activityId, input = {}) {
    const identity = spaceIdentitySchema.parse(value), query = studentFactsReadInputSchema.parse(input);
    const activity = activityOf(await options.activity(identity, activityId), identity, activityId);
    const sourced: SourcedFact[] = [], ids = new Set<string>();
    for (const source of await options.sources(identity)) {
      if (!sameAgentSubject(spaceIdentitySchema.parse(source.identity), identity)) continue;
      if (!source.sourceId || ids.has(source.sourceId)) throw new StorageError('identity-conflict');
      ids.add(source.sourceId); sourced.push(...await sourceFacts(source, identity));
    }
    sourced.sort((a, b) => a.fact.source.createdAt.localeCompare(b.fact.source.createdAt) ||
      (a.fact.source.sessionId === b.fact.source.sessionId ? a.fact.source.seq - b.fact.source.seq : a.fact.factId.localeCompare(b.fact.factId)));
    const unique = new Map<string, SourcedFact>();
    for (const item of sourced) {
      const prior = unique.get(item.fact.factId);
      if (prior && !equal(prior, item)) throw new StorageError('identity-conflict');
      unique.set(item.fact.factId, item);
    }
    const history: SourcedFact[] = [];
    for (const item of unique.values()) {
      if (item.correction) {
        const sameActivity = (other: SourcedFact) => other.activity.activityId === item.activity.activityId && equal(other.activity.target, item.activity.target);
        const eligible = history.filter(other => other.fact.reviewStatus !== 'retracted'
          && !(other.fact.source.sessionId === item.fact.source.sessionId && other.fact.source.eventId === item.fact.source.eventId)
          && (sameActivity(other) || other.fact.scope.kind === 'global' || other.fact.scope.kind === 'course'
            && other.fact.scope.courseId === item.activity.course?.courseId))
          .sort((a, b) => Number(sameActivity(b)) - Number(sameActivity(a))
            || b.fact.source.createdAt.localeCompare(a.fact.source.createdAt) || a.fact.factId.localeCompare(b.fact.factId));
        let target: SourcedFact | undefined, score = 0;
        for (const candidate of eligible) {
          const similarity = topicSimilarity(item.fact, candidate.fact);
          if (similarity > score) { target = candidate; score = similarity; }
        }
        if (target && score >= 0.6) {
          target.fact.reviewStatus = 'retracted'; target.fact.retractedBy = item.fact.factId;
          item.fact.supersedes = target.fact.factId; item.fact.reviewStatus = 'corrected';
        }
      }
      history.push(item);
    }
    const shared = query.scope !== 'current-activity', courseId = activity.course?.courseId ?? null;
    const personalContinuation = shared && !activity.course && CONTINUATION_TEXT.test([activity.goal, activity.question, query.query ?? ''].join('\n'));
    const needle = query.query?.trim().toLowerCase() ?? '';
    const facts = history.filter(item => {
      const { fact, activity: origin } = item;
      return fact.reviewStatus !== 'retracted' && (origin.activityId === activity.activityId && equal(origin.target, activity.target)
        || shared && (fact.scope.kind === 'global' || fact.scope.kind === 'course' && fact.scope.courseId === courseId)
        || personalContinuation && fact.scope.kind === 'activity' && !origin.course && origin.goal.trim()
          && (activity.goal.includes(origin.goal) || origin.goal.includes(activity.goal.trim())))
        && (!needle || fact.topic.toLowerCase().includes(needle) || fact.statement.toLowerCase().includes(needle));
    }).map(item => item.fact).slice(0, 100);
    let continuation: StudentFactsReadResult['continuation'];
    if (!activity.course) continuation = personalContinuation
      ? { state: 'same-activity', detail: '个人活动：文本明确继续同一目标或主题，沿用本空间个人活动中明确表达的偏好与全局偏好。' }
      : { state: 'ambiguous', detail: '个人活动没有课程归属；除明确“继续这个目标/同一主题”外，其他活动的偏好不作为本活动延续。' };
    else continuation = query.scope === 'current-activity' ? { state: 'same-activity', detail: '只读取当前活动的明确偏好。' }
      : { state: 'same-course', detail: '读取当前活动、同课程其他活动的课程级偏好以及全局偏好。' };
    if (!equal(activityOf(await options.activity(identity, activityId), identity, activityId), activity)) throw new StorageError('conflict');
    return studentFactsReadResultSchema.parse({ facts, activity: { activityId, goal: activity.goal, courseId }, continuation,
      unknown: needle && !facts.length ? [`没有找到与「${query.query}」相关的明确偏好记录`] : [] });
  } };
}
