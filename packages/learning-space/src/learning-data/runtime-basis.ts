import { createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { acceptsState, type ComponentBinding } from '@xunjie/contracts/components';
import { canonicalValue, type ExecutionActionV3, type AnyExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { aluCaseFromAction, aluCodeIdentity, sameAluInputs, type AluCaseDraft } from '@xunjie/contracts/alu-learning';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
/** Re-derive every runtime fact from the activity's authorised fixed release, never a live workspace head. */
export function verifyRuntimeBasis(activity:LearningActivity,binding:ComponentBinding,action:ExecutionActionV3) {
  const fail=():never=>{throw new StorageError('invalid');};
  const m=binding.definition.manifest,b=action.execution.basis;
  if(m.formatVersion!==3) return fail();
  const op=m.runtime.operations.find(o=>o.operationId===action.execution.operation.operationId);
  if(!op || !acceptsState(op.parameters,action.execution.parameters)) return fail();
  if(op.operationId==='run-single' ? b.enabledBy!==undefined : !b.enabledBy) return fail();
  const params=action.execution.parameters;
  if(op.operationId==='check-all') {
    if(!params || typeof params!=='object' || Array.isArray(params) || Object.keys(params).length) return fail();
  } else {
    const controls=params as Record<string,number>;
    if(Object.entries({A:15,B:15,M:1,S:3,Cin:1}).some(([k,max])=>{const value=controls[k];return value===undefined||!Number.isInteger(value)||value<0||value>max;})) return fail();
  }
  if(!same(b.runtime,{adapterId:m.runtime.adapterId,adapterVersion:m.runtime.adapterVersion,bundleIdentity:m.runtime.bundleIdentity,resources:m.runtime.resources})
    || !same(b.compile,op.compile)||!same(b.observation,op.observation))return fail();
  const plan=activity.course?.executionPlan;
  if(!plan || b.course.releaseId!==activity.course?.releaseId || b.course.planDigest!==plan.planDigest
    || b.course.behaviorRuleDigest!==hash(activity.course.requirements) || action.execution.plan.planDigest!==plan.planDigest
    || action.execution.plan.planId!==plan.planId || action.execution.plan.planVersion!==plan.planVersion)return fail();
  if(Object.entries(op.budgets).some(([key,max])=>action.execution.limits[key as keyof typeof op.budgets]>max)
    || action.execution.limits.concurrentJobs>m.budget.concurrentJobs || action.execution.limits.queuedJobs>m.budget.queuedJobs)return fail();
  const code=b.works.filter(f=>f.kind==='code');
  if(code.some(f=>f.encoding!=='utf8'||! /\.(sv|v|svh|vh)$/.test(f.name))
    || code.reduce((n,f)=>n+Buffer.byteLength(f.value,'utf8'),0)>action.execution.limits.inputBytes)return fail();
  if(b.expected.stateContentId!==null && !b.works.some(f=>f.kind==='state'&&f.contentId===b.expected.stateContentId))return fail();
  if(m.stateVersion===3) {
    const state=b.works.find(file=>file.contentId===b.expected.stateContentId);
    let fixed: {content?:{caseRequestId?:unknown}};
    try { fixed=JSON.parse(state?.value??'{}'); } catch { return fail(); }
    if(fixed.content?.caseRequestId && !aluCaseFromAction(action)) return fail();
  }
}

/** Student-entered prediction text is not an attestation of having observed a different run. */
export function verifyAluCasePriorSource(action: ExecutionActionV3, prior: AluCaseDraft['priorSources'][number],
  source: AnyExecutionAction | undefined, confirmed: ExecutionQuery | undefined) {
  const invalid=():never=>{throw new StorageError('invalid');};
  if(!source || source.protocolVersion!==3 || !confirmed || source.requestId===action.requestId
    || prior.requestId!==source.requestId || confirmed.requestId!==source.requestId
    || prior.inputDigest!==confirmed.inputDigest || prior.executionRef!==confirmed.executionRef
    || confirmed.statusKnowledge!=='confirmed' || !confirmed.output || !same(source.scope,action.scope)
    || !same(source.execution.instance,action.execution.instance)
    || aluCodeIdentity(source)!==aluCodeIdentity(action)) return invalid();
  if(prior.kind==='work-check' ? source.execution.operation.operationId!=='check-all'
    : source.execution.operation.operationId==='check-all' || !sameAluInputs(source.execution.parameters,action.execution.parameters)) return invalid();
}

/** Compare retained facts, not an editable client activation flag or current workspace head. */
export function verifyEnabledRuntimeSource(action: ExecutionActionV3, source: AnyExecutionAction | undefined,
  confirmed: ExecutionQuery | undefined) {
  if (action.execution.operation.operationId === 'run-single') return;
  const cite = action.execution.basis.enabledBy;
  const invalid = () => { throw new StorageError('invalid'); };
  if (!cite || !source || source.protocolVersion !== 3 || !confirmed) return invalid();
  const a = action.execution, original = source.execution;
  const output = confirmed.output?.output as { f?: string; cout?: string; observationState?: string } | undefined;
  if (source.requestId !== cite.requestId || confirmed.requestId !== cite.requestId
    || confirmed.inputDigest !== cite.inputDigest || confirmed.executionRef !== cite.executionRef
    || confirmed.state !== 'succeeded' || confirmed.statusKnowledge !== 'confirmed' || !confirmed.output
    || original.operation.operationId !== 'run-single' || !same(source.scope, action.scope)
    || !same(original.instance, a.instance) || !same(original.basis.runtime, a.basis.runtime)
    || !same(original.basis.course, a.basis.course)
    || !same(original.basis.works.filter(f => f.kind === 'code'), a.basis.works.filter(f => f.kind === 'code'))
    || !output || !/^[01xz]{4}$/.test(output.f ?? '') || !/^[01xz]$/.test(output.cout ?? '')
    || !['complete', 'complete-with-unknown'].includes(output.observationState ?? '')) return invalid();
}
