import type { ActionInput } from '@xunjie/contracts/action-intents';
import type { ComponentBinding } from '@xunjie/contracts/components';
import { componentStateName } from '@xunjie/contracts/components';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { predictionResultsHidden } from '@xunjie/contracts/course-help';
import { aluCaseDraftSchema, aluCaseFromAction, aluResultAllowedBeforeSubmission, sameAluInputs } from '@xunjie/contracts/alu-learning';
import { anyExecutionActionSchema } from '@xunjie/contracts/execution';
import type { ExecutionRecord } from '@xunjie/contracts/execution-records';
import { z } from 'zod';

export type PredictionPhase = 'not-required' | 'free-observation' | 'pending' | 'submitted';

function aluBindings(activity: LearningActivity): ComponentBinding[] {
  return (activity.course?.components ?? []).filter(binding => binding.definition.manifest.formatVersion === 3
    && binding.definition.manifest.runtime.adapterId === 'icarus-alu');
}

function fixedState(files: readonly WorkFile[], binding: ComponentBinding): WorkFile | undefined {
  const name = componentStateName(binding.key);
  return files.find(file => file.name === name && file.kind === 'state' && file.encoding === 'json');
}

/**
 * Stage is derived from the fixed action's own files, never from a mutable browser head.
 * A live policy means the student is doing free experimentation; a held case without a
 * fixed request id is still an unsubmitted prediction.
 */
export function predictionPhase(activity: LearningActivity, input: ActionInput): PredictionPhase {
  if (!predictionResultsHidden(activity.course?.helpPolicy)) return 'not-required';
  const bindings = aluBindings(activity);
  if (!bindings.length) return 'not-required';
  const files = [...input.works, ...input.draft.bases];
  for (const binding of bindings) {
    const file = fixedState(files, binding);
    if (!file) continue;
    try {
      const state = JSON.parse(file.value) as { content?: Record<string, unknown> };
      const content = state.content ?? {};
      if (content.feedbackPolicy === 'live') return 'free-observation';
      if (content.feedbackPolicy === 'hold' && typeof content.caseRequestId === 'string' && content.caseRequestId)
        return 'submitted';
    } catch {
      // A damaged state is not evidence that a prediction was submitted.
    }
  }
  return 'pending';
}

export function resultsHidden(phase: PredictionPhase): boolean {
  return phase === 'pending';
}

export async function capturedPrediction(activity: LearningActivity, input: ActionInput,
  read: (requestId: string) => Promise<ExecutionRecord | null>) {
  for (const binding of aluBindings(activity)) {
    const file = fixedState(input.works, binding);
    if (!file) continue;
    try {
      const content = JSON.parse(file.value).content;
      if (content?.feedbackPolicy !== 'hold') continue;
      const requestId = z.uuid().parse(content.caseRequestId);
      const record = await read(requestId);
      if (!record || record.requestId !== requestId) continue;
      const action = anyExecutionActionSchema.parse(JSON.parse(record.actionText));
      if (action.protocolVersion !== 3 || action.requestId !== requestId || action.scope.activityId !== activity.activityId
        || action.scope.environmentId !== activity.identity.environmentId || action.scope.spaceId !== activity.identity.spaceId
        || action.scope.principalId !== activity.identity.principalId || action.execution.instance.key !== binding.key
        || action.execution.instance.definitionDigest !== binding.definition.digest) continue;
      const capture = aluCaseFromAction(action);
      const controls = Object.fromEntries(['A', 'B', 'M', 'S', 'Cin'].map(key => [key, content[key]]));
      if (!capture || !sameAluInputs(controls, capture.inputs)
        || JSON.stringify(capture.draft) !== JSON.stringify(aluCaseDraftSchema.parse(JSON.parse(content.caseDraft)))) continue;
      return { record, action, capture };
    } catch { continue; }
  }
  return null;
}

export async function authorizedPredictionPhase(activity: LearningActivity, input: ActionInput,
  read?: (requestId: string) => Promise<ExecutionRecord | null>): Promise<PredictionPhase> {
  const inferred = predictionPhase(activity, input);
  if (inferred !== 'submitted') return inferred;
  return read && await capturedPrediction(activity, input, read) ? 'submitted' : 'pending';
}

/** Result visibility is also bounded by the original command's stage. */
export async function allowsExecutionResult(activity: LearningActivity, requestId: string,
  read?: (requestId: string) => Promise<ExecutionRecord | null>): Promise<boolean> {
  if (!predictionResultsHidden(activity.course?.helpPolicy) || !aluBindings(activity).length) return true;
  if (!read) return false;
  try {
    const record = await read(requestId);
    if (!record || record.requestId !== requestId) return false;
    const action = anyExecutionActionSchema.parse(JSON.parse(record.actionText));
    return action.requestId === requestId && action.scope.activityId === activity.activityId
      && aluResultAllowedBeforeSubmission(action, activity.course?.helpPolicy);
  } catch { return false; }
}

export function stageNotice(phase: PredictionPhase): string {
  if (phase !== 'pending') return '';
  return '当前课程要求先提交预测再观察。本轮不要读取、转述或运行实际结果；只可说明执行状态、'
    + '提示如何填写预测和下一步验证。学生提交预测并开启新一轮后，才读取对应输入和版本的结果。';
}
