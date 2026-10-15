import { describe, expect, it } from 'vitest'
import { createTutorHdlCurrent, sameTutorHdlSelection, tutorHdlBasisCurrent, tutorHdlSelectionCurrent, verifyTutorHdlBasis, verifyTutorHdlObject, verifyTutorHdlSelection, type TutorHdlCurrent } from './tutoringHdl'
import type { TutorHdlBasis } from './tutoringContracts'
const time='90071992547409930000'
export const hdlBasis=():TutorHdlBasis=>({snapshotId:'snapshot',snapshotHash:'a'.repeat(64),buildId:'build',workspaceRevision:4,
  buildStatus:'succeeded',buildResultHash:'b'.repeat(64),sessionId:'session',sessionRevision:2,sessionStatus:'active',sessionGeneration:'generation',
  confirmedSequence:1,simTimePs:time,stopRequested:false,terminationConfirmed:false,operationId:'operation',resultHash:'c'.repeat(64)})
export const hdlCurrent=():TutorHdlCurrent=>({workspaceRevision:4,hasDraftChanges:false,generation:'generation',
  build:{buildId:'build',snapshotId:'snapshot',snapshotHash:'a'.repeat(64),status:'succeeded',buildResultHash:'b'.repeat(64)},
  session:{sessionId:'session',buildId:'build',snapshotId:'snapshot',snapshotHash:'a'.repeat(64),sessionRevision:2,status:'active',recoveryGeneration:'generation',
    confirmedSequence:1,simTimePs:time,stopRequested:false,terminationConfirmed:false},
  operation:{operationId:'operation',sessionId:'session',resultHash:'c'.repeat(64),sequence:1,sessionRevision:2,simTimePs:time}})
