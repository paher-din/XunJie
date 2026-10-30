import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sameWorkspace, verifySnapshot } from './confirmation'
import type { WorkspaceFile } from './workspaceContracts'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

it('同路径回收后重建的完整确认清单不因 ACK 与 GET 顺序不同而冲突', () => {
  const recycled: WorkspaceFile = { fileId: 'z-old', attemptId: 'attempt-1', path: 'main.c',
    documentVersion: 2, text: 'old\n', contentHash: hash('old\n'), lifecycle: 'recycled' }
  const active: WorkspaceFile = { fileId: 'a-new', attemptId: 'attempt-1', path: 'main.c',
    documentVersion: 1, text: 'new\n', contentHash: hash('new\n'), lifecycle: 'active' }
  // ACK 在原清单末尾追加新实例；真实 C2 GET 按 file_id 排序。
  const ack = { files: [recycled, active] }, get = { files: [active, recycled] }
  expect(sameWorkspace(ack, get)).toBe(true)
  expect(sameWorkspace(get, ack)).toBe(true)
  expect(sameWorkspace(ack, { files: [active] })).toBe(false)
})

describe('确认读取的原文字节边界', () => {
  it('保留 BOM、混合换行与非 BMP 原文，并拒绝摘要不符', async () => {
    const text = '\uFEFF中文😀\r\nnext\rbare\n\n'
    const file = { fileId: 'file-1', path: 'main.c', documentVersion: 2, text, contentHash: hash(text) }
    const snapshot = { snapshotId: 'snapshot-1', attemptId: 'attempt-1', activityVersionId: 'activity-1',
      workspaceRevision: 3, createdAt: '2026-10-12T00:00:00.000Z', hashFormat: 'sha256-manifest-v1',
      hash: hash(JSON.stringify([[file.fileId, file.path, file.documentVersion, file.contentHash]])), files: [file] }
    expect((await verifySnapshot(snapshot, 'attempt-1', 'activity-1')).files[0]?.text).toBe(text)
    await expect(verifySnapshot({ ...snapshot, files: [{ ...file, text: text.replace(/\r/g, '') }] }, 'attempt-1', 'activity-1')).rejects.toThrow('摘要')
  })
})

import { freezeSync, verifySyncReceipt } from './frozenCommand'
const context = { mode: 'preparation' as const, userId: 'student-1', assignmentId: 'assignment-1',
  activityVersionId: 'activity-1', attemptId: 'attempt-1', preparationEpoch: 'epoch-1', loadEpoch: 1,
  trustedRecoveryGeneration: 'g1', courseId: 'course-1' }

it('发送冻结原文，用 ACK 元数据形成确认基线，拒绝偷换归属', async () => {
  const frozen = await freezeSync(context, { attemptId: 'attempt-1', workspaceRevision: 0, files: [] },
    [{ localId: 'local-1', path: 'main.c', text: '\uFEFFold\r\n😀\n', draftRevision: 1 }], 'client-1', 1)
  const receipt = { receiptId: 'receipt-1', commandId: 'command-1', requestHash: frozen.requestHash,
    identity: { actorId: 'student-1', command: 'workspace.sync', target: '/api/attempts/attempt-1/sync',
      scope: { courseId: 'course-1', studentId: 'student-1', attemptId: 'attempt-1' },
      idempotencyKey: frozen.commandKey, recoveryGeneration: 'g1', sync: { clientId: 'client-1', clientSeq: 1 } },
    serverSeq: 1, committedAt: '2026-10-12T00:00:00.000Z', replayed: false,
    result: { workspaceRevision: 1, created: { 'local-1': 'file-1' }, process: { status: 'not_collected' },
      files: [{ fileId: 'file-1', path: 'main.c', documentVersion: 1, contentHash: hash('\uFEFFold\r\n😀\n'), lifecycle: 'active' }] } }
  expect((await verifySyncReceipt(frozen, receipt)).workspace.files[0]?.text).toBe('\uFEFFold\r\n😀\n')
  await expect(verifySyncReceipt(frozen, { ...receipt, identity: { ...receipt.identity, actorId: 'other' } })).rejects.toThrow('回执')
})

import { freezeAttempt } from './frozenCommand'
it('首次受信代际缺失时禁止创建命令，既有 Attempt 仍可只读', async () => {
  await expect(freezeAttempt({ ...context, trustedRecoveryGeneration: null })).rejects.toThrow('H-03')
})

it('快照清单按 UTF-8 路径顺序校验，不采用 UTF-16 字符排序', async () => {
  const text = ''
  const privatePath = { fileId: 'file-a', path: '\uE000.c', documentVersion: 1, text, contentHash: hash(text) }
  const astralPath = { ...privatePath, fileId: 'file-b', path: '\u{10000}.c' }
  const snapshot = { snapshotId: 'unicode-order', attemptId: 'attempt-1', activityVersionId: 'activity-1',
    workspaceRevision: 0, hashFormat: 'sha256-manifest-v1', createdAt: '2026-10-12T00:00:00.000Z',
    files: [astralPath, privatePath], hash: hash(JSON.stringify([
      ['file-a', '\uE000.c', 1, hash('')], ['file-b', '\u{10000}.c', 1, hash('')],
    ])) }
  expect((await verifySnapshot(snapshot, 'attempt-1', 'activity-1')).snapshotId).toBe('unicode-order')
})
