import { z } from 'zod';
import { agentConversationSchema, type AgentConversation, type AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';

type Message = AgentConversation['messages'][number];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = z.uuid();

/** Product projection over kernel facts: inputs, turns, tool calls and streamed assistant text. */
export function createAgentConversationProjection(runtime: Pick<AgentSessionPort, 'events' | 'sessionSnapshot'>) {
  return {
    async conversation(identity: SpaceIdentity, sessionId: string, after = 0): Promise<AgentConversation> {
      const events = await runtime.events(identity, sessionId, after);
      const snapshot = await runtime.sessionSnapshot(identity, sessionId);
      const turns = new Map(snapshot.turns.map(turn => [turn.turnId, turn]));
      const steps = new Map(snapshot.steps.map(step => [step.stepId, step]));
      const messages = new Map<string, Message>();
      for (const input of snapshot.inputs) {
        if (input.state === 'removed') continue;
        const messageId = 'input:' + input.inputId;
        messages.set(messageId, { messageId, turnId: input.turnId, inputId: input.inputId, role: 'user',
          text: input.input.text, createdAt: input.createdAt, state: 'settled' });
      }
      for (const event of events) {
        if (!['assistant', 'model-progress'].includes(event.kind)) continue;
        const body = event.body;
        if (typeof body.text !== 'string' || !body.text) continue;
        const turnId = uuid.parse(String(body.turnId));
        const attemptId = uuid.parse(String(body.attemptId));
        const turn = turns.get(turnId);
        const messageId = 'assistant:' + attemptId;
        const prior = messages.get(messageId);
        const state = turn?.state === 'stopped' ? 'stopped' : turn?.state === 'failed' ? 'failed'
          : event.kind === 'model-progress' && turn?.state === 'active' ? 'streaming' : 'settled';
        messages.set(messageId, { messageId, turnId, role: 'assistant', text: body.text,
          createdAt: prior?.createdAt ?? event.createdAt, state });
      }
      const tools: AgentConversation['tools'] = [];
      const workspaces: AgentConversation['workspaces'] = [];
      for (const call of snapshot.toolCalls) {
        const step = steps.get(call.stepId);
        if (!step) continue;
        tools.push({ toolCallId: call.toolCallId, turnId: step.turnId, stepId: call.stepId,
          name: call.name, state: call.state, result: call.result });
        const workspace = record(record(call.result).data).workspace;
        const fixed = record(workspace);
        if (Object.keys(fixed).length) workspaces.push({ toolCallId: call.toolCallId, turnId: step.turnId,
          workspace: z.record(z.string(), z.json()).parse(fixed) });
      }
      return agentConversationSchema.parse({ sessionId, lastSeq: events.at(-1)?.seq ?? after,
        messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)),
        turns: snapshot.turns,
        inputs: snapshot.inputs.map(input => ({ inputId: input.inputId, turnId: input.turnId, version: input.version,
          state: input.state, text: input.input.text, createdAt: input.createdAt })),
        questions: snapshot.questions, tools, workspaces });
    },
  };
}