describe('original HDL help selection and frozen provenance',()=> {
  it('keeps business context separate from the exact authorized node binding for HDL currentness',()=> {
    const basis=hdlBasis(),current=hdlCurrent(),execution={nodeId:'robert',nodeGeneration:'node-generation'}
    basis.execution=execution;basis.sessionGeneration=execution.nodeGeneration
    current.execution=execution;current.session!.recoveryGeneration=execution.nodeGeneration
    expect(verifyTutorHdlBasis(basis).execution).toEqual(execution)
    expect(tutorHdlBasisCurrent(basis,current)).toBe(true)
    expect(tutorHdlSelectionCurrent({snapshotId:'snapshot',buildId:'build',sessionId:'session'},current)).toBe(true)
    expect(tutorHdlBasisCurrent({...basis,execution:undefined},current)).toBe(false)
    expect(tutorHdlBasisCurrent({...basis,execution:{...execution,nodeId:'member'}},current)).toBe(false)
    expect(tutorHdlBasisCurrent({...basis,execution:{...execution,nodeGeneration:'other'}},current)).toBe(false)
    expect(()=>verifyTutorHdlBasis({...basis,execution:{...execution,extra:true}})).toThrow()
    current.session!.recoveryGeneration='arbitrary-generation'
    expect(tutorHdlSelectionCurrent({snapshotId:'snapshot',buildId:'build',sessionId:'session'},current)).toBe(false)
  })
  it('requires operation/session pairing and the same confirmed code snapshot',()=> {
    expect(()=>verifyTutorHdlSelection({snapshotId:'snapshot',buildId:'build',operationId:'operation'})).toThrow()
    expect(()=>verifyTutorHdlSelection({snapshotId:'snapshot',buildId:'build',runId:'run'})).toThrow()
    expect(()=>verifyTutorHdlObject({snapshotId:'snapshot',buildId:'build'},{kind:'code',attemptId:'attempt',snapshotId:'other'})).toThrow()
    expect(()=>verifyTutorHdlObject({snapshotId:'snapshot',buildId:'build'},{kind:'run',attemptId:'attempt'})).toThrow()
    expect(sameTutorHdlSelection({snapshotId:'snapshot',buildId:'build'},hdlBasis())).toBe(false)
  })
  it('keeps large simulated times as exact decimal strings and rejects unknown source fields',()=> {
    expect(verifyTutorHdlBasis(hdlBasis()).simTimePs).toBe(time)
    expect(()=>verifyTutorHdlBasis({...hdlBasis(),simTimePs:Number(time)})).toThrow()
    expect(()=>verifyTutorHdlBasis({...hdlBasis(),privateAnswer:'secret'})).toThrow()
    expect(()=>verifyTutorHdlBasis({...hdlBasis(),snapshotHash:'A'.repeat(64)})).toThrow()
  })
  it('accepts a build-only diagnostic and only exact active session/operation state',()=> {
    const b=hdlBasis(),c=hdlCurrent()
    expect(tutorHdlBasisCurrent(b,c)).toBe(true)
    expect(tutorHdlSelectionCurrent({snapshotId:'snapshot',buildId:'build',sessionId:'session',operationId:'operation'},c)).toBe(true)
    const diagnostic={snapshotId:b.snapshotId,snapshotHash:b.snapshotHash,buildId:b.buildId,buildStatus:'failed' as const,
      buildResultHash:b.buildResultHash,workspaceRevision:b.workspaceRevision}
    c.build!.status='failed';c.session=null;c.operation=null
    expect(tutorHdlBasisCurrent(diagnostic,c)).toBe(true)
    expect(tutorHdlSelectionCurrent({snapshotId:'snapshot',buildId:'build'},c)).toBe(true)
  })
  it.each([
    ['draft',(c:TutorHdlCurrent)=>{c.hasDraftChanges=true}],
    ['workspace revision',(c:TutorHdlCurrent)=>{c.workspaceRevision++}],
    ['build identity',(c:TutorHdlCurrent)=>{c.build!.buildId='other'}],
    ['build visible hash',(c:TutorHdlCurrent)=>{c.build!.buildResultHash='d'.repeat(64)}],
    ['snapshot',(c:TutorHdlCurrent)=>{c.build!.snapshotId='other'}],
    ['pending',(c:TutorHdlCurrent)=>{c.session!.pendingOperationId='pending'}],
    ['stop requested',(c:TutorHdlCurrent)=>{c.session!.stopRequested=true}],
    ['termination',(c:TutorHdlCurrent)=>{c.session!.terminationConfirmed=true}],
    ['session revision',(c:TutorHdlCurrent)=>{c.session!.sessionRevision++}],
    ['sequence',(c:TutorHdlCurrent)=>{c.session!.confirmedSequence++}],
    ['time',(c:TutorHdlCurrent)=>{c.session!.simTimePs='90071992547409930001'}],
    ['generation',(c:TutorHdlCurrent)=>{c.generation='other'}],
    ['operation identity',(c:TutorHdlCurrent)=>{c.operation!.operationId='other'}],
    ['operation result',(c:TutorHdlCurrent)=>{c.operation!.resultHash='d'.repeat(64)}],
  ])('makes a frozen answer historical after %s',(_name,change)=> {
    const c=hdlCurrent();change(c);expect(tutorHdlBasisCurrent(hdlBasis(),c)).toBe(false)
  })
  it('does not give current authority to legacy HDL missing workspace or visible build hash',()=> {
    const b=hdlBasis();delete b.workspaceRevision;expect(tutorHdlBasisCurrent(b,hdlCurrent())).toBe(false)
    b.workspaceRevision=4;delete b.buildResultHash;expect(tutorHdlBasisCurrent(b,hdlCurrent())).toBe(false)
    expect(tutorHdlBasisCurrent(hdlBasis(),null)).toBe(false)
  })
  it('takes a detached copy before hashing the authorized Build and preserves public operation time',async()=> {
    const build={buildId:'build',snapshotId:'snapshot',snapshotHash:'a'.repeat(64),status:'succeeded',diagnostics:[]}
    const current=hdlCurrent(),session={...current.session,identity:{recoveryGeneration:'generation'}},operation={...current.operation,finalFrame:{simTimePs:time}}
    const pending=createTutorHdlCurrent({workspaceRevision:4,hasDraftChanges:false,generation:'generation',build,session,operation})
    build.status='failed';session.simTimePs='1';operation.finalFrame.simTimePs='2'
    const result=await pending
    expect(result.build!.status).toBe('succeeded');expect(result.session!.simTimePs).toBe(time);expect(result.operation!.simTimePs).toBe(time)
    expect(result.build!.buildResultHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
