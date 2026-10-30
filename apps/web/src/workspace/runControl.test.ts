import { expect, it } from 'vitest'
import { freezeCancel, verifyCancelReceipt } from './runControl'
import { textHash } from './confirmation'
import type { CommandContext } from './frozenCommand'

const context: CommandContext = { mode: 'preparation', userId: 'student', courseId: 'course',
  assignmentId: 'assignment', activityVersionId: 'activity', attemptId: 'attempt',
  preparationEpoch: 'prep', trustedRecoveryGeneration: 'g1', loadEpoch: 1 }

it('停止仅发送当前代际，摘要依照后台原 jobId 而非 POST 正文，并核对原回执', async () => {
  const command = await freezeCancel(context, 'job', 'run')
  expect(JSON.parse(command.wireJson)).toEqual({ recoveryGeneration: 'g1' })
  expect(command.path).toBe('/jobs/job/cancel')
  expect(command.requestHash).toBe(await textHash('{"fields":{"jobId":"job"},"target":"/api/jobs/job/cancel"}'))
  const receipt = { receiptId: 'receipt', commandId: 'command', serverSeq: 1, committedAt: '2026-10-12T00:00:00Z',
    replayed: false, requestHash: command.requestHash, identity: { actorId: 'student', command: 'job.cancel',
      target: command.target, idempotencyKey: command.commandKey, recoveryGeneration: 'g1',
      scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' } },
    result: { jobId: 'job', status: 'cancelling', stopRequested: true } }
  expect(verifyCancelReceipt(command, receipt).result.status).toBe('cancelling')
  expect(() => verifyCancelReceipt(command, { ...receipt, result: { ...receipt.result, jobId: 'other' } })).toThrow()
  expect(() => verifyCancelReceipt(command, { ...receipt, identity: { ...receipt.identity, recoveryGeneration: 'g2' } })).toThrow()
})
