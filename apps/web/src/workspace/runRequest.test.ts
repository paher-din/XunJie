import { expect, it } from 'vitest'
import { freezeRun, type CoreInput } from './runRequest'
import { manifestRows, textHash } from './confirmation'
import type { SnapshotView } from './workspaceContracts'
import type { CommandContext } from './frozenCommand'

const context: CommandContext = { mode: 'preparation', userId: 'student', courseId: 'course',
  assignmentId: 'assignment', activityVersionId: 'activity', attemptId: 'attempt',
  preparationEpoch: 'prep', trustedRecoveryGeneration: 'g1', loadEpoch: 1 }
async function snapshot(): Promise<SnapshotView> {
  const files = [
    { fileId: 'source', path: 'main.c', text: 'int main(void) {return 0;}\n', documentVersion: 1 },
    { fileId: 'input', path: 'sample.txt', text: 'one two one\n', documentVersion: 1 },
  ]
  const hashed = await Promise.all(files.map(async f => ({ ...f, contentHash: await textHash(f.text) })))
  return { snapshotId: 'snapshot', attemptId: 'attempt', activityVersionId: 'activity',
    workspaceRevision: 7, hashFormat: 'sha256-manifest-v1', hash: await textHash(JSON.stringify(manifestRows(hashed))),
    createdAt: '2026-10-12T00:00:00.000Z', files: hashed }
}
it('冻结 Core 原请求使用权威 Attempt revision 和快照实例，不携带草稿或 sync 字段', async () => {
  const fixed = await snapshot()
  const command = await freezeRun(context, 11, fixed, 'profile', 'source', { operation: 'find', fileIds: ['input'], word: 'one' })
  expect(JSON.parse(command.wireJson)).toEqual({ recoveryGeneration: 'g1', expectedAttemptRevision: 11,
    snapshotId: 'snapshot', runtimeProfileVersion: 'profile', entryFileId: 'source',
    input: { operation: 'find', fileIds: ['input'], word: 'one' }, mode: 'run' })
  expect(command.kind).toBe('run.create')
  expect(command.drafts).toEqual([])
  fixed.files[1]!.text = 'later edit'
  expect(JSON.parse(command.wireJson).input.fileIds).toEqual(['input'])
})
it('find 缺少 word 不能被字符串强制转换成一个合法 ASCII 词', async () => {
  await expect(freezeRun(context, 11, await snapshot(), 'profile', 'source',
    { operation: 'find', fileIds: ['input'] } as CoreInput)).rejects.toThrow('ASCII')
})
