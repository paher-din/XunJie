import { StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import { teachingStudentAskInputSchema, teachingStudentAnswerSchema } from '@xunjie/contracts/student-questions';
import type { AgentWait } from '@xunjie/contracts/agent-runtime';
import type { Facts } from '@xunjie/agent-runtime';
import type { ConversationPreparedTool, ConversationToolModule, ConversationToolOutcome } from '../../conversation/tools.js';

/** The optional capability supplies presentation and answer semantics; the kernel stores the wait. */
export function createUserQuestions(): ConversationToolModule {
  const definition = { name: 'student_ask', description: '向学生提出一个明确问题，保存等待，收到学生明确回应后继续。呈现或关闭页面不算回应。',
    inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 1000 },
      source: { type: 'string', minLength: 1, maxLength: 500 }, options: { type: 'array', maxItems: 8,
        items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } },
      allowText: { type: 'boolean' }, skippable: { type: 'boolean' } },
      required: ['question', 'source', 'options', 'allowText', 'skippable'], additionalProperties: false } };
  function outcome(command: ConversationPreparedTool): ConversationToolOutcome {
    const { sourceInputId, deadline, ...raw } = command.input;
    const question = teachingStudentAskInputSchema.parse(raw);
    const questionId = operationId('agent-user-question:' + command.commandId);
    return { state: 'accepted', feedback: { outcome: 'success', images: [], text: JSON.stringify({ questionId, answerState: 'pending' }) },
      result: { questionId, answerState: 'pending' }, wait: { kind: 'user', interruptible: true, deadline: String(deadline),
        presentation: { ...question, questionId, commandId: command.commandId, sourceInputId: String(sourceInputId) } } };
  }
  return { id: 'user-questions', version: 1,
    async list() { return [{ definition, effect: 'ask', scope: {} }]; },
    async prepare(context, _offer, intent, commandId) {
      const input = teachingStudentAskInputSchema.parse(intent.arguments);
      return { commandId, name: 'student_ask', effect: 'ask', input: { ...input,
        sourceInputId: context.inputIds.at(-1) ?? context.snapshot.run.inputId,
        deadline: new Date(Date.parse(context.snapshot.run.createdAt) + 86_400_000).toISOString() } };
    },
    async dispatch(_context, command, _permit, assertDispatch) { await assertDispatch(); return outcome(command); },
    async reconcile(_context, command) { return outcome(command); },
    async validateResponse(_context, wait, answer) { validateUserResponse(wait, answer); },
  };
}

export function validateUserResponse(wait: AgentWait, value: Facts) {
  if (wait.kind !== 'user') throw new StorageError('forbidden');
  const answer = teachingStudentAnswerSchema.parse(value);
  const { questionId: _question, commandId: _command, sourceInputId: _input, moduleId: _module, ...presentation } = wait.presentation;
  const question = teachingStudentAskInputSchema.parse(presentation);
  if (answer.kind === 'choice' && !question.options.some(option => option.id === answer.optionId)
    || answer.kind === 'text' && !question.allowText || answer.kind === 'skip' && !question.skippable) throw new StorageError('invalid');
}
