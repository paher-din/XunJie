import { describe, expect, it } from 'vitest'
import { buildVersionComparison, buildWorkspaceComparison, sideFromSnapshot } from './comparison'
import type { VersionFile, VersionSide } from './comparison'
import type { OutboxRecord } from './frozenCommand'
import type { ConfirmedWorkspace, SnapshotView, WorkspaceFile } from './workspaceContracts'

function file(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { fileId: 'server-1', attemptId: 'attempt-1', path: 'main.c', documentVersion: 1, text: 'baseline\n',
    contentHash: 'hash-1', lifecycle: 'active', ...overrides }
}
function workspace(files: WorkspaceFile[], workspaceRevision = 2): ConfirmedWorkspace {
  return { attemptId: 'attempt-1', workspaceRevision, files }
}
function command(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    commandKey: 'cmd-1', context: { mode: 'preparation', userId: 'u1', courseId: 'c1', assignmentId: 'a1',
      activityVersionId: 'v1', attemptId: 'attempt-1', preparationEpoch: 'epoch-1', loadEpoch: 1,
      trustedRecoveryGeneration: 'g1' },
    kind: 'workspace.sync', path: '/attempts/attempt-1/sync', target: '/api/attempts/attempt-1/sync',
    wireJson: '{}', requestHash: 'h', createdAt: 1, before: workspace([file()], 1),
    drafts: [{ localId: 'local-1', path: 'main.c', text: 'mine\n', draftRevision: 1, serverFileId: 'server-1' }],
    state: 'pending', ...overrides,
  }
}

describe('冲突比较视图模型', () => {
  it('版本冲突：本机原文、原确认基线与当前 head 的服务正文各自独立', () => {
    const head = workspace([file({ text: 'service\n', documentVersion: 2 })])
    const view = buildWorkspaceComparison(command(), head, 'version-conflict')
    expect(view.files).toHaveLength(1)
    expect(view.files[0]).toEqual({ path: 'main.c', localId: 'local-1', mine: 'mine\n', base: 'baseline\n', theirs: 'service\n' })
  })

  it('本机新建的文件：基线与服务端都还没有时为 null，不编造正文', () => {
    const cmd = command({ drafts: [{ localId: 'local-2', path: 'new.c', text: 'created\n', draftRevision: 1 }] })
    const view = buildWorkspaceComparison(cmd, workspace([]), 'version-conflict')
    expect(view.files[0]).toEqual({ path: 'new.c', localId: 'local-2', mine: 'created\n', base: null, theirs: null })
  })

  it('update 按 serverFileId 匹配，路径不同的同名文件不会串正文', () => {
    const head = workspace([file({ fileId: 'server-1', path: 'renamed.c', text: 'service\n' }),
      file({ fileId: 'server-2', path: 'main.c', text: 'other\n' })])
    const view = buildWorkspaceComparison(command(), head, 'version-conflict')
    expect(view.files[0]!.theirs).toBe('service\n')
  })

  it('多个文件逐个比较；head 尚未读取时不编造服务正文', () => {
    const cmd = command({ drafts: [
      { localId: 'local-1', path: 'main.c', text: 'mine\n', draftRevision: 1, serverFileId: 'server-1' },
      { localId: 'local-2', path: 'util.c', text: 'util\n', draftRevision: 3 }] })
    const view = buildWorkspaceComparison(cmd, null, 'unresolved')
    expect(view.source).toBe('unresolved')
    expect(view.files.map(f => f.theirs)).toEqual([null, null])
    expect(view.files[1]!.base).toBe(null)
  })

  it('旧代际恢复比较：冻结正文与重读后的新上下文可比，基线保留', () => {
    const view = buildWorkspaceComparison(command(), workspace([file({ text: 'recovered\n', documentVersion: 3 })]), 'recovery')
    expect(view.source).toBe('recovery')
    expect(view.files[0]).toMatchObject({ mine: 'mine\n', base: 'baseline\n', theirs: 'recovered\n' })
  })
})
function versionFile(overrides: Partial<VersionFile> = {}): VersionFile {
  return { fileId: 'server-1', path: 'main.c', documentVersion: 1, contentHash: 'hash-1', text: 'baseline\n', ...overrides }
}
function versionSide(label: string, files: VersionFile[], revision: number | null = null): VersionSide {
  return { label, revision, files }
}

