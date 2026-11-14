import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { createAgentRuntime, type AgentPipeline, type AgentExecutionSnapshot, type AgentStep } from '@xunjie/agent-runtime';
import { createDirectExecution } from '@xunjie/agents/execution/wire';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { AgentDispatchPermit } from '@xunjie/contracts/agent-runtime';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { createAgentSessionApplication, type AgentSessionApplicationHost, type AgentSessionDirectory } from './agent-sessions.js';
import { createAgentConversationProjection } from './agent-conversation.js';
import type { ObservedAgentWaits } from './workspace-agent-waits.js';

export interface SessionRuntimeHostOptions {
  storage: OwnedStorage;
  directory: AgentSessionDirectory;
  authorize(identity: SpaceIdentity): Promise<void>;
  /** The product supplies one of the two explicit scenario factories and real owner ports. */
  pipeline(session: AgentSession): Promise<AgentPipeline>;
  remote?(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  readOnly?: boolean;
  observeWaits?(value: ObservedAgentWaits): void;
  workspaceRequest?: AgentSessionApplicationHost['workspaceRequest'];
}

/** One kernel owns local sessions. The directory alone selects an original remote owner. */
export function createSessionRuntimeHost(options: SessionRuntimeHostOptions) {
  const pipelines = new Map<string, Promise<AgentPipeline>>();
  function local(session: AgentSession) {
    return session.owner.target.environmentId === options.storage.owner.environmentId
      && session.owner.target.serviceId === options.storage.owner.serviceId;
  }
  async function saved(identity: SpaceIdentity, sessionId: string, dispatch = false, retired = false) {
    const session = await options.directory.read(identity, sessionId);
    if (!local(session)) throw new StorageError('forbidden');
    if (session.deleted && !retired) throw new StorageError('missing');
    if (dispatch && session.archived) throw new StorageError('conflict');
    return session;
  }
  async function pipeline(snapshot: AgentExecutionSnapshot) {
    const session = await saved(snapshot.session.identity, snapshot.session.sessionId, false, true);
    if (session.scenario !== snapshot.session.scenario) throw new StorageError('identity-conflict');
    let value = pipelines.get(session.sessionId);
    if (!value) {
      value = options.pipeline(session);
      pipelines.set(session.sessionId, value);
      void value.catch(() => { if (pipelines.get(session.sessionId) === value) pipelines.delete(session.sessionId); });
    }
    return value;
  }
  const routed: AgentPipeline = {
    async plan(snapshot, ids) {
      try { await saved(snapshot.session.identity, snapshot.session.sessionId, true); }
      catch (error) { if (error instanceof StorageError) return { kind: 'pause', reason: error.code }; throw error; }
      return (await pipeline(snapshot)).plan(snapshot, ids);
    },
    async dispatch(snapshot, step, permit, assertDispatch) {
      const live = async () => { await assertDispatch(); await saved(snapshot.session.identity, permit.sessionId, true); await assertDispatch(); };
      await live();
      return (await pipeline(snapshot)).dispatch(snapshot, step, permit, live);
    },
    async reconcile(snapshot, step) { return (await pipeline(snapshot)).reconcile(snapshot, step); },
    async apply(snapshot, step, result) { return (await pipeline(snapshot)).apply(snapshot, step, result); },
    async validateResponse(snapshot, wait, answer) {
      await saved(snapshot.session.identity, snapshot.session.sessionId, true);
      const scene = await pipeline(snapshot);
      if (!scene.validateResponse) throw new StorageError('forbidden');
      await scene.validateResponse(snapshot, wait, answer);
    },
    async cancel(snapshot: AgentExecutionSnapshot, step: AgentStep) { await (await pipeline(snapshot)).cancel?.(snapshot, step); },
  };
  let execution: ReturnType<typeof createDirectExecution> | undefined;
  const runtime = createAgentRuntime(options.storage, { authorize: options.authorize, pipeline: routed, readOnly: options.readOnly,
    execution(advance) { execution = createDirectExecution(async runId => {
      const result = await advance(runId);
      if (result.waits) options.observeWaits?.(result.waits);
      return result;
    }); return execution; } });
  const projection = createAgentConversationProjection(runtime);
  const localPort: AgentSessionPort = { ...runtime, ...projection,
    async initialize(input) {
      const session = await saved(input.identity, input.sessionId, true);
      const expected = { sessionId: session.sessionId, identity: session.identity, scenario: session.scenario,
        restartPolicy: session.scenario === 'student-assistant' ? 'explicit' : 'automatic', createdAt: session.createdAt };
      if (canonicalDigest(input) !== canonicalDigest(expected)) throw new StorageError('identity-conflict');
      return runtime.initialize(input);
    },
    async accept(identity, input) { await saved(identity, input.sessionId, true); return runtime.accept(identity, input); },
    async continueRun(identity, sessionId, runId, requestId) {
      await saved(identity, sessionId, true); return runtime.continueRun(identity, sessionId, runId, requestId);
    },
    async respond(identity, sessionId, response) { await saved(identity, sessionId, true); return runtime.respond(identity, sessionId, response); },
    async inputControl(identity, sessionId, inputId, control) {
      await saved(identity, sessionId, true); return runtime.inputControl(identity, sessionId, inputId, control);
    },
    async assertDispatch(identity, permit) { await saved(identity, permit.sessionId, true); await runtime.assertDispatch(identity, permit); },
  };
  async function endpoint(session: AgentSession): Promise<AgentSessionPort> {
    if (local(session)) return localPort;
    if (!options.remote) throw new StorageError('unavailable');
    return options.remote(session);
  }
  const sessions = createAgentSessionApplication({ directory: options.directory, runtime: endpoint,
    workspaceRequest: options.workspaceRequest,
    async deleted(session) {
      if (local(session) && session.state === 'ready') {
        const state = await runtime.sessionSnapshot(session.identity, session.sessionId);
        for (const run of state.runs) if (!['completed', 'failed', 'stopped'].includes(run.state))
          await runtime.stop(session.identity, session.sessionId, run.runId, operationId(`delete-session:${session.sessionId}:${run.runId}`));
      }
      await options.deleted?.(session);
    } });
  let startupQueued = false;
  async function start() {
    if (startupQueued) return;
    const candidates = await runtime.recoverableRuns();
    if (!execution) return;
    startupQueued = true;
    for (const run of candidates) void execution.wake(run.runId).catch(() => {});
  }
  return { sessions, runtime, local: localPort,
    async agent(identity: SpaceIdentity, sessionId: string) {
      const session = await options.directory.read(identity, sessionId);
      if (session.deleted) throw new StorageError('missing');
      if (session.state !== 'ready') throw new StorageError('unavailable');
      return endpoint(session);
    },
    async assertDispatch(identity: SpaceIdentity, permit: AgentDispatchPermit) {
      await saved(identity, permit.sessionId, true); await runtime.assertDispatch(identity, permit);
    },
    start,
    closeWrites: () => runtime.closeWrites(), closeDispatch: () => runtime.closeDispatch(),
    async resume() { await runtime.resume(); await start(); },
    drain: () => runtime.drain(), close: () => runtime.close(),
  };
}
