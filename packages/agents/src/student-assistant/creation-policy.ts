import { canonicalDigest } from '@xunjie/storage/identity';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { PersonalProjectContent } from '@xunjie/contracts/student-learning';

/** A real Question/Answer record bound to a proposal. Read from the business owner, never model claims. */
export interface CreationQuestionRecord {
  questionId: string; version: number;
  state: 'pending' | 'answered' | 'skipped' | 'expired' | 'closed';
  purpose?: 'create_personal_project'; proposalKey?: string;
  personalProjectContent?: PersonalProjectContent;
  answer: { kind: 'choice'; optionId: string } | { kind: 'text'; text: string } | { kind: 'skip' } | null;
  sourceInputId: string;
  /** The SessionInput carrying the real answer, once it entered a Step input range. */
  answerInputId: string | null;
}
/** Injected read port: same Session, same student, same proposalKey. No Operation indirection. */
export interface CreationQuestionsPort {
  findByProposal(input: { sessionId: string; identity: SpaceIdentity; proposalKey: string }): Promise<CreationQuestionRecord[]>;
}
export type CreationDecision =
  | { kind: 'allow'; questionId: string; answerVersion: number; sourceInputId: string; basis: 'confirm' | 'model-judgment' }
  | { kind: 'confirmation_required'; reason: string }
  | { kind: 'declined'; reason: string }
  | { kind: 'answer_requires_model_judgment'; questionId: string; answerVersion: number };

const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);

/**
 * PLAN 8.1: only real question/answer facts authorize creation. No model call, no keyword classifier.
 * Structured refusal can never be overridden by model narrative; free text needs the main model's
 * semantic judgment in a later Step that actually saw the answer.
 */
export async function verifyProjectCreation(
  ctx: { sessionId: string; turnId: string; inputIds: readonly string[] },
  identity: SpaceIdentity, content: PersonalProjectContent, proposalKey: string,
  questions: CreationQuestionsPort,
): Promise<CreationDecision> {
  const records = await questions.findByProposal({ sessionId: ctx.sessionId, identity, proposalKey });
  const matching = records
    .filter(record => record.purpose === 'create_personal_project' && record.proposalKey === proposalKey
      && record.personalProjectContent !== undefined && same(record.personalProjectContent, content))
    .sort((a, b) => b.version - a.version);
  const record = matching[0];
  if (!record) return { kind: 'confirmation_required', reason: '没有匹配该提案内容的真实确认问题；请先用 student_ask 征求同意。' };
  if (record.state === 'pending') return { kind: 'confirmation_required', reason: '确认问题尚未回答。' };
  if (record.state === 'skipped' || record.state === 'expired' || record.state === 'closed')
    return { kind: 'declined', reason: '问题被跳过、关闭或到期，不构成同意。' };
  const answer = record.answer;
  if (!answer || answer.kind === 'skip') return { kind: 'declined', reason: '没有有效的同意回答。' };
  if (answer.kind === 'choice') {
    if (answer.optionId === 'confirm') return { kind: 'allow', questionId: record.questionId, answerVersion: record.version, sourceInputId: record.sourceInputId, basis: 'confirm' };
    return { kind: 'declined', reason: '学生选择了暂不创建或拒绝。' };
  }
  // Free text: the main model may judge only after the real answer entered this Step's input range.
  if (record.answerInputId !== null && ctx.inputIds.includes(record.answerInputId))
    return { kind: 'allow', questionId: record.questionId, answerVersion: record.version, sourceInputId: record.sourceInputId, basis: 'model-judgment' };
  return { kind: 'answer_requires_model_judgment', questionId: record.questionId, answerVersion: record.version };
}