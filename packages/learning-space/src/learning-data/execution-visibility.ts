import { componentStateName, type ComponentBinding } from '@xunjie/contracts/components';
import { aluCaseFromAction, aluResultAllowedBeforeSubmission, isAluCodeWork, sameAluInputs } from '@xunjie/contracts/alu-learning';
import { predictionResultsHidden } from '@xunjie/contracts/course-help';
import type { ExecutionRecord } from '@xunjie/contracts/execution-records';
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data';
import { anyExecutionActionSchema } from '@xunjie/contracts/execution';
import type { ExperimentReference } from '@xunjie/contracts/experiment-references';
import { StorageError } from '@xunjie/storage';

type CurrentWorks = { files: WorkFile[] };
type ReadRecord = (requestId: string) => Promise<ExecutionRecord | null>;

export interface ExecutionReveal {
  reveal: boolean;
  phase: 'not-required' | 'free-observation' | 'pending' | 'submitted';
  previouslyShown?: boolean;
  reason?: 'prediction-required' | 'course-policy';
}

function aluBindings(activity: LearningActivity): ComponentBinding[] {
  return (activity.course?.components ?? []).filter(binding => binding.definition.manifest.formatVersion === 3
    && binding.definition.manifest.runtime.adapterId === 'icarus-alu');
}

function fixedState(files: readonly WorkFile[], binding: ComponentBinding): WorkFile | undefined {
  const name = componentStateName(binding.key);
  return files.find(file => file.name === name && file.kind === 'state' && file.encoding === 'json');
}

function parseState(file: WorkFile | undefined): Record<string, unknown> | null {
  if (!file) return null;
  try {
    const value = JSON.parse(file.value) as { content?: Record<string, unknown> };
    return value.content && typeof value.content === 'object' && !Array.isArray(value.content) ? value.content : null;
  } catch { return null; }
}

const stateInputs = (state: Record<string, unknown>) => ({ A: state.A, B: state.B, M: state.M, S: state.S, Cin: state.Cin });

function sameCodeVersion(action: ReturnType<typeof anyExecutionActionSchema.parse>, current: readonly WorkFile[]) {
  if (action.protocolVersion !== 3) return false;
  const fixed = action.execution.basis.works.filter(isAluCodeWork).map(file => file.contentId).sort();
  const latest = current.filter(isAluCodeWork).map(file => file.contentId).sort();
  return fixed.length > 0 && JSON.stringify(fixed) === JSON.stringify(latest);
}

async function submittedFor(activity: LearningActivity, binding: ComponentBinding, state: Record<string, unknown>,
  current: readonly WorkFile[], readRecord: ReadRecord) {
  const requestId = typeof state.caseRequestId === 'string' ? state.caseRequestId : '';
  if (!requestId) return null;
  const record = await readRecord(requestId);
  if (!record) return null;
  try {
    const action = anyExecutionActionSchema.parse(JSON.parse(record.actionText));
    if (action.protocolVersion !== 3 || action.requestId !== requestId
      || action.scope.activityId !== activity.activityId || action.scope.environmentId !== activity.identity.environmentId
      || action.scope.spaceId !== activity.identity.spaceId || action.scope.principalId !== activity.identity.principalId
      || action.execution.instance.key !== binding.key
      || action.execution.instance.componentId !== binding.definition.manifest.componentId
      || action.execution.instance.componentVersion !== binding.definition.manifest.version
      || action.execution.instance.definitionDigest !== binding.definition.digest
      || !sameCodeVersion(action, current)) return null;
    const capture = aluCaseFromAction(action);
    if (!capture || capture.origin !== 'student' || !sameAluInputs(capture.inputs, stateInputs(state)) || JSON.stringify(capture.draft)
      !== JSON.stringify(JSON.parse(String(state.caseDraft ?? 'null')))) return null;
    return { record, action, capture };
  } catch { return null; }
}

/** The learning owner's current, activity-bound prediction phase. */
async function currentPhase(activity: LearningActivity, binding: ComponentBinding, current: readonly WorkFile[], readRecord: ReadRecord) {
  const state = parseState(fixedState(current, binding));
  if (!state) return { phase: 'unknown' as const };
  if (state.feedbackPolicy === 'live') return { phase: 'free-observation' as const };
  if (state.feedbackPolicy !== 'hold') return { phase: 'unknown' as const };
  const submitted = await submittedFor(activity, binding, state, current, readRecord);
  return submitted ? { phase: 'submitted' as const, submitted } : { phase: 'pending' as const, state };
}

/**
 * Decide whether a retained execution may expose its result at the current activity
 * stage. Same-version/same-input old observations are retained as “shown” facts, not
 * as a new result before the student's held prediction is submitted.
 */
export async function executionReveal(options: {
  activity: LearningActivity; record: ExecutionRecord; current?: CurrentWorks | undefined;
  works?: { read(identity: LearningActivity['identity'], activityId: string): Promise<CurrentWorks> } | undefined;
  readRecord: ReadRecord;
  wasDisplayed?: (record: ExecutionRecord) => Promise<boolean>;
}): Promise<ExecutionReveal> {
  const { activity, record, works, readRecord } = options;
  const policy = activity.course?.helpPolicy;
  const bindings = aluBindings(activity);
  const prior = (await options.wasDisplayed?.(record)) ? { previouslyShown: true } : {};
  if (!predictionResultsHidden(policy) || !bindings.length) return { reveal: true, phase: 'not-required', ...prior };
  let action;
  try {
    action = anyExecutionActionSchema.parse(JSON.parse(record.actionText));
  } catch { return { reveal: false, phase: 'pending', reason: 'course-policy' }; }
  if (action.protocolVersion !== 3 || action.execution.basis.runtime.adapterId !== 'icarus-alu')
    return { reveal: true, phase: 'not-required' };
  if (action.requestId !== record.requestId || action.scope.activityId !== activity.activityId
    || action.scope.environmentId !== activity.identity.environmentId || action.scope.spaceId !== activity.identity.spaceId
    || action.scope.principalId !== activity.identity.principalId)
    return { reveal: false, phase: 'pending', reason: 'course-policy' };
  const instance = action.execution.instance;
  const binding = bindings.find(item => item.key === instance.key && item.definition.digest === instance.definitionDigest
    && item.definition.manifest.componentId === instance.componentId && item.definition.manifest.version === instance.componentVersion);
  if (!binding) return { reveal: false, phase: 'pending', reason: 'course-policy' };
  const current = options.current ?? (works ? await works.read(activity.identity, activity.activityId) : undefined);
  if (!current) return { reveal: false, phase: 'pending', reason: 'course-policy' };
  const phase = await currentPhase(activity, binding, current.files, readRecord);
  if (phase.phase === 'unknown')
    return { reveal: false, phase: 'pending', ...prior, reason: 'prediction-required' };
  if (phase.phase === 'free-observation') return { reveal: true, phase: phase.phase, ...prior };
  if (phase.phase === 'pending') {
    // `aluResultAllowedBeforeSubmission` only applies while the activity is still pending. It
    // answers whether this record proves its own prediction was submitted (or was free play);
    // it must never override an already verified submitted phase, or a `check-all` in hold
    // would remain hidden forever.
    if (!aluResultAllowedBeforeSubmission(action, policy))
      return { reveal: false, phase: 'pending', ...prior, reason: 'prediction-required' };
    const sameInput = (inputs: ReturnType<typeof stateInputs>) =>
      action.execution.operation.operationId === 'check-all' || sameAluInputs(action.execution.parameters, inputs);
    const sameVersion = sameCodeVersion(action, current.files);
    return sameVersion && sameInput(stateInputs(phase.state))
      ? { reveal: false, phase: 'pending', ...prior, reason: 'prediction-required' }
      : { reveal: true, phase: 'pending', ...prior };
  }
  // The current prediction is fixed. An older verified observation stays bound to its own
  // execution version and inputs; the current prediction cannot rewrite that record.
  return { reveal: true, phase: 'submitted', ...prior };
}

