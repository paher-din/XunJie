import { describe, expect, it } from 'vitest'
import type { ProjectFile } from '../bridge/types'
import type { ConfirmedWorkspace, SnapshotView } from './workspaceContracts'
import {
  confirmedSide, defaultVersionPair, draftSide, instanceKeys, snapshotSide, versionSourceOptions,
} from './versionSources'

/**
 * 05：比较来源装配的身份规则。
 *
 * 这些用例守的是同一条底线——**路径不是身份**：同名重建出的新实例不能被当成旧引用，
 * 映射不到服务身份的文件必须单列。以及「比较不改摘要」：正文与 contentHash 逐字透传。
 */

const file = (over: Partial<ProjectFile> & { fileId: string }): ProjectFile => ({
  path: 'main.c', lifecycle: 'active', confirmed: null, ...over,
})

const workspace = (revision: number, files: ConfirmedWorkspace['files']): ConfirmedWorkspace =>
  ({ attemptId: 'attempt', workspaceRevision: revision, files })

const snapshot = (id: string, revision: number, createdAt: string, files: SnapshotView['files']): SnapshotView =>
  ({ snapshotId: id, attemptId: 'attempt', activityVersionId: 'activity', workspaceRevision: revision,
    hashFormat: 'sha256-manifest-v1', hash: 'a'.repeat(64), createdAt, files })

describe('instanceKeys / 两侧身份对齐', () => {
  it('服务 fileId 映射到本机实例 ID；没有映射的保持服务身份，不按路径顶替', () => {
    const keys = instanceKeys([
      file({ fileId: 'local-1', serverFileId: 'srv-1', path: 'main.c' }),
      file({ fileId: 'local-2', serverFileId: 'srv-2', path: 'main.c', lifecycle: 'recycled' }),
      file({ fileId: 'local-3', path: 'notes.c' }),
    ])
    expect(keys.get('srv-1')).toBe('local-1')
    expect(keys.get('srv-2')).toBe('local-2')
    expect(keys.has('local-3')).toBe(false)

    // 快照里的 srv-1 / srv-2 换成 local-1 / local-2；第三份快照文件没有本机映射，保持服务身份单列
    const side = snapshotSide(snapshot('snap', 3, '2026-10-12T00:00:00.000Z', [
      { fileId: 'srv-1', path: 'main.c', documentVersion: 2, contentHash: 'h1', text: 'old\n' },
      { fileId: 'srv-2', path: 'main.c', documentVersion: 1, contentHash: 'h2', text: 'recycled\n' },
      { fileId: 'srv-9', path: 'gone.c', documentVersion: 1, contentHash: 'h9', text: 'gone\n' },
    ]), keys)
    expect(side.files.map(f => f.fileId)).toEqual(['local-1', 'local-2', 'srv-9'])
    expect(side.label).toBe('快照 v3')
    expect(side.revision).toBe(3)
    // 正文与摘要逐字透传：装配不重算、不规范化
    expect(side.files[0]!.text).toBe('old\n')
    expect(side.files[0]!.contentHash).toBe('h1')
  })

  it('确认作品侧含已回收实例（回收是状态，不是消失），身份同样换到本机键空间', () => {
    const keys = instanceKeys([file({ fileId: 'local-1', serverFileId: 'srv-1' })])
    const side = confirmedSide(workspace(7, [
      { fileId: 'srv-1', attemptId: 'attempt', path: 'main.c', documentVersion: 3, contentHash: 'h', text: 'x', lifecycle: 'recycled' },
      { fileId: 'srv-2', attemptId: 'attempt', path: 'main.c', documentVersion: 1, contentHash: 'h2', text: 'y', lifecycle: 'active' },
    ]), keys)
    expect(side.label).toBe('确认作品 v7')
    expect(side.files.map(f => f.fileId)).toEqual(['local-1', 'srv-2'])
    expect(side.files[1]!.path).toBe('main.c')
    // 回收状态只在「权威事实」这一侧表达：比较要能说明实例被回收了，而不是看起来没动过
    expect(side.files.map(f => f.lifecycle)).toEqual(['recycled', 'active'])
  })

  it('本机草稿侧：未确认草稿没有服务端摘要，版本读数是它基于的确认版本', () => {
    const side = draftSide([
      file({ fileId: 'local-1', serverFileId: 'srv-1', confirmed: { text: 'a', version: 2, lifecycle: 'active' } }),
      file({ fileId: 'local-new', path: 'new.c' }),
    ], id => id === 'local-1' ? 'a+b' : '')
    expect(side.revision).toBeNull()
    expect(side.files.map(f => f.documentVersion)).toEqual([2, null])
    expect(side.files.every(f => f.contentHash === null)).toBe(true)
    expect(side.files[0]!.text).toBe('a+b')
  })
})

describe('versionSourceOptions / defaultVersionPair', () => {
  const options = () => versionSourceOptions({
    snapshots: [
      snapshot('snap-b', 5, '2026-10-12T02:00:00.000Z', [{ fileId: 'srv-1', path: 'main.c', documentVersion: 2, contentHash: 'h', text: 'b' }]),
      snapshot('snap-a', 3, '2026-10-12T01:00:00.000Z', [{ fileId: 'srv-1', path: 'main.c', documentVersion: 1, contentHash: 'h', text: 'a' }]),
    ],
    workspace: workspace(5, [{ fileId: 'srv-1', attemptId: 'attempt', path: 'main.c', documentVersion: 2, contentHash: 'h', text: 'b', lifecycle: 'active' }]),
    files: [file({ fileId: 'local-1', serverFileId: 'srv-1', confirmed: { text: 'b', version: 2, lifecycle: 'active' } })],
    draftText: () => 'c',
  })

  it('来源按本机草稿、确认作品、快照（createdAt 升序）排列', () => {
    expect(options().map(o => o.id)).toEqual(['draft', 'confirmed', 'snapshot:snap-a', 'snapshot:snap-b'])
  })

  it('两个以上快照默认比最近两版；只有一个快照时比「那一版 × 本机草稿」；没有快照时比「确认作品 × 本机草稿」', () => {
    expect(defaultVersionPair(options())).toEqual({ left: 'snapshot:snap-a', right: 'snapshot:snap-b' })
    expect(defaultVersionPair(options().filter(o => o.id !== 'snapshot:snap-a')))
      .toEqual({ left: 'snapshot:snap-b', right: 'draft' })
    expect(defaultVersionPair(options().filter(o => !o.id.startsWith('snapshot:'))))
      .toEqual({ left: 'confirmed', right: 'draft' })
  })
})