describe('只读版本比较视图模型（05）', () => {
  it('按 fileId 对齐：同一实例两侧一行，路径不同也仍是一行并各自保留路径', () => {
    const view = buildVersionComparison('snapshots',
      versionSide('快照 v2', [versionFile({ fileId: 'f1', path: 'main.c', text: 'a\n' })]),
      versionSide('快照 v3', [versionFile({ fileId: 'f1', path: 'src/main.c', text: 'b\n', documentVersion: 4 })], 3))
    expect(view).toMatchObject({ kind: 'versions', source: 'snapshots', leftLabel: '快照 v2', rightLabel: '快照 v3' })
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]!.left).toMatchObject({ fileId: 'f1', path: 'main.c' })
    expect(view.rows[0]!.right).toMatchObject({ fileId: 'f1', path: 'src/main.c', documentVersion: 4 })
    expect(view.rows[0]!.path).toBe('main.c')
    expect(view.changedCount).toBe(1)
  })

  it('同名不同实例不合并：路径相同、fileId 不同时是两条单侧行', () => {
    const view = buildVersionComparison('snapshots',
      versionSide('左侧快照', [versionFile({ fileId: 'old', path: 'main.c', text: 'old\n' })]),
      versionSide('右侧快照', [versionFile({ fileId: 'new', path: 'main.c', text: 'new\n' })]))
    expect(view.rows.map(r => [r.fileId, r.left?.fileId ?? null, r.right?.fileId ?? null]))
      .toEqual([['old', 'old', null], ['new', null, 'new']])
    expect(view.rows.every(r => r.path === 'main.c')).toBe(true)
    expect(view.changedCount).toBe(2)
  })

  it('只在单侧出现的 fileId 另一侧为 null，并计入 changedCount', () => {
    const view = buildVersionComparison('draft-confirmed',
      versionSide('本机草稿', [versionFile({ fileId: 'f1', text: 'same\n' }),
        versionFile({ fileId: 'f2', path: 'only-left.c' })]),
      versionSide('确认作品 v5', [versionFile({ fileId: 'f1', text: 'same\n', documentVersion: 5 }),
        versionFile({ fileId: 'f3', path: 'only-right.c', documentVersion: 5 })], 5))
    expect(view.source).toBe('draft-confirmed')
    expect(view.rows.map(r => r.fileId)).toEqual(['f1', 'f2', 'f3'])
    expect(view.rows[1]).toMatchObject({ fileId: 'f2', path: 'only-left.c', left: { path: 'only-left.c' }, right: null })
    expect(view.rows[2]).toMatchObject({ fileId: 'f3', path: 'only-right.c', left: null, right: { path: 'only-right.c' } })
    expect(view.changedCount).toBe(2)
  })

  it('行序稳定：左侧顺序优先，再接只在右侧出现的；重复调用结果一致', () => {
    const left = versionSide('左', [versionFile({ fileId: 'a' }), versionFile({ fileId: 'b' })])
    const right = versionSide('右', [versionFile({ fileId: 'c' }), versionFile({ fileId: 'b' }),
      versionFile({ fileId: 'a' }), versionFile({ fileId: 'd' })])
    const first = buildVersionComparison('snapshots', left, right)
    expect(first.rows.map(r => r.fileId)).toEqual(['a', 'b', 'c', 'd'])
    expect(buildVersionComparison('snapshots', left, right)).toEqual(first)
  })

  it('正文原样：BOM、CRLF、裸 CR、非 BMP 字符逐字不变，摘要与版本读数不被改写', () => {
    const bomCrlf = '\uFEFF#include <stdio.h>\r\nint main(void) {\r\n  return 0;\r\n}\r\n'
    const bareCr = 'section\rone\rtwo'
    const astral = '谱号 \u{1D11E} 与中文\n'
    const left = versionSide('左', [
      versionFile({ fileId: 'f1', text: bomCrlf, contentHash: 'hash-bom', documentVersion: 2 }),
      versionFile({ fileId: 'f2', text: astral, contentHash: 'hash-astral' }),
    ])
    const right = versionSide('右', [
      versionFile({ fileId: 'f1', text: bomCrlf, contentHash: 'hash-bom', documentVersion: 2 }),
      versionFile({ fileId: 'f2', text: bareCr, contentHash: 'hash-cr' }),
    ])
    const view = buildVersionComparison('snapshots', left, right)
    const bomRow = view.rows.find(r => r.fileId === 'f1')!
    expect(bomRow.left!.text).toBe(bomCrlf)
    expect(bomRow.right!.text).toBe(bomCrlf)
    expect(bomRow.left!.contentHash).toBe('hash-bom')
    expect(bomRow.left!.documentVersion).toBe(2)
    const crRow = view.rows.find(r => r.fileId === 'f2')!
    expect(crRow.left!.text).toBe('谱号 \uD834\uDD1E 与中文\n')
    expect(crRow.right!.text).toBe(bareCr)
    expect(crRow.left!.contentHash).toBe('hash-astral')
    // 投影不改源：调用方传进来的那一份还是原样
    expect(left.files[0]!.text).toBe(bomCrlf)
    expect(view.changedCount).toBe(1)
  })

  it('changedCount 只统计「都有且不同」加「单侧」，正文相同（含仅摘要不同）的行不计', () => {
    const view = buildVersionComparison('snapshots',
      versionSide('左', [versionFile({ fileId: 'a', text: 'x\n', contentHash: 'left-hash' }),
        versionFile({ fileId: 'b', text: 'same\n' }), versionFile({ fileId: 'c', text: 'y\n' })]),
      versionSide('右', [versionFile({ fileId: 'a', text: 'x\n', contentHash: 'right-hash' }),
        versionFile({ fileId: 'b', text: 'same\n' })]))
    expect(view.rows.map(r => r.fileId)).toEqual(['a', 'b', 'c'])
    expect(view.rows[0]!.left!.contentHash).not.toBe(view.rows[0]!.right!.contentHash)
    expect(view.changedCount).toBe(1)
  })

  it('sideFromSnapshot：label 与 revision 取快照 revision，files 映射成 VersionFile', () => {
    const snapshot: SnapshotView = {
      snapshotId: 'snap-1', attemptId: 'attempt-1', activityVersionId: 'v1', workspaceRevision: 7,
      hashFormat: 'sha256-manifest-v1', hash: 'manifest-hash', createdAt: '2026-10-12T00:00:00.000Z',
      files: [{ fileId: 'f1', path: 'main.c', documentVersion: 3, contentHash: 'hash-3', text: '\uFEFFx\r\ny' }],
    }
    const result = sideFromSnapshot(snapshot)
    expect(result.label).toBe('快照 v7')
    expect(result.revision).toBe(7)
    expect(result.files).toEqual([{ fileId: 'f1', path: 'main.c', documentVersion: 3, contentHash: 'hash-3', text: '\uFEFFx\r\ny' }])
    // 快照本身只读：映射不改快照里的读数与正文
    expect(snapshot.files[0]!.text).toBe('\uFEFFx\r\ny')
  })
})
