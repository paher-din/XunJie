import { record, requiredId, revision, textHash } from './confirmation'
import type { TutorHdlBasis, TutorHdlSelection, TutorObject } from './tutoringContracts'
import type { HdlExecutionBinding } from './hdlContracts'
export type { TutorHdlBasis, TutorHdlSelection } from './tutoringContracts'

const selectionKeys=['snapshotId','buildId','sessionId','operationId']
const basisKeys=[...selectionKeys,'snapshotHash','buildStatus','buildResultHash','workspaceRevision','sessionRevision',
  'sessionStatus','sessionGeneration','confirmedSequence','simTimePs','pendingOperationId','stopRequested','terminationConfirmed','resultHash','execution']
const hash=(v:unknown):string=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('HDL 来源摘要不完整');return v}
const decimal=(v:unknown):string=>{if(typeof v!=='string'||!/^\d{1,32}$/.test(v))throw new Error('HDL 模拟时间不完整');return v}
function shape(v:unknown,keys:string[]) {const r=record(v);if(Object.keys(r).some(k=>!keys.includes(k)))throw new Error('HDL 来源字段不完整');return r}
function executionBinding(v:unknown):HdlExecutionBinding {
  const r=shape(v,['nodeId','nodeGeneration'])
  if(typeof r.nodeId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(r.nodeId))throw new Error('HDL 来源节点不完整')
  return {nodeId:r.nodeId,nodeGeneration:requiredId(r.nodeGeneration)}
}
const sameExecution=(a?:HdlExecutionBinding,b?:HdlExecutionBinding)=>a?.nodeId===b?.nodeId&&a?.nodeGeneration===b?.nodeGeneration
export function verifyTutorHdlSelection(v:unknown):TutorHdlSelection {
  const s=shape(v,selectionKeys);requiredId(s.snapshotId);requiredId(s.buildId)
  if(s.sessionId!==undefined)requiredId(s.sessionId)
  if(s.operationId!==undefined){requiredId(s.operationId);requiredId(s.sessionId)}
  return structuredClone(s) as unknown as TutorHdlSelection
}
export function verifyTutorHdlBasis(v:unknown):TutorHdlBasis {
  const b=shape(v,basisKeys)
  if(b.execution!==undefined)executionBinding(b.execution)
  verifyTutorHdlSelection(Object.fromEntries(selectionKeys.filter(k=>Object.hasOwn(b,k)).map(k=>[k,b[k]])))
  hash(b.snapshotHash)
  if(!['queued','running','succeeded','failed','cancelled','outcome_unknown'].includes(String(b.buildStatus)))throw new Error('HDL 构建状态不完整')
  for(const key of ['buildResultHash','resultHash'])if(b[key]!==undefined)hash(b[key])
  for(const key of ['workspaceRevision','confirmedSequence'])if(b[key]!==undefined)revision(b[key])
  if(b.sessionRevision!==undefined)revision(b.sessionRevision,1)
  if(b.sessionStatus!==undefined&&!['starting','active','stopping','stopped','failed','outcome_unknown'].includes(String(b.sessionStatus)))throw new Error('HDL 会话状态不完整')
  for(const key of ['sessionGeneration','pendingOperationId'])if(b[key]!==undefined)requiredId(b[key])
  if(b.simTimePs!==undefined)decimal(b.simTimePs)
  for(const key of ['stopRequested','terminationConfirmed'])if(b[key]!==undefined&&typeof b[key]!=='boolean')throw new Error('HDL 停止状态不完整')
  if(!b.sessionId&&['sessionRevision','sessionStatus','sessionGeneration','confirmedSequence','simTimePs','pendingOperationId','stopRequested','terminationConfirmed','operationId','resultHash'].some(k=>b[k]!==undefined))throw new Error('HDL 来源缺少原会话')
  if(!b.operationId&&b.resultHash!==undefined)throw new Error('HDL 来源缺少原操作')
  return structuredClone(b) as unknown as TutorHdlBasis
}
export function verifyTutorHdlObject(selection:TutorHdlSelection,object?:TutorObject) {
  if(object?.kind==='run'||object?.kind==='code'&&object.snapshotId!==selection.snapshotId)throw new Error('HDL 求助必须引用同一快照，不能引用 C 运行')
}
export function sameTutorHdlSelection(selection:TutorHdlSelection,basis:TutorHdlBasis):boolean {
  return selectionKeys.every(k=>selection[k as keyof TutorHdlSelection]===basis[k as keyof TutorHdlSelection])
}
export interface TutorHdlCurrent {
  workspaceRevision:number;hasDraftChanges:boolean;generation:string
  execution?:HdlExecutionBinding
  build:{buildId:string;snapshotId:string;snapshotHash:string;status:string;buildResultHash:string}|null
  session:{sessionId:string;buildId:string;snapshotId:string;snapshotHash:string;sessionRevision:number;status:string;recoveryGeneration:string
    confirmedSequence:number;simTimePs:string;pendingOperationId?:string;stopRequested:boolean;terminationConfirmed:boolean}|null
  operation:{operationId:string;sessionId:string;resultHash:string;sequence:number;sessionRevision:number;simTimePs:string}|null
}
/** Inputs are already-authorized public results. This does not manufacture a frozen basis or authorize a request. */
export async function createTutorHdlCurrent(input:{workspaceRevision:number;hasDraftChanges:boolean;generation:string
  build:unknown|null;session:unknown|null;operation:unknown|null;execution?:HdlExecutionBinding}):Promise<TutorHdlCurrent> {
  const fixed=structuredClone(input),{build,session,operation}=fixed
  revision(fixed.workspaceRevision);requiredId(fixed.generation)
  const execution=fixed.execution===undefined?undefined:executionBinding(fixed.execution)
  if(typeof fixed.hasDraftChanges!=='boolean')throw new Error('HDL 草稿状态不完整')
  let b:TutorHdlCurrent['build']=null,s:TutorHdlCurrent['session']=null,o:TutorHdlCurrent['operation']=null
  if(build) {const r=record(build);b={buildId:requiredId(r.buildId),snapshotId:requiredId(r.snapshotId),snapshotHash:hash(r.snapshotHash),
    status:String(r.status),buildResultHash:await textHash(JSON.stringify(r))}}
  if(session) {const r=record(session),identity=record(r.identity)
    if(typeof r.stopRequested!=='boolean'||typeof r.terminationConfirmed!=='boolean')throw new Error('HDL 会话停止状态不完整')
    s={sessionId:requiredId(r.sessionId),buildId:requiredId(r.buildId),snapshotId:requiredId(r.snapshotId),snapshotHash:hash(r.snapshotHash),
      sessionRevision:revision(r.sessionRevision,1),status:String(r.status),recoveryGeneration:requiredId(identity.recoveryGeneration),
      confirmedSequence:revision(r.confirmedSequence),simTimePs:decimal(r.simTimePs),stopRequested:r.stopRequested,terminationConfirmed:r.terminationConfirmed,
      ...(r.pendingOperationId?{pendingOperationId:requiredId(r.pendingOperationId)}:{})}}
  if(operation) {const r=record(operation),frame=record(r.finalFrame)
    o={operationId:requiredId(r.operationId),sessionId:requiredId(r.sessionId),resultHash:hash(r.resultHash),sequence:revision(r.sequence),
      sessionRevision:revision(r.sessionRevision,1),simTimePs:decimal(frame.simTimePs)}}
  return {workspaceRevision:fixed.workspaceRevision,hasDraftChanges:fixed.hasDraftChanges,generation:fixed.generation,build:b,session:s,operation:o,execution}
}
export function tutorHdlBasisCurrent(basis:TutorHdlBasis,current:TutorHdlCurrent|null):boolean {
  if(!current||!sameExecution(basis.execution,current.execution)||current.hasDraftChanges||basis.workspaceRevision===undefined||basis.workspaceRevision!==current.workspaceRevision
    ||!current.build||!basis.buildResultHash||basis.buildId!==current.build.buildId||basis.snapshotId!==current.build.snapshotId
    ||basis.snapshotHash!==current.build.snapshotHash||basis.buildStatus!==current.build.status||basis.buildResultHash!==current.build.buildResultHash)return false
  if(basis.sessionId) {
    const s=current.session
    if(!s||s.sessionId!==basis.sessionId||s.buildId!==basis.buildId||s.snapshotId!==basis.snapshotId||s.snapshotHash!==basis.snapshotHash
      ||s.status!=='active'||s.stopRequested||s.terminationConfirmed||s.pendingOperationId||s.recoveryGeneration!==(current.execution?.nodeGeneration??current.generation)
      ||s.sessionRevision!==basis.sessionRevision||s.status!==basis.sessionStatus||s.recoveryGeneration!==basis.sessionGeneration
      ||s.confirmedSequence!==basis.confirmedSequence||s.simTimePs!==basis.simTimePs||s.stopRequested!==basis.stopRequested
      ||s.terminationConfirmed!==basis.terminationConfirmed||s.pendingOperationId!==basis.pendingOperationId)return false
  }
  if(basis.operationId) {const o=current.operation
    if(!o||o.operationId!==basis.operationId||o.sessionId!==basis.sessionId||o.resultHash!==basis.resultHash
      ||o.sequence!==basis.confirmedSequence||o.sessionRevision!==basis.sessionRevision||o.simTimePs!==basis.simTimePs)return false}
  return true
}
export function tutorHdlSelectionCurrent(selection:TutorHdlSelection,current:TutorHdlCurrent|null):boolean {
  if(!current||current.hasDraftChanges||!current.build||selection.buildId!==current.build.buildId||selection.snapshotId!==current.build.snapshotId
    ||!['succeeded','failed'].includes(current.build.status))return false
  if(selection.sessionId) {const s=current.session
    if(!s||s.sessionId!==selection.sessionId||s.buildId!==selection.buildId||s.snapshotId!==selection.snapshotId||s.status!=='active'
      ||s.stopRequested||s.terminationConfirmed||s.pendingOperationId||s.recoveryGeneration!==(current.execution?.nodeGeneration??current.generation))return false}
  if(selection.operationId) {const s=current.session,o=current.operation
    if(!s||!o||o.operationId!==selection.operationId||o.sessionId!==s.sessionId||o.sequence!==s.confirmedSequence||o.sessionRevision!==s.sessionRevision||o.simTimePs!==s.simTimePs)return false}
  return true
}
