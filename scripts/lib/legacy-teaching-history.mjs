import { agentConversationSchema } from '@xunjie/contracts/agent-service';
import { teachingSkillLoadedSchema } from '@xunjie/contracts/agent-skills';
import { operationId } from '@xunjie/storage/identity';

/** Convert the old, already filtered product read model, not provider payloads or executable effects. */
export function legacyTeachingConversation(sessionId, legacy) {
  const turns = legacy.runs.map(run => ({ turnId: run.runId, sessionId, requestId: run.requestId,
    trigger: 'user', originNotificationId: null, state: 'completed', reason: 'legacy-history-imported',
    ownerInstanceId: 'legacy-history-import', createdAt: run.createdAt, updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? run.updatedAt }));
  const fallback = turns[0]?.turnId ?? operationId('legacy-empty-turn:' + sessionId);
  const runFor = item => item.runId ?? item.adoptedRunId ?? item.receivedRunId ?? fallback;
  const messages = legacy.messages.filter(item => ['student', 'assistant'].includes(item.role)).map(item => ({
    messageId: 'legacy:' + item.eventId, turnId: runFor(item), ...(item.inputId ? { inputId: item.inputId } : {}),
    role: item.role === 'student' ? 'user' : 'assistant', text: item.text, createdAt: item.createdAt,
    ...(item.editedAt ? { editedAt: item.editedAt } : {}), state: item.state === 'streaming' ? 'stopped' : 'settled',
  }));
  // Old questions stay readable without reopening old waits, grants or tool execution.
  for (const question of legacy.questions ?? []) {
    messages.push({ messageId: 'legacy-question:' + question.questionId, turnId: question.runId,
      role: 'assistant', text: [question.question, ...(question.options ?? []).map(option =>
        typeof option === 'string' ? option : option.label ?? option.text ?? '')].filter(Boolean).join('\n'),
      createdAt: question.createdAt, state: 'settled' });
  }
  const inputs = (legacy.inputs ?? []).map(input => ({ inputId: input.inputId, turnId: runFor(input),
    version: input.version, state: 'adopted', text: input.input.draft.question, createdAt: input.createdAt, canEdit: false }));
  const inputAt = (runId, at) => inputs.filter(input => input.turnId === runId && input.createdAt <= at).at(-1)?.inputId;
  const thinking = legacy.messages.filter(item => item.kind === 'native-summary').map(item => ({
    messageId: 'legacy:' + item.eventId, turnId: runFor(item), ...(item.stepId ? { stepId: item.stepId } : {}),
    text: item.text, createdAt: item.createdAt, active: false,
    ...(inputAt(runFor(item), item.createdAt) ? { inputId: inputAt(runFor(item), item.createdAt) } : {}),
  }));
  const tools = (legacy.tools ?? []).map(tool => {
    const loaded = teachingSkillLoadedSchema.safeParse(tool.result?.data?.loaded ?? tool.result?.loaded);
    const inputId = inputAt(tool.runId, tool.createdAt);
    return { toolCallId: tool.commandId, turnId: tool.runId, stepId: tool.stepId, name: tool.name, state: 'closed',
      result: tool.result ?? null, createdAt: tool.createdAt, ...(inputId ? { inputId } : {}), ...(loaded.success ? { skill: loaded.data } : {}) };
  });
  return agentConversationSchema.parse({ sessionId, lastSeq: 0, messages: messages.sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId)), turns, inputs,
    questions: [], tools, workspaces: [], thinking, ...(legacy.contextUsage ? { contextUsage: legacy.contextUsage } : {}) });
}
