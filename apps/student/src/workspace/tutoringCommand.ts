import { record, requiredId, revision, textHash } from './confirmation'
import type { CommandContext } from './frozenCommand'
import type { TutorCommand } from './tutoringStore'
import type { TutorHistoryQuestion } from './tutoringContracts'
import { sameTutorHdlSelection, verifyTutorHdlBasis, verifyTutorHdlSelection, verifyTutorHdlObject } from './tutoringHdl'
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export const tutorRequestHash = (target: string, fields: unknown) => textHash(canonical({target,fields}))
export async function verifyTutorCommandReceipt(context: CommandContext, command: TutorCommand, value: unknown, originalQuestion?:TutorHistoryQuestion) {
  const r = record(value), i = record(r.identity), scope=record(i.scope), body=JSON.parse(command.wireJson)
  const target=`/api${command.path}`
  const fields=command.kind==='cancel' ? {jobId:decodeURIComponent(command.path.split('/')[2]!),reason:body.reason??'explicit_job_cancel'} : {...body}
  // B2 hashes its validated help input including recoveryGeneration. C's cancel
  // command instead hashes {jobId, reason}; do not apply the workspace sync rule here.
  requiredId(r.receiptId);requiredId(r.commandId);revision(r.serverSeq,1)
  if (i.command!==(command.kind==='help'?'student_help.create':'job.cancel') || i.actorId!==context.userId || i.target!==target
    || i.idempotencyKey!==command.key || i.recoveryGeneration!==context.trustedRecoveryGeneration
    || scope.courseId!==context.courseId || scope.studentId!==context.userId || scope.attemptId!==context.attemptId
    || r.requestHash!==await tutorRequestHash(target,fields) || typeof r.replayed!=='boolean'
    || !Number.isFinite(Date.parse(String(r.committedAt)))) throw new Error('辅导回执与原命令不符')
  const result=record(r.result)
  if (command.kind==='help') {
    const accepted:{question:unknown;objectRef:unknown;hdlSelection?:unknown;hdlBasis?:unknown}={question:body.question,objectRef:body.objectRef??null}
    if(body.hdlSelection!==undefined) {
      const selection=verifyTutorHdlSelection(body.hdlSelection);verifyTutorHdlObject(selection,body.objectRef)
      // H4 includes the transaction-frozen basis in acceptedInputHash. Only the original
      // authorized question/receipt association can supply it, never a current GET projection.
      if(!originalQuestion||originalQuestion.jobId!==result.jobId||originalQuestion.requestReceiptId!==r.receiptId
        ||canonical(originalQuestion.scope)!==canonical(scope)||originalQuestion.envelope.question!==body.question
        ||canonical(originalQuestion.envelope.objectRef??null)!==canonical(body.objectRef??null)
        ||canonical(originalQuestion.envelope.hdlSelection)!==canonical(selection))throw new Error('原 HDL 问题与接纳回执关联尚未核对')
      const basis=verifyTutorHdlBasis(originalQuestion.envelope.hdlBasis)
      if(!sameTutorHdlSelection(selection,basis))throw new Error('原 HDL 冻结来源与选择不符')
      accepted.hdlSelection=selection;accepted.hdlBasis=basis
    }
    if(result.acceptedInputHash!==await tutorRequestHash('student_help.accepted_input',accepted))throw new Error('服务接纳问题与原请求不符')
  }
  return result
}
