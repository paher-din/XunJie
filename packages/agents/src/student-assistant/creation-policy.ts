import { canonicalDigest } from '@xunjie/storage/identity';
import { modelAttemptSchema } from '@xunjie/contracts/model-connections';
import { createStudentInputPolicy } from '../capabilities/input-policy/student.ts';
import { isOriginalUserQuestion } from '../capabilities/user-questions/origin.ts';
import type { AgentExecutionSnapshot, Facts } from '@xunjie/agent-runtime';
import type { PersonalProjectContent } from '@xunjie/contracts/student-learning';
import type { ConversationToolContext } from '../conversation/tools.js';
import { fixedPolicyInput, fixedPolicyResponse, type ConversationPolicyInput } from '../conversation/input-policy.ts';
import type { LearningCreationAuthorization } from './tools/learning-tools.js';
export type { LearningCreationAuthorization } from './tools/learning-tools.js';
export { createStudentInputPolicy } from '../capabilities/input-policy/student.ts';

function verified(snapshot: AgentExecutionSnapshot, record: Facts | undefined, source: ConversationPolicyInput) {
  const policy = createStudentInputPolicy();
  if (record?.policy !== policy.id || record.policyVersion !== policy.version || record.inputDigest !== source.inputDigest
    || record.creationAuthorization !== 'direct-create' || typeof record.attemptId !== 'string' || typeof record.resultRef !== 'string') return false;
  const step = snapshot.steps.find(step => step.operation.kind === 'input.policy.call' && step.operation.operationId === record.attemptId);
  if (!step || step.state !== 'completed' || step.result?.state !== 'completed' || step.snapshot.policy !== record.policy
    || step.snapshot.policyVersion !== record.policyVersion || canonicalDigest(step.snapshot.source) !== canonicalDigest(source)) return false;
  const fact = modelAttemptSchema.safeParse(step.result.value.attempt);
  if (!fact.success || fact.data.state !== 'completed' || fact.data.purpose !== 'learning' || fact.data.attemptId !== record.attemptId
    || fact.data.resultRef !== record.resultRef || fact.data.authority?.permit.sessionId !== snapshot.session.sessionId
    || fact.data.authority.permit.runId !== snapshot.run.runId || fact.data.authority.permit.stepId !== step.stepId) return false;
  try { return policy.parse(fact.data.text, source).creationAuthorization === 'direct-create'; } catch { return false; }
}
/** Read only. Authority comes from fixed kernel input/result/response facts, never content/tool argument claims. */
export async function authorizePersonalProjectCreation(context: ConversationToolContext, _content: PersonalProjectContent): Promise<LearningCreationAuthorization | null> {
  const { snapshot } = context;
  if (snapshot.session.scenario !== 'student-assistant' || snapshot.run.sessionId !== snapshot.session.sessionId || snapshot.run.stopRequested) return null;
  const current = snapshot.inputs.filter(input => input.input.mode === 'steering' || input.inputId === snapshot.run.inputId).at(-1);
  for (const input of current ? [current] : []) {
    if (!context.inputIds.includes(input.inputId) || input.input.sessionId !== snapshot.session.sessionId) continue;
    const source = fixedPolicyInput(input), record = ((snapshot.state.inputPolicies ?? {}) as Facts)[input.inputId] as Facts | undefined;
    if (verified(snapshot, record, source) && record?.version === source.version && record.inputId === source.inputId && record.byteLength === source.byteLength)
      return { kind: 'explicit', inputId: input.inputId };
  }
  for (const wait of [...snapshot.waits].reverse()) {
    if (wait.kind !== 'user' || wait.state !== 'consumed' || wait.version < 2 || !wait.response || wait.runId !== snapshot.run.runId
      || wait.presentation.sourceInputId !== (current?.inputId ?? snapshot.run.inputId)
      || !isOriginalUserQuestion(snapshot, wait) || typeof wait.presentation.sourceInputId !== 'string'
      || !snapshot.inputs.some(input => input.inputId === wait.presentation.sourceInputId && input.input.sessionId === snapshot.session.sessionId)) continue;
    const source = fixedPolicyResponse(wait), record = ((snapshot.state.responsePolicies ?? {}) as Facts)[wait.waitId] as Facts | undefined;
    const confirmed = !!source && verified(snapshot, record, source) && record?.waitId === wait.waitId && record.version === wait.version
      && record.questionDigest === source.questionDigest && record.responseDigest === source.responseDigest;
    if (confirmed) return { kind: 'confirmed', inputId: wait.presentation.sourceInputId, waitId: wait.waitId, responseDigest: canonicalDigest(wait.response) };
  }
  return null;
}
