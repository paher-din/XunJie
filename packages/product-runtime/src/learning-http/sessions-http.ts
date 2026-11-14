import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { agentInputSchema, agentWaitResponseSchema } from '@xunjie/contracts/agent-runtime';
import { agentSessionSchema, createAgentSessionSchema, updateAgentSessionSchema,
  type AgentSession, type CreateAgentSession, type UpdateAgentSession } from '@xunjie/contracts/agent-sessions';
import { agentInputControlSchema, type AgentSessionPort, type BrowserAgentSessionCall } from '@xunjie/contracts/agent-service';
import { createAgentSessionService, createBrowserAgentSessionCall } from '@xunjie/agents/transport/session-service';
import { learningTargetSchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces';
import type { SessionMaterials } from '@xunjie/agents/capabilities/documents/index';
import { personalMaterialSaveSchema, personalMaterialUpdateSchema, personalMaterialRemoveSchema, personalMaterialReadSchema } from '@xunjie/contracts/personal-materials';
import { pdfUploadSchema, pdfReadInputSchema, pdfFindInputSchema } from '@xunjie/contracts/pdf-materials';
import { sessionSkillSelectSchema, type SessionSkillsPort } from '@xunjie/contracts/agent-skills';

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
  skills?(identity: SpaceIdentity, sessionId: string): Promise<SessionSkillsPort>;
}
const control = z.object({ requestId: z.uuid() }).strict();
const workspace = z.object({ activityId: z.uuid(), target: learningTargetSchema }).strict();
const record = z.record(z.string(), z.unknown());

/** Authentication and deployment routing remain with the HTTP host. */
export async function routeAgentSessions(host: SessionHttpPort, identity: SpaceIdentity, route: string,
  method: string, body?: unknown, search = '', contractVersion: unknown = undefined): Promise<unknown> {
  if (contractVersion !== '2') throw new StorageError('incompatible');
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
    call = make(identity, sessionId, 'accept', { input: agentInputSchema.parse(body) });
  } else if (parts.length === 4 && method === 'GET') {
    const id = z.uuid().parse(parts[3]);
    if (parts[2] === 'runs') call = make(identity, sessionId, 'run', { runId: id });
    else if (parts[2] === 'snapshots') call = make(identity, sessionId, 'snapshot', { runId: id });
    else if (parts[2] === 'requests') call = make(identity, sessionId, 'request', { requestId: id });
  } else if (parts.length === 5 && method === 'POST') {
    const id = z.uuid().parse(parts[3]);
    if (parts[2] === 'runs' && ['stop', 'continue'].includes(parts[4]!)) {
      const input = control.parse(body);
      call = make(identity, sessionId, parts[4] === 'stop' ? 'stop' : 'continueRun', { runId: id, requestId: input.requestId });
    } else if (parts[2] === 'waits' && parts[4] === 'responses') {
      const input = record.parse(body);
      if (input.waitId !== undefined && input.waitId !== id) throw new StorageError('forbidden');
      call = make(identity, sessionId, 'respond', { response: agentWaitResponseSchema.parse({ ...input, waitId: id }) });
    } else if (parts[2] === 'inputs' && parts[4] === 'control') {
      call = make(identity, sessionId, 'inputControl', { inputId: id, control: agentInputControlSchema.parse(body) });
    }
  }
  if (!call) throw new StorageError('missing');
  const agent = await host.agent(identity, sessionId);
  const service = createAgentSessionService(agent, { audience: 'browser', async authorize(_identity, _sessionId, operation) {
    const current = await host.sessions.read(identity, sessionId);
    if (current.deleted) throw new StorageError('missing');
    if (current.archived && ['accept', 'respond', 'continueRun', 'inputControl'].includes(operation)) throw new StorageError('conflict');
  } });
  return service(call);
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
