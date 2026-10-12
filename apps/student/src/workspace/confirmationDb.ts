import { clientFileKey, scopeKey, type DraftRecord, type InstanceRecord } from '../lib/draftStore'
import { sameWorkspace } from './confirmation'
import { openWorkspaceDb } from './draftDb'
import type { CommandContext, FrozenCommand, OutboxRecord } from './frozenCommand'
import type { ConfirmedWorkspace, Receipt, SnapshotView } from './workspaceContracts'
import { PREP_BUILD } from './mode'

export type AckStage = 'mapping' | 'head' | 'drafts' | 'outbox'
let abortStage: AckStage | null = null
/** 仅开发准备构建允许的事务故障；真实/生产产物不启用。 */
export function setConfirmationAbortStage(stage: AckStage | null): void {
  if (PREP_BUILD) abortStage = stage
}
const draftScope = (c: CommandContext) => ({ mode: c.mode, account: c.userId!, attemptKey: c.attemptId! })
const headKey = (c: CommandContext) => `head:${scopeKey(draftScope(c))}`
const referenceKey = (c: CommandContext) => `attempt:${c.mode}\0${c.userId}\0${c.assignmentId}\0${c.scenarioId ?? ''}`
const sameOwner = (a: CommandContext, b: CommandContext) => a.mode === b.mode && a.userId === b.userId && a.assignmentId === b.assignmentId &&
  (a.mode !== 'preparation' || a.scenarioId === b.scenarioId)
const sameAuthority = (a: CommandContext, b: CommandContext) => sameOwner(a, b) &&
  a.trustedRecoveryGeneration === b.trustedRecoveryGeneration && a.preparationEpoch === b.preparationEpoch
export const sameGeneration = (a: CommandContext, b: CommandContext) => sameAuthority(a, b) && a.attemptId === b.attemptId
interface HeadRecord { key: string; context: CommandContext; workspace: ConfirmedWorkspace; retiredGenerations?: string[] }
// 代际是不可排序的 opaque 值；记录已被权威重读替代的代际，防止旧标签 GET 再安装它。
const generationKey = (c: CommandContext) => JSON.stringify([c.trustedRecoveryGeneration, c.preparationEpoch, c.scenarioId ?? null])
interface RefRecord { key: string; context: CommandContext; attemptId: string; retiredGenerations?: string[] }
export interface LocalConfirmationState {
  workspace: ConfirmedWorkspace | null; instances: InstanceRecord[]; drafts: DraftRecord[]; commands: OutboxRecord[]
  candidates: Array<{ id?: number; clientFileKey: string; text: string; reason: string; createdAt: number }>
}

/** 所有回调只在 IDB request 事件内运行；无外部 await 导致事务提前自动提交。 */
function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode,
  work: (tx: IDBTransaction, result: (value: T) => void, safe: (fn: () => void) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    let value: T, failure: unknown
    const safe = (fn: () => void) => {
      try { fn() } catch (e) { failure = e; tx.abort() }
    }
    tx.oncomplete = () => resolve(value)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('本机确认事务中断'))
    tx.onerror = () => { failure ??= tx.error }
    safe(() => work(tx, v => { value = v }, safe))
  })
}
function reads(tx: IDBTransaction, entries: Array<[string, string | null]>, safe: (fn: () => void) => void,
  done: (values: unknown[]) => void): void {
  const values: unknown[] = [], total = entries.length
  let remaining = total
  entries.forEach(([store, key], index) => {
    const request = key === null ? tx.objectStore(store).getAll() : tx.objectStore(store).get(key)
    request.onsuccess = () => safe(() => {
      values[index] = request.result
      if (--remaining === 0) done(values)
    })
  })
}
function writeRows(tx: IDBTransaction, rows: Array<[string, unknown]>, safe: (fn: () => void) => void, done: () => void): void {
  const next = (index: number) => {
    if (index === rows.length) { done(); return }
    const [store, value] = rows[index]!
    const request = tx.objectStore(store).put(value)
    request.onsuccess = () => safe(() => next(index + 1))
  }
  next(0)
}
function chooseHead(current: HeadRecord | undefined, c: CommandContext, incoming: ConfirmedWorkspace): ConfirmedWorkspace {
  if (!current || !sameGeneration(current.context, c)) return incoming
  if (current.workspace.workspaceRevision > incoming.workspaceRevision) return current.workspace
  if (current.workspace.workspaceRevision === incoming.workspaceRevision && !sameWorkspace(current.workspace, incoming)) throw new Error('同版本确认清单冲突，需要重读')
  return incoming
}