/** A single owner-side projection used by generic query and fixed experiment read. */
export function projectExecutionRecord(record: ExecutionRecord, reveal: ExecutionReveal) {
  if (reveal.reveal) {
    const value = { ...record, ...(reveal.previouslyShown ? { previouslyShown: true } : {}) };
    return { value, text: JSON.stringify(value), missing: [] as string[] };
  }
  const query = record.query && typeof record.query === 'object' ? record.query as Record<string, unknown> : {};
  const value: Record<string, unknown> = { requestId: record.requestId, executionRef: record.executionRef,
    inputDigest: record.inputDigest, state: query.state, statusKnowledge: query.statusKnowledge,
    stopRequested: query.stopRequested, resultWithheld: reveal.reason ?? 'course-policy',
    ...(reveal.previouslyShown ? { previouslyShown: true } : {}) };
  return { value, text: JSON.stringify(value), missing: [reveal.reason ?? 'course-policy'] };
}

export async function readFixedExperiment(options: {
  activity: LearningActivity; reference: ExperimentReference; readRecord: ReadRecord;
  works?: { read(identity: LearningActivity['identity'], activityId: string): Promise<CurrentWorks> } | undefined;
  wasDisplayed?: (record: ExecutionRecord) => Promise<boolean>;
}) {
  const { activity, reference, readRecord, works } = options;
  const fixed = reference.source;
  if (fixed.kind !== 'component' || fixed.origin !== 'execution-result' || activity.activityId !== reference.activityId
    || fixed.environmentId !== activity.identity.environmentId || fixed.spaceId !== activity.identity.spaceId
    || fixed.principalId !== activity.identity.principalId) throw new StorageError('forbidden');
  const record = await readRecord(reference.requestId);
  if (!record || record.requestId !== reference.requestId || record.executionRef !== reference.executionRef
    || record.inputDigest !== reference.inputDigest || record.query.output?.contentId !== fixed.contentId)
    throw new StorageError('missing');
  const action = anyExecutionActionSchema.parse(JSON.parse(record.actionText));
  if (action.protocolVersion !== 3 || action.requestId !== reference.requestId
    || action.scope.activityId !== activity.activityId || action.scope.environmentId !== fixed.environmentId
    || action.scope.spaceId !== fixed.spaceId || action.scope.principalId !== fixed.principalId)
    throw new StorageError('identity-conflict');
  const instance = action.execution.instance;
  if (instance.definitionDigest !== fixed.definitionDigest || instance.instanceId !== fixed.instanceId
    || instance.key !== fixed.bindingKey || instance.componentId !== fixed.componentId || instance.componentVersion !== fixed.componentVersion)
    throw new StorageError('identity-conflict');
  const policy = activity.course?.helpPolicy;
  const visibility = await executionReveal({ ...options, record });
  const reveal = policy?.questions !== 'disabled' && visibility.reveal;
  const status = { state: record.query.state, statusKnowledge: record.query.statusKnowledge };
  const capture = aluCaseFromAction(action);
  return { reveal, facts: { ...status, helpPolicy: policy ?? null,
    ...(visibility.previouslyShown ? { previouslyShown: true } : {}),
    ...(reveal ? { hostVerifiedStage: capture ? 'prediction-submitted' : 'free-observation',
      ...(capture ? { studentPrediction: capture.draft } : {}),
      inputs: action.execution.parameters, result: record.query.output?.output ?? null,
      works: action.execution.basis.works.filter(file => file.kind === 'code').map(({ name, objectId, contentId }) =>
        ({ name, objectId, contentId })) } : { resultWithheld: visibility.reason ?? 'course-policy' }) } };
}
