import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { AgentSessionReadPort } from '@xunjie/agent-runtime';
import type { AgentRuntimePort } from '@xunjie/contracts/agent-runtime';
import { agentConversationSchema, type AgentConversation } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';

type Message = AgentConversation['messages'][number];
type Tool = AgentConversation['tools'][number];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = z.uuid();

/** Product-sized facts. Native requests and complete tool originals stay behind snapshot/event reads. */
export function createAgentConversationProjection(runtime: AgentSessionReadPort & Pick<AgentRuntimePort, 'events'>) {
  return {
    async conversation(identity: SpaceIdentity, sessionId: string, after = 0): Promise<AgentConversation> {
      // Read events first: a newly accepted run cannot appear here before it exists in the state view.
      const events = await runtime.events(identity, sessionId, after);
      const snapshot = await runtime.sessionSnapshot(identity, sessionId);
      const runs = new Map(snapshot.runs.map(run => [run.runId, run]));
      const messages = new Map<string, Message>();
      const tools = new Map<string, Tool>();
      const workspaces = new Map<string, AgentConversation['workspaces'][number]>();
      for (const input of snapshot.inputs) {
        if (input.state === 'removed') continue;
        const messageId = 'input:' + input.inputId;
        messages.set(messageId, { messageId, inputId: input.inputId, runId: input.runId,
          role: 'user', text: input.input.text, createdAt: input.createdAt, state: 'settled' });
      }
      for (const event of events) {
        const body = event.body;
        if (!['assistant', 'model-progress', 'tool-prepared', 'tool-result'].includes(event.kind)) continue;
        const runId = uuid.parse(body.runId), run = runs.get(runId);
        if (!run) throw new StorageError('corrupt');
        if (event.kind === 'assistant' || event.kind === 'model-progress') {
          if (typeof body.text !== 'string' || !body.text) continue;
          const operationId = uuid.parse(body.attemptId ?? body.operationId);
          const messageId = 'assistant:' + operationId;
          const prior = messages.get(messageId);
          const state = run.state === 'stopped' ? 'stopped' : run.state === 'failed' ? 'failed'
            : event.kind === 'model-progress' && !['completed', 'paused'].includes(run.state) ? 'streaming' : 'settled';
          messages.set(messageId, { messageId, runId, role: 'assistant', text: body.text,
            createdAt: prior?.createdAt ?? event.createdAt, state });
          continue;
        }
        const operationId = uuid.parse(body.commandId), prior = tools.get(operationId);
        if (event.kind === 'tool-prepared') {
          tools.set(operationId, { operationId, runId, name: String(body.name), state: run.state === 'stopped' ? 'stopped' : 'prepared' });
          continue;
        }
        const outcome = record(body.outcome), feedback = record(outcome.feedback), result = record(outcome.result);
        tools.set(operationId, { operationId, runId, name: typeof body.name === 'string' ? body.name : prior?.name ?? '工具调用',
          state: outcome.state as Tool['state'], feedback: feedback as Tool['feedback'] });
        const workspace = record(result.workspace);
        if (outcome.state === 'completed' && Object.keys(workspace).length) workspaces.set(operationId, {
          operationId, runId, workspace: z.record(z.string(), z.json()).parse(workspace),
        });
      }
      return agentConversationSchema.parse({ sessionId, lastSeq: events.at(-1)?.seq ?? after,
        messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)),
        runs: snapshot.runs, inputs: snapshot.inputs.map(input => ({ inputId: input.inputId, runId: input.runId,
          version: input.version, mode: input.mode, state: input.state, text: input.input.text, createdAt: input.createdAt })),
        waits: snapshot.waits, tools: [...tools.values()], workspaces: [...workspaces.values()] });
    },
  };
}