/** durable outbox/序号/确认的公开事务访问面；与 02 共用唯一 DB 连接。 */
export const confirmationRepository = {
  async reserveSeq(c: CommandContext, clientId: string): Promise<number> {
    const db = await openWorkspaceDb(), key = `seq:${scopeKey(draftScope(c))}\0${clientId}`
    return transaction(db, ['metadata'], 'readwrite', (tx, result, safe) => {
      reads(tx, [['metadata', key]], safe, ([old]) => {
        const seq = ((old as { seq: number } | undefined)?.seq ?? 0) + 1
        if (!Number.isSafeInteger(seq)) throw new Error('本机序号已耗尽')
        tx.objectStore('metadata').put({ key, seq })
        result(seq)
      })
    })
  },
  async persist(command: FrozenCommand, valid: () => boolean): Promise<void> {
    const db = await openWorkspaceDb()
    await transaction<void>(db, ['outbox', 'metadata'], 'readwrite', (tx, result, safe) => {
      reads(tx, [['outbox', command.commandKey], ['metadata', headKey(command.context)], ['metadata', referenceKey(command.context)]], safe, ([old, head, ref]) => {
        if (!valid()) throw new Error('工作区上下文已失效')
        if (head && !sameGeneration((head as HeadRecord).context, command.context)) throw new Error('另一标签已切换受信代际，需要重新读取')
        if (ref && !sameAuthority((ref as RefRecord).context, command.context)) throw new Error('另一标签已切换受信代际，需要重新读取')
        if (old && JSON.stringify((old as OutboxRecord).wireJson) !== JSON.stringify(command.wireJson)) throw new Error('原命令不能修改')
        if (!old) tx.objectStore('outbox').put({ ...command, state: 'pending' } satisfies OutboxRecord)
        result(undefined)
      })
    })
  },
  async command(key: string): Promise<OutboxRecord | null> {
    return transaction(await openWorkspaceDb(), ['outbox'], 'readonly', (tx, result, safe) =>
      reads(tx, [['outbox', key]], safe, ([value]) => result((value as OutboxRecord | undefined) ?? null)))
  },
  async commands(c: CommandContext): Promise<OutboxRecord[]> {
    return transaction(await openWorkspaceDb(), ['outbox'], 'readonly', (tx, result, safe) =>
      reads(tx, [['outbox', null]], safe, ([value]) => result((value as OutboxRecord[]).filter(r => sameOwner(r.context, c)))))
  },
  async reference(c: CommandContext): Promise<{ attemptId: string | null; changed: boolean }> {
    return transaction(await openWorkspaceDb(), ['metadata'], 'readonly', (tx, result, safe) =>
      reads(tx, [['metadata', referenceKey(c)]], safe, ([value]) => {
        const ref = value as RefRecord | undefined
        const changed = !!ref && (ref.context.trustedRecoveryGeneration !== c.trustedRecoveryGeneration || ref.context.preparationEpoch !== c.preparationEpoch)
        result({ attemptId: changed ? null : ref?.attemptId ?? null, changed })
      }))
  },
  async isCurrentAuthority(c: CommandContext): Promise<boolean> {
    return transaction(await openWorkspaceDb(), ['metadata'], 'readonly', (tx, result, safe) =>
      reads(tx, [['metadata', headKey(c)], ['metadata', referenceKey(c)]], safe, ([h, r]) => {
        const head = h as HeadRecord | undefined, ref = r as RefRecord | undefined
        result((!head || sameGeneration(head.context, c)) && (!ref || sameAuthority(ref.context, c)) &&
          !ref?.retiredGenerations?.includes(generationKey(c)))
      }))
  },
  async claim(key: string, owner: string, valid: () => boolean, now = Date.now()): Promise<OutboxRecord> {
    return transaction(await openWorkspaceDb(), ['outbox', 'metadata'], 'readwrite', (tx, result, safe) =>
      reads(tx, [['outbox', key]], safe, ([value]) => {
        if (!valid()) throw new Error('工作区上下文已失效')
        const row = value as OutboxRecord | undefined
        if (!row) throw new Error('原命令没有落盘，禁止发送')
        if (row.lease && row.lease.owner !== owner && row.lease.until > now) throw new Error('另一标签正在核对原请求，请稍后重试')
        reads(tx, [['metadata', headKey(row.context)], ['metadata', referenceKey(row.context)]], safe, ([head, ref]) => {
          if (!valid()) throw new Error('工作区上下文已失效')
          if (head && !sameGeneration((head as HeadRecord).context, row.context)) throw new Error('另一标签已切换受信代际，需要重新读取')
          if (ref && !sameAuthority((ref as RefRecord).context, row.context)) throw new Error('另一标签已切换受信代际，需要重新读取')
          const leased = { ...row, lease: { owner, until: now + 30_000 } }
          tx.objectStore('outbox').put(leased); result(leased)
        })
      }))
  },
  async release(key: string, owner: string): Promise<void> {
    await transaction<void>(await openWorkspaceDb(), ['outbox'], 'readwrite', (tx, result, safe) =>
      reads(tx, [['outbox', key]], safe, ([value]) => {
        const row = value as OutboxRecord | undefined
        if (row?.lease?.owner === owner) { delete row.lease; tx.objectStore('outbox').put(row) }
        result(undefined)
      }))
  },
  async read(c: CommandContext): Promise<LocalConfirmationState> {
    return transaction(await openWorkspaceDb(), ['metadata', 'instances', 'drafts', 'outbox', 'candidates'], 'readonly', (tx, result, safe) =>
      reads(tx, [['metadata', headKey(c)], ['instances', null], ['drafts', null], ['outbox', null], ['candidates', null]], safe, ([h, i, d, o, candidates]) => {
        const head = h as HeadRecord | undefined, prefix = `${scopeKey(draftScope(c))}\0`
        result({ workspace: head && sameGeneration(head.context, c) ? head.workspace : null,
          instances: (i as InstanceRecord[]).filter(r => r.clientFileKey.startsWith(prefix)),
          drafts: (d as DraftRecord[]).filter(r => r.clientFileKey.startsWith(prefix)),
          commands: (o as OutboxRecord[]).filter(r => sameOwner(r.context, c)),
          candidates: (candidates as LocalConfirmationState['candidates']).filter(r => r.clientFileKey.startsWith(prefix)) })
      }))
  },
  async installHead(c: CommandContext, incoming: ConfirmedWorkspace, valid: () => boolean): Promise<ConfirmedWorkspace> {
    return transaction(await openWorkspaceDb(), ['metadata'], 'readwrite', (tx, result, safe) =>
      reads(tx, [['metadata', headKey(c)], ['metadata', referenceKey(c)]], safe, ([value, r]) => {
        if (!valid()) throw new Error('工作区上下文已失效')
        const old = value as HeadRecord | undefined, ref = r as RefRecord | undefined
        const retiredGenerations = [...new Set([...(old?.retiredGenerations ?? []), ...(ref?.retiredGenerations ?? [])])]
        if (retiredGenerations.includes(generationKey(c))) throw new Error('此代际已被另一标签的权威读取替代，需要重新读取')
        const retired = [...new Set([...retiredGenerations,
          ...(old && !sameGeneration(old.context, c) ? [generationKey(old.context)] : []),
          ...(ref && !sameAuthority(ref.context, c) ? [generationKey(ref.context)] : [])])]
        const workspace = chooseHead(old, c, incoming)
        tx.objectStore('metadata').put({ key: headKey(c), context: c, workspace, retiredGenerations: retired } satisfies HeadRecord)
        tx.objectStore('metadata').put({ key: referenceKey(c), context: c, attemptId: c.attemptId!, retiredGenerations: retired } satisfies RefRecord)
        result(workspace)
      }))
  },
  async acknowledge(command: FrozenCommand, receipt: Receipt, incoming: ConfirmedWorkspace | null,
    mappings: Record<string, string>, snapshot: SnapshotView | null, valid: () => boolean): Promise<ConfirmedWorkspace | null> {
    const stores = ['outbox', 'metadata', 'confirmed', 'instances', 'drafts', 'candidates']
    return transaction(await openWorkspaceDb(), stores, 'readwrite', (tx, result, safe) => {
      const c = command.context
      // 首次创建尚未绑定 Attempt：以已核验回执的目标读取持久头，不能查 null 槽绕过代际围栏。
      const ackContext = command.kind === 'attempt.create' ? { ...c, attemptId: (receipt.result as { attemptId: string }).attemptId } : c
      reads(tx, [['outbox', command.commandKey], ['metadata', headKey(ackContext)], ['instances', null], ['drafts', null], ['metadata', referenceKey(c)]], safe, ([o, h, i, d, ref]) => {
        const original = o as OutboxRecord | undefined
        if (!original || original.wireJson !== command.wireJson || original.requestHash !== command.requestHash) throw new Error('原命令本机记录不符')
        if (original.receipt && (original.receipt.receiptId !== receipt.receiptId || original.receipt.requestHash !== receipt.requestHash ||
          JSON.stringify(original.receipt.result) !== JSON.stringify(receipt.result))) throw new Error('同一原命令回执冲突')
        // 失效 ACK 只能记录原隔离事实；不更新当前头、映射或草稿。
        const oldHead = h as HeadRecord | undefined
        if (!valid() || (oldHead && !sameGeneration(oldHead.context, ackContext)) || (ref && !sameAuthority((ref as RefRecord).context, c))) {
          tx.objectStore('outbox').put({ ...original, state: 'historical', receipt, lease: undefined })
          result(null); return
        }
        const workspace = incoming ? chooseHead(oldHead, c, incoming) : null
        const historical = !!incoming && !!workspace && workspace.workspaceRevision > incoming.workspaceRevision
        const instances = i as InstanceRecord[], drafts = d as DraftRecord[]
        const instanceRows: Array<[string, unknown]> = [], draftRows: Array<[string, unknown]> = []
        for (const [localId, serverId] of Object.entries(mappings)) {
          const source = command.drafts.find(f => f.localId === localId)
          const authority = workspace?.files.find(f => f.fileId === serverId && f.path === source?.path)
          if (!source || !authority) throw new Error('迟到创建映射不在当前权威清单，需要重读')
          const key = clientFileKey(draftScope(c), localId), instance = instances.find(f => f.clientFileKey === key)
          if (instance && instance.fileId !== localId && instance.fileId !== serverId) throw new Error('文件实例映射冲突')
          instanceRows.push(['instances', { ...instance, clientFileKey: key, fileId: serverId, path: authority.path,
            lifecycle: authority.lifecycle, createdAt: instance?.createdAt ?? command.createdAt } satisfies InstanceRecord])
          const draft = drafts.find(f => f.clientFileKey === key)
          // 只改关联，不改最新正文/修订；保存后的新编辑及候选全部保留。
          if (draft) draftRows.push(['drafts', { ...draft, fileId: serverId }])
        }
        const checkpoint = (stage: AckStage, next: () => void) => {
          if (!valid()) throw new Error('工作区上下文已失效')
          if (abortStage === stage) { abortStage = null; throw new Error(`本机确认事务中断：${stage}`) }
          next()
        }
        writeRows(tx, instanceRows, safe, () => checkpoint('mapping', () => {
          const rows: Array<[string, unknown]> = []
          if (workspace) {
            rows.push(['metadata', { key: headKey(c), context: c, workspace, retiredGenerations: oldHead?.retiredGenerations } satisfies HeadRecord])
            for (const file of workspace.files) {
              const localId = Object.keys(mappings).find(id => mappings[id] === file.fileId) ??
                instances.find(f => f.fileId === file.fileId && f.clientFileKey.startsWith(`${scopeKey(draftScope(c))}\0`))?.clientFileKey.split('\0').at(-1) ?? file.fileId
              rows.push(['confirmed', { clientFileKey: clientFileKey(draftScope(c), localId), context: c, ...file }])
            }
          }
          if (command.kind === 'attempt.create') rows.push(['metadata', { key: referenceKey(c), context: ackContext,
            attemptId: ackContext.attemptId!, retiredGenerations: (ref as RefRecord | undefined)?.retiredGenerations } satisfies RefRecord])
          if (snapshot) rows.push(['metadata', { key: `snapshot:${headKey(c)}:${snapshot.snapshotId}`, context: c, snapshot }])
          writeRows(tx, rows, safe, () => checkpoint('head', () =>
            writeRows(tx, draftRows, safe, () => checkpoint('drafts', () =>
              writeRows(tx, [['outbox', { ...original, state: historical ? 'historical' : 'confirmed', receipt, lease: undefined } satisfies OutboxRecord]], safe, () =>
                checkpoint('outbox', () => result(workspace)))))))
        }))
      })
    })
  },
}
