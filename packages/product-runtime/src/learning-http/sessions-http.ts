import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { agentEventSchema, agentInputSchema, agentQuestionResponseSchema, type AgentEvent,
  type AgentToolResult, type AgentTurn } from '@xunjie/contracts/agent-runtime';
import { modelToolProgressSchema } from '@xunjie/contracts/model-connections';
import { agentSessionSchema, createAgentSessionSchema, updateAgentSessionSchema,
  type AgentSession, type CreateAgentSession, type UpdateAgentSession } from '@xunjie/contracts/agent-sessions';
import { agentInputControlSchema, agentSessionSnapshotSchema, type AgentSessionPort,
  type AgentSessionSnapshot, type BrowserAgentSessionCall } from '@xunjie/contracts/agent-service';
import { createAgentSessionService, createBrowserAgentSessionCall } from '@xunjie/agents/transport/session-service';
import { learningTargetSchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { SessionMaterials } from '@xunjie/agents/capabilities/documents/index';
import { personalMaterialSaveSchema, personalMaterialUpdateSchema, personalMaterialRemoveSchema, personalMaterialReadSchema } from '@xunjie/contracts/personal-materials';
import { pdfUploadSchema, pdfReadInputSchema, pdfFindInputSchema } from '@xunjie/contracts/pdf-materials';
import { sessionSkillSelectSchema, teachingSkillReferenceSchema, type SessionSkillsPort } from '@xunjie/contracts/agent-skills';

export interface SessionHttpPort {
  sessions: {
    list(identity: SpaceIdentity): Promise<AgentSession[]>;
    create(identity: SpaceIdentity, input: CreateAgentSession): Promise<AgentSession>;
    read(identity: SpaceIdentity, sessionId: string): Promise<AgentSession>;
    update(identity: SpaceIdentity, input: UpdateAgentSession): Promise<AgentSession>;
    workspace(identity: SpaceIdentity, activityId: string, target: LearningTarget): Promise<AgentSession>;
  };
  /** The host authorizes and selects the saved service, not a browser-selected owner. */
  agent(identity: SpaceIdentity, sessionId: string): Promise<AgentSessionPort>;
  materials?(identity: SpaceIdentity, sessionId: string): Promise<SessionMaterials>;
  skillDescription?(identity: SpaceIdentity, sessionId: string, reference: { skillId: string; version: number }): Promise<string>;
  skills?(identity: SpaceIdentity, sessionId: string): Promise<SessionSkillsPort>;
}
/** Separate host-only read port; it is never part of the student agent-sessions route. */
export interface SessionInspectionPort {
  inspect(identity: SpaceIdentity, sessionId: string, target: { attemptId?: string; turnId?: string; stepId?: string }): Promise<unknown>;
}
const control = z.object({ requestId: z.uuid() }).strict();
const workspace = z.object({ activityId: z.uuid(), target: learningTargetSchema }).strict();
const record = z.record(z.string(), z.unknown());

function browserToolResult(result: AgentToolResult | null): AgentToolResult | null {
  if (!result) return null;
  if (result.kind === 'completed') return { kind: 'completed', outcome: result.outcome,
    summary: result.outcome === 'success' ? '已完成' : '未能完成' };
  if (result.kind === 'accepted') return { kind: 'accepted', taskId: result.taskId, summary: '已受理' };
  return { kind: result.kind, reason: '' };
}

/** Browser recovery sees progress and identity, never kernel assembly, source tracing or metering. */
function browserSessionSnapshot(value: unknown): AgentSessionSnapshot {
  const snapshot = agentSessionSnapshotSchema.parse(value);
  return agentSessionSnapshotSchema.parse({ ...snapshot, automaticWakeBlocked: null,
    turns: snapshot.turns.map(browserTurn),
    steps: snapshot.steps.map(step => ({ ...step, snapshot: {} })),
    attempts: snapshot.attempts.map(attempt => ({ ...attempt, requestRef: null, responseRef: null,
      usage: { state: 'unknown' as const }, reserved: { inputTokens: 0, outputTokens: 0 }, error: null })),
    toolCalls: snapshot.toolCalls.map(call => ({ ...call, nativeCallId: 'browser-hidden',
      input: {}, result: browserToolResult(call.result) })),
    notifications: snapshot.notifications.map(notification => ({ ...notification, summary: '', resultRef: null })) });
}
function browserTurn(turn: AgentTurn): AgentTurn {
  return { ...turn, ownerInstanceId: 'browser-hidden', reason: browserTurnReason(turn.reason) };
}
/** Keep only the status categories the student UI already renders. */
function browserTurnReason(reason: string) {
  return ['budget-exhausted', 'budget_exhausted', 'input-budget-exhausted', 'output-budget-exhausted',
    'context-capacity-exceeded', 'context-capacity-preflight', 'deadline-exceeded', 'cancelled'].includes(reason)
    ? reason : '';
}

/** Only events consumed by the formal UI projection survive. A cursor keeps pagination moving. */
function browserEvents(value: unknown): AgentEvent[] {
  const events = z.array(agentEventSchema).parse(value), projected: AgentEvent[] = [];
  for (const event of events) {
    if (event.kind === 'tool-prepared') {
      const body = z.object({ turnId: z.uuid(), stepId: z.uuid(), toolCallId: z.uuid(), callId: z.string() })
        .safeParse(event.body);
      if (body.success) projected.push({ ...event, body: body.data });
    } else if (event.kind === 'model-progress') {
      const body = z.object({ turnId: z.uuid(), stepId: z.uuid(), attemptId: z.uuid(),
        revision: z.number().int().positive(), tools: z.array(modelToolProgressSchema).max(8).optional() })
        .safeParse(event.body);
      if (body.success) projected.push({ ...event, body: body.data });
    }
  }
  const last = events.at(-1);
  if (last && projected.at(-1)?.seq !== last.seq) projected.push({ ...last, kind: 'browser-cursor', body: {} });
  return projected;
}

/** Authentication and deployment routing remain with the HTTP host. */
export async function routeAgentSessions(host: SessionHttpPort, identity: SpaceIdentity, route: string,
  method: string, body?: unknown, search = '', contractVersion: unknown = undefined): Promise<unknown> {
  if (contractVersion !== '3') throw new StorageError('incompatible');
  const parts = route.split('/');
  if (parts[0] !== 'agent-sessions') throw new StorageError('missing');
  if (parts.length === 1) {
    if (method === 'GET') return { items: z.array(agentSessionSchema).parse(await host.sessions.list(identity)) };
    if (method === 'POST') return agentSessionSchema.parse(await host.sessions.create(identity, createAgentSessionSchema.parse(body)));
    throw new StorageError('missing');
  }
  if (parts.length === 2 && parts[1] === 'update' && method === 'POST')
    return agentSessionSchema.parse(await host.sessions.update(identity, updateAgentSessionSchema.parse(body)));
  if (parts.length === 2 && parts[1] === 'workspace' && method === 'POST') {
    const input = workspace.parse(body);
    return agentSessionSchema.parse(await host.sessions.workspace(identity, input.activityId, input.target));
  }
  const sessionId = z.uuid().parse(parts[1]);
  if (parts.length === 2 && method === 'GET') return agentSessionSchema.parse(await host.sessions.read(identity, sessionId));
  if (parts[2] === 'skills') {
    if (!host.skills) throw new StorageError('unavailable');
    const session = await host.sessions.read(identity, sessionId);
    if (session.deleted) throw new StorageError('missing');
    if (session.archived && method !== 'GET') throw new StorageError('conflict');
    const skills = await host.skills(identity, sessionId);
    if (parts.length === 4 && parts[3] === 'description' && method === 'POST' && host.skillDescription)
      return { text: await host.skillDescription(identity, sessionId, teachingSkillReferenceSchema.parse(body)) };
    if (parts.length === 3 && method === 'GET') return skills.resolveSession(identity, sessionId);
    if (parts.length === 4 && parts[3] === 'select' && method === 'POST')
      return skills.selectSession(identity, sessionId, sessionSkillSelectSchema.parse(body));
    throw new StorageError('missing');
  }
  if (parts[2] === 'materials' || parts[2] === 'pdf') {
    if (!host.materials) throw new StorageError('unavailable');
    const session = await host.sessions.read(identity, sessionId);
    if (session.deleted || session.scenario !== 'student-assistant') throw new StorageError('missing');
    if (method !== 'GET' && session.archived) throw new StorageError('conflict');
    return routeSessionMaterials(await host.materials(identity, sessionId), identity, sessionId, parts.slice(2), method, body);
  }
  let call: BrowserAgentSessionCall | undefined;
  const make = createBrowserAgentSessionCall;
  if (parts.length === 3 && method === 'GET') {
    const after = z.coerce.number().int().nonnegative().parse(new URLSearchParams(search).get('after') ?? 0);
    if (parts[2] === 'conversation') call = make(identity, sessionId, 'conversation', { after });
    else if (parts[2] === 'events') call = make(identity, sessionId, 'events', { after });
  } else if (parts.length === 3 && parts[2] === 'inputs' && method === 'POST') {
    call = make(identity, sessionId, 'submit', { input: agentInputSchema.parse(body) });
  } else if (parts.length === 4 && method === 'GET') {
    const id = z.uuid().parse(parts[3]);
    if (parts[2] === 'runs') call = make(identity, sessionId, 'turn', { turnId: id });
    else if (parts[2] === 'snapshots') call = make(identity, sessionId, 'sessionSnapshot', {});
    else if (parts[2] === 'requests') call = make(identity, sessionId, 'request', { requestId: id });
  } else if (parts.length === 5 && method === 'POST') {
    const id = z.uuid().parse(parts[3]);
    if (parts[2] === 'runs' && ['stop', 'continue'].includes(parts[4]!)) {
      const input = control.parse(body);
      call = parts[4] === 'stop' ? make(identity, sessionId, 'stop', { turnId: id, requestId: input.requestId })
        : make(identity, sessionId, 'continueSession', { requestId: input.requestId });
    } else if (parts[2] === 'waits' && parts[4] === 'responses') {
      const input = record.parse(body);
      const questionId = z.uuid().parse(input.questionId ?? input.waitId ?? id);
      call = make(identity, sessionId, 'answerQuestion', { response: agentQuestionResponseSchema.parse({ ...input, questionId }) });
    } else if (parts[2] === 'inputs' && parts[4] === 'control') {
      call = make(identity, sessionId, 'inputControl', { inputId: id, control: agentInputControlSchema.parse(body) });
    }
  }
  if (!call) throw new StorageError('missing');
  const agent = await host.agent(identity, sessionId);
  const service = createAgentSessionService(agent, { audience: 'browser', async authorize(_identity, _sessionId, operation) {
    const current = await host.sessions.read(identity, sessionId);
    if (current.deleted) throw new StorageError('missing');
    if (current.archived && ['submit', 'answerQuestion', 'continueSession', 'inputControl'].includes(operation)) throw new StorageError('conflict');
  } });
  const result = await service(call);
  if (parts[2] === 'snapshots') return browserSessionSnapshot(result);
  if (parts[2] === 'events') return browserEvents(result);
  if (call.operation === 'turn' || call.operation === 'stop' || call.operation === 'continueSession')
    return browserTurn(result as AgentTurn);
  return result;
}

/** Authenticated host-only technical inspection. The student agent-sessions routes never call this. */
export async function routeAgentInspection(host: SessionInspectionPort, identity: SpaceIdentity, route: string,
  method: string, search = '', contractVersion: unknown = undefined): Promise<unknown> {
  if (contractVersion !== '3') throw new StorageError('incompatible');
  if (method !== 'GET') throw new StorageError('missing');
  const match = /^agent-inspections\/([0-9a-f-]{36})$/.exec(route);
  if (!match) throw new StorageError('missing');
  const query = new URLSearchParams(search), target: { attemptId?: string; turnId?: string; stepId?: string } = {};
  for (const key of ['attemptId', 'turnId', 'stepId'] as const) {
    const value = query.get(key);
    if (value !== null) target[key] = z.uuid().parse(value);
  }
  return host.inspect(identity, match[1]!, target);
}

/** Scope is fixed by the authenticated directory; request bodies cannot choose another owner. */
async function routeSessionMaterials(owner: SessionMaterials, identity: SpaceIdentity, sessionId: string,
  parts: string[], method: string, body: unknown) {
  const scope = { kind: 'session' as const, sessionId };
  if (parts[0] === 'materials') {
    if (parts.length === 1 && method === 'GET') return owner.personal.list(identity, scope);
    if (parts.length === 1 && method === 'POST') return owner.personal.receive(identity, scope, personalMaterialSaveSchema.parse(body));
    if (parts.length === 3 && parts[1] === 'requests' && method === 'GET') return owner.personal.receipt(identity, scope, z.uuid().parse(parts[2]));
    const id = z.uuid().parse(parts[1]);
    if (parts.length === 2 && method === 'POST') return owner.personal.update(identity, scope, id, personalMaterialUpdateSchema.parse(body));
    if (parts.length === 3 && parts[2] === 'remove' && method === 'POST') return owner.personal.remove(identity, scope, id, personalMaterialRemoveSchema.parse(body));
    if (parts.length === 4 && parts[2] === 'versions' && method === 'GET')
      return owner.personal.versionContent(identity, scope, id, z.coerce.number().int().positive().parse(parts[3]));
    if (parts.length === 5 && parts[2] === 'versions' && parts[4] === 'read' && method === 'POST')
      return owner.personal.readRange(identity, scope, id, z.coerce.number().int().positive().parse(parts[3]), personalMaterialReadSchema.parse(body));
  } else {
    if (parts.length === 1 && method === 'GET') return owner.pdf.list(identity, scope);
    if (parts.length === 1 && method === 'POST') return owner.pdf.upload(identity, scope, pdfUploadSchema.parse(body));
    if (parts.length === 2 && method === 'POST') {
      if (parts[1] === 'read') return owner.pdf.read(identity, scope, pdfReadInputSchema.parse(body));
      if (parts[1] === 'find') return owner.pdf.find(identity, scope, pdfFindInputSchema.parse(body));
    }
    if (parts.length === 3 && method === 'GET') {
      const id = z.uuid().parse(parts[2]);
      if (parts[1] === 'reads') return owner.pdf.reading(identity, scope, id);
      if (parts[1] === 'documents') return owner.pdf.document(identity, scope, id);
      if (parts[1] === 'originals') {
        const original = await owner.pdf.original(identity, scope, id);
        return { document: original.document, dataBase64: Buffer.from(original.bytes).toString('base64') };
      }
    }
  }
  throw new StorageError('missing');
}
