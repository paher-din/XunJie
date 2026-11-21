import { z } from 'zod';
import { teachingSkillLoadedSchema } from '@xunjie/contracts/agent-skills';
import { agentConversationSchema, type AgentConversation, type AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { modelMessageImagesSchema, type ModelMessageImage } from '@xunjie/contracts/model-connections';
import { questionReferenceSourceSchema } from '@xunjie/contracts/question-drafts';
import { importedAgentConversation } from './legacy-agent-history.js';

type Message = AgentConversation['messages'][number];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = z.uuid();

function inputImages(context: Record<string, unknown>): ModelMessageImage[] {
  const references = record(record(context.action).draft).references;
  if (!Array.isArray(references)) return modelMessageImagesSchema.safeParse(context.messageImages).data ?? [];
  const images = references.flatMap(reference => {
    const source = record(record(reference).source);
    if (source.kind !== 'image') return [];
    const parsed = questionReferenceSourceSchema.safeParse(source);
    return parsed.data?.kind === 'image' ? [parsed.data.image] : [];
  });
  return modelMessageImagesSchema.safeParse(images).data ?? [];
}

/** Product projection over kernel facts: inputs, turns, tool calls and streamed assistant text. */
export function createAgentConversationProjection(runtime: Pick<AgentSessionPort, 'events' | 'sessionSnapshot'>) {
  return {
    async conversation(identity: SpaceIdentity, sessionId: string, after = 0): Promise<AgentConversation> {
      const events = await runtime.events(identity, sessionId, after);
      while (events.length && events.length % 1000 === 0) {
        const page = await runtime.events(identity, sessionId, events.at(-1)!.seq);
        if (!page.length) break;
        events.push(...page);
        if (page.length < 1000) break;
      }
      if (after && events.some(event => event.kind === 'input-edited' && Array.isArray(event.body.retiredTurnIds)))
        return this.conversation(identity, sessionId);
      const snapshot = await runtime.sessionSnapshot(identity, sessionId);
      const turns = new Map(snapshot.turns.map(turn => [turn.turnId, turn]));
      const steps = new Map(snapshot.steps.map(step => [step.stepId, step]));
      const messages = new Map<string, Message>();
      const thinking = new Map<string, NonNullable<AgentConversation['thinking']>[number]>();
      const archiveEvent = events.find(event => event.kind === 'history-imported');
      const archive = archiveEvent ? importedAgentConversation(sessionId, archiveEvent.body) : undefined;
      for (const message of archive?.messages ?? []) messages.set(message.messageId, message);
      for (const item of archive?.thinking ?? []) thinking.set(item.messageId, item);
      const received = new Map(events.filter(event => event.kind === 'input-received').map(event => [String(event.body.inputId), event.seq]));
      const retired = new Map(events.filter(event => event.kind === 'input-edited' && Array.isArray(event.body.retiredTurnIds))
        .flatMap(event => (event.body.retiredTurnIds as string[]).map(turnId => [turnId, received.get(String(event.body.inputId)) ?? 0] as const)));
      const edited = new Map(events.filter(event => event.kind === 'input-edited').map(event => [String(event.body.inputId), event.createdAt]));
      const retiredAfter = new Map(events.filter(event => event.kind === 'input-edited' && Array.isArray(event.body.retiredTurnIds))
        .flatMap(event => (event.body.retiredTurnIds as string[]).map(turnId => [turnId, snapshot.inputs.find(input => input.inputId === event.body.inputId)?.createdAt ?? event.createdAt] as const)));
      const inputAt = (turnId: string, at: string) => snapshot.inputs.filter(input => input.turnId === turnId && input.createdAt <= at).at(-1)?.inputId;
      let contextUsage: AgentConversation['contextUsage'] = archive?.contextUsage;
      const editableInput = snapshot.inputs.filter(input => input.state !== 'removed' && !('questionId' in input.input.context)).at(-1)?.inputId;
      for (const input of snapshot.inputs) {
        if (input.state === 'removed') continue;
        // Answers are already represented by their bound Question record. Showing the synthetic
        // answer input as a chat bubble duplicates the question interaction and cannot be edited.
        if (typeof input.input.context.questionId === 'string') continue;
        const messageId = 'input:' + input.inputId;
        messages.set(messageId, { messageId, turnId: input.turnId, inputId: input.inputId, role: 'user',
          text: input.input.text, createdAt: input.createdAt, state: 'settled', ...(edited.has(input.inputId) ? { editedAt: edited.get(input.inputId) } : {}) });
      }
      for (const event of events) {
        if (!['assistant', 'model-progress'].includes(event.kind)) continue;
        const body = event.body;
        const measured = agentConversationSchema.shape.contextUsage.safeParse(body.contextUsage);
        if (measured.success && measured.data) contextUsage = measured.data;
        const eventTurnId = String(body.turnId);
        if (retired.has(eventTurnId) && event.seq >= retired.get(eventTurnId)!) continue;
        const operation = String(body.attemptId);
        const priorThinking = thinking.get(operation);
        const step = steps.get(String(body.stepId));
        const inputId = inputAt(eventTurnId, step?.createdAt ?? event.createdAt);
        const thinkingStepId = step?.stepId ?? priorThinking?.stepId;
        const thinkingStepNo = step?.stepNo ?? priorThinking?.stepNo;
        if (typeof body.thinking === 'string' && body.thinking || priorThinking) thinking.set(operation, {
          messageId: 'thinking:' + operation, turnId: eventTurnId, ...(inputId ? { inputId } : {}),
          ...(thinkingStepId ? { stepId: thinkingStepId } : {}), ...(thinkingStepNo ? { stepNo: thinkingStepNo } : {}),
          text: typeof body.thinking === 'string' ? body.thinking : priorThinking!.text,
          createdAt: priorThinking?.createdAt ?? event.createdAt,
          active: event.kind === 'model-progress' && !body.text && turns.get(eventTurnId)?.state === 'active',
        });
        const usage = record(body.usage), model = record(body.model);
        if (typeof usage.inputTokens === 'number' && typeof model.connectionId === 'string' && typeof model.version === 'number')
          contextUsage = { model: { connectionId: model.connectionId, version: model.version }, tokens: usage.inputTokens, lowerBound: usage.state !== 'final' };
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
      const tools: AgentConversation['tools'] = [...archive?.tools ?? []];
      const workspaces: AgentConversation['workspaces'] = [...archive?.workspaces ?? []];
      for (const call of snapshot.toolCalls) {
        const step = steps.get(call.stepId);
        if (!step) continue;
        if (retiredAfter.has(step.turnId) && step.createdAt >= retiredAfter.get(step.turnId)!) continue;
        const inputId = inputAt(step.turnId, step.createdAt);
        const loaded = teachingSkillLoadedSchema.safeParse(record(record(call.result).data).loaded);
        tools.push({ toolCallId: call.toolCallId, turnId: step.turnId, stepId: call.stepId,
          name: call.name, state: call.state, result: call.result, stepNo: step.stepNo, createdAt: call.createdAt,
          ...(inputId ? { inputId } : {}), ...(loaded.success ? { skill: loaded.data } : {}) });
        const workspace = record(record(call.result).data).workspace;
        const fixed = record(workspace);
        if (Object.keys(fixed).length) workspaces.push({ toolCallId: call.toolCallId, turnId: step.turnId,
          workspace: z.record(z.string(), z.json()).parse(fixed) });
      }
      return agentConversationSchema.parse({ sessionId, lastSeq: events.at(-1)?.seq ?? after,
        messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)),
        turns: [...archive?.turns ?? [], ...snapshot.turns],
        inputs: [...archive?.inputs ?? [], ...snapshot.inputs.map(input => {
          const images = input.state === 'removed' ? [] : inputImages(input.input.context);
          return { inputId: input.inputId, turnId: input.turnId, version: input.version, state: input.state,
            text: input.input.text, createdAt: input.createdAt, canEdit: input.inputId === editableInput, ...(images.length ? { images } : {}) };
        })],
        questions: snapshot.questions.filter(question => !retired.has(question.turnId)), tools, workspaces,
        thinking: [...thinking.values()], ...(contextUsage ? { contextUsage } : {}), ...(after === 0 ? { reset: true } : {}) });
    },
  };
}
