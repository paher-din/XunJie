import { StorageError } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import { teachingStudentAskInputSchema, teachingStudentAnswerSchema } from '@xunjie/contracts/student-questions';
import type { AgentToolResult } from '@xunjie/contracts/agent-runtime';
import type { AgentTool, Facts, ToolCall, ToolContext } from '@xunjie/agent-runtime';
import { completed, json } from '../tool-support.js';

const definition = { name: 'student_ask',
  description: '向学生提出一个明确问题并等待真实回答。呈现或关闭页面不算回应；跳过、关闭或到期都不是同意。创建个人项目前必须用 purpose=create_personal_project 附 proposalKey 与 personalProjectContent 征求确认。',
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', minLength: 1, maxLength: 1000 },
    source: { type: 'string', minLength: 1, maxLength: 500 },
    options: { type: 'array', maxItems: 8, items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } },
    allowText: { type: 'boolean' }, skippable: { type: 'boolean' },
    purpose: { type: 'string', enum: ['create_personal_project'] },
    proposalKey: { type: 'string', minLength: 1, maxLength: 200 },
    personalProjectContent: { type: 'object' } },
    required: ['question', 'source', 'options', 'allowText', 'skippable'], additionalProperties: false } };

/** A real foreground question. The kernel stores the Question and awaits the answer; no prepare/dispatch/reconcile. */
export function createUserQuestions(): AgentTool {
  return { definition, supportsBackground: false,
    async execute(call: ToolCall, ctx: ToolContext): Promise<AgentToolResult> {
      const question = teachingStudentAskInputSchema.parse(call.input);
      // The kernel derives the same questionId from the toolCallId; pre-place it for the presentation.
      const questionId = operationId('agent-question:' + ctx.toolCallId);
      const sourceInputId = ctx.inputIds.at(-1);
      const presentation = json({ ...question, questionId, ...(sourceInputId ? { sourceInputId } : {}) });
      // 24h question ceiling. Anchoring to the exact Turn creation time needs a ToolContext field (see report).
      const deadline = new Date(Date.now() + 86_400_000).toISOString();
      const outcome = await ctx.ask({ presentation, deadline });
      if (outcome.kind === 'answered') {
        const answer = teachingStudentAnswerSchema.parse(outcome.answer);
        return completed(JSON.stringify({ questionId, answerState: 'answered', answer }),
          json({ questionId, answerState: 'answered', version: outcome.version, answer }));
      }
      const label = outcome.kind === 'skipped' ? '学生跳过了问题，未给出同意' : outcome.kind === 'closed' ? '问题已关闭，没有真实回答' : '问题已到期，没有真实回答';
      return completed(JSON.stringify({ questionId, answerState: outcome.kind, note: label }),
        json({ questionId, answerState: outcome.kind, consent: false }));
    } };
}

/** Validates a real answer against the fixed presentation: choice id, text and skip legality. */
export function validateTeachingAnswer(presentation: Facts, value: Facts): void {
  const answer = teachingStudentAnswerSchema.parse(value);
  const { questionId: _question, sourceInputId: _input, ...raw } = presentation;
  const question = teachingStudentAskInputSchema.parse(raw);
  if (answer.kind === 'choice' && !question.options.some(option => option.id === answer.optionId)
    || answer.kind === 'text' && !question.allowText || answer.kind === 'skip' && !question.skippable) throw new StorageError('invalid');
}
