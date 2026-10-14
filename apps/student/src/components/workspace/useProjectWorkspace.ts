import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectAccess, ProjectFile, ProjectSeed } from '../../bridge/types'
import type { FrozenDraft } from '../../workspace/frozenCommand'
import type { CodeDraft } from '../../workspace/tutoringObject'
import {
  clientFileKey,
  scopeKey,
  type DraftRepository,
  type DraftScope,
} from '../../lib/draftStore'
import {
  createLimitProblem,
  pathProblem,
  utf8Bytes,
  type CreateOutcome,
  type WorkspaceUsage,
} from '../../lib/projectFiles'
import {
  activeFiles,
  mergedLifecycle,
  recycleProblem,
  restoreProblem,
  type LifecycleProblem,
} from '../../workspace/fileLifecycle'

/**
 * 一个任务的多文件作品工作区：文件实例、已打开标签、活动文件、本机草稿与草稿保护状态。
 *
 * 三条边界是设计的一部分，正式版必须保持：
 * 1. **草稿与确认作品分开**：`confirmed` 是已确认正文与版本，草稿是另一份值；
 *    「未确认修改」由两者比较得出，不把本机草稿说成已保存的作品。
 * 2. **身份是 fileId，不是路径**：路径可以重复出现在不同实例上（回收后同名重建），
 *    标签、model 与草稿都按 fileId 关联，改名或同名新建都不串内容；
 *    落库身份是 模式/账号/Attempt/实例 组合的 clientFileKey。
 * 3. **保护状态只反映实际写入**：写事务 complete 才显示「本机草稿已保护」；失败保留内存正文，
 *    并明确说明刷新会丢失；draftRevision 冲突时败方正文留作冲突候选，不覆盖赢方。
 */

export type ProtectionStatus = 'saving' | 'protected' | 'failed'

/** 写入节流：连续输入只在停下之后落一次盘。 */
const SAVE_DEBOUNCE_MS = 400

export interface ProjectWorkspace {
  loaded: boolean
  files: ProjectFile[]
  openFiles: ProjectFile[]
  activeFile: ProjectFile | null
  access: ProjectAccess
  confirmedRevision: number
  protection: { status: ProtectionStatus; reason: string | null }
  /** 有未确认内容的文件数（含本机新建，以及未确认的回收/恢复）。 */
  unconfirmedCount: number
  /** 「确认保存」时一并发出的生命周期意图数（未确认的回收/恢复）。 */
  lifecyclePendingCount: number
  usage: WorkspaceUsage
  draftText: (fileId: string) => string
  /** 原文/实例/确认版本的只读复制，不触发保护、保存或快照。 */
  readCodeDraft: (fileId: string) => CodeDraft | null
  isCreated: (file: ProjectFile) => boolean
  isDirty: (file: ProjectFile) => boolean
  open: (fileId: string) => void
  closeTab: (fileId: string) => void
  create: (path: string, text: string) => CreateOutcome
  setDraft: (fileId: string, text: string) => void
  /** 冻结点击时原文并先保护草稿；失败不允许发送业务命令。 */
  prepareSave: () => Promise<FrozenDraft[]>
  /** 04A：本机草稿 CAS 冲突尚未解决的文件实例。 */
  conflictedFileIds: string[]
  /** 04A：库中（另一处写入的赢方）草稿正文；没有落库记录时为 null。 */
  loadStoredDraftText: (fileId: string) => Promise<string | null>
  /**
   * 04A：明确处理本机草稿冲突。`mine` 用当前内存正文对库中最新修订重新 CAS（期间别处又写入
   * 则失败并保留新候选）；`stored` 载入库中正文。两种选择都不会覆盖成第三份正文。
   */
  resolveConflict: (fileId: string, choice: 'mine' | 'stored') => Promise<'resolved' | 'conflict-again'>
  /** 学生明确回收这个实例（本机意图；随下一次确认保存发出）。 */
  recycle: (fileId: string) => void
  /** 学生明确恢复这个实例；路径被别的实例占用时拒绝并返回占用者，不做任何改动。 */
  restore: (fileId: string) => { ok: true } | { ok: false; problem: LifecycleProblem; occupant: ProjectFile | null }
}

export function useProjectWorkspace(
  seed: ProjectSeed | null,
  repo: DraftRepository,
  scope: DraftScope | null,
): ProjectWorkspace {
  // seed 为 null（这门课没有代码工具包）时返回一个惰性工作区：钩子照样跑，动作一律无效
  const key = seed === null || scope === null ? null : scopeKey(scope)
  const [loaded, setLoaded] = useState(false)
  const loadedKey = useRef<string | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [openFileIds, setOpenFileIds] = useState<string[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [protection, setProtection] = useState<{ status: ProtectionStatus; reason: string | null }>({
    status: 'protected',
    reason: null,
  })
  // 04A：conflicts ref 的可见镜像，驱动编辑区上方的草稿冲突条
  const [conflictIds, setConflictIds] = useState<string[]>([])

  // 每个实例当前已知的库中修订；写入带期望修订做 CAS，成功才推进
  const revisions = useRef<Record<string, number | null>>({})
  // 已留过候选的败方正文：同一份字不重复堆候选行
  const lastCandidate = useRef<Record<string, string>>({})
  // 04A：CAS 冲突锁存到学生在冲突条明确选择为止，不能吸收赢家修订后重试覆写。
  const conflicts = useRef(new Set<string>())
  // 写入序号：只有最新一次写入的结果才能改可见状态，迟到的成功/失败不覆盖当前判断
  const saveSeq = useRef(0)
  const lastWritten = useRef<{ ui: string; drafts: Record<string, string> } | null>(null)
  // 只有学生真的动过内容或标签才落盘：进入工作区读取本身不产生「正在保护」的假状态
  const pendingWrite = useRef(false)
  const seedRef = useRef(seed)
  const scopeRef = useRef(scope)
  const liveKey = useRef(key)
  liveKey.current = key
  const writing = useRef<Promise<unknown>>(Promise.resolve())

  useEffect(() => {
    seedRef.current = seed
    scopeRef.current = scope
  })

  /* 载入：确认作品来自 seed，本机草稿来自新库；两边按 fileId 对齐，对不上的一律丢弃 */
  useEffect(() => {
    loadedKey.current = null
    conflicts.current = new Set()
    lastCandidate.current = {}
    setConflictIds([])
    if (key === null) return
    let cancelled = false
    setLoaded(false)
    void (async () => {
      const current = seedRef.current
      const currentScope = scopeRef.current
      if (current === null || currentScope === null) return
      const failLoad = (error: unknown) => {
        // 读不出本机草稿不等于没有作品：从确认作品重新开始，并如实显示未保护
        revisions.current = {}
        lastWritten.current = { ui: JSON.stringify(uiRecordOf(null, [], current.files)), drafts: {} }
        setFiles(current.files)
        setDrafts({})
        setOpenFileIds(current.files.slice(0, 1).map((f) => f.fileId))
        setActiveFileId(current.files[0]?.fileId ?? null)
        pendingWrite.current = false
        setProtection({
          status: 'failed',
          reason: `本机草稿读取失败：${error instanceof Error ? error.message : String(error)}`,
        })
        loadedKey.current = key
        setLoaded(true)
      }
      let storedUi: Awaited<ReturnType<DraftRepository['loadUi']>> = null
      try {
          storedUi = await repo.loadUi(key)
          if (cancelled) return
        const created: ProjectFile[] = (storedUi?.created ?? []).map((item) => ({
          fileId: item.fileId,
          path: item.path,
          lifecycle: 'active',
          confirmed: null,
        }))
        const known = new Set(current.files.map((f) => f.fileId))
        // 先复制一层再改生命周期：seed 的 file 对象属于上游，载入不能就地改写它。
        const merged: ProjectFile[] = [
          ...current.files.map((f) => ({ ...f })),
          ...created.filter((f) => !known.has(f.fileId)),
        ]

        const nextDrafts: Record<string, string> = {}
        const nextRevisions: Record<string, number | null> = {}
        const writtenDrafts: Record<string, string> = {}
        for (const file of merged) {
          const instanceKey = clientFileKey(currentScope, file.fileId)
          // 这个实例的生命周期以本机记录为准（学生明确表达过的意图）；没有本机记录才用权威 head 的值。
          const instance = await repo.loadInstance(instanceKey)
          if (cancelled) return
          if (instance) file.lifecycle = instance.lifecycle
          const record = await repo.loadDraft(instanceKey)
          if (cancelled) return
          if (record === null) continue
          nextDrafts[file.fileId] = record.text
          nextRevisions[file.fileId] = record.draftRevision
          writtenDrafts[file.fileId] = record.text
        }
        const ids = new Set(merged.map((f) => f.fileId))
        const open = (storedUi?.openFileIds ?? []).filter((id) => ids.has(id))
        const active = storedUi?.activeFileId && open.includes(storedUi.activeFileId) ? storedUi.activeFileId : null

        revisions.current = nextRevisions
        lastWritten.current = { ui: JSON.stringify(uiRecordOf(active, open, merged)), drafts: writtenDrafts }
        setFiles(merged)
        setDrafts(nextDrafts)
        // 首次进入没有本机记录时打开第一个文件，其余从「文件」列表里取
        setOpenFileIds(open.length > 0 ? open : merged.slice(0, 1).map((f) => f.fileId))
        setActiveFileId(active ?? (open.length > 0 ? open[0] : (merged[0]?.fileId ?? null)))
        pendingWrite.current = false
        setProtection({ status: 'protected', reason: null })
        loadedKey.current = key
        setLoaded(true)
      } catch (error: unknown) {
        if (!cancelled) failLoad(error)
      }
    })()
    return () => {
      cancelled = true
    }
    // scope 以 scopeKey 字符串进依赖：页面每次渲染的新对象不能触发重读（重读会冲掉刚建的实例）
  }, [key, seed?.taskId, repo])

  /**
   * 同一 Attempt 的权威确认头推进只更新确认基线/映射，保留较新草稿和已打开 model。
   *
   * 生命周期取哪一侧取决于**权威值有没有变**，不取决于本机记过什么：
   * - 权威值变了（另一标签回收/恢复并确认，或本机这次确认刚落地）：以权威为准。否则本机残留的旧意图
   *   会把别处刚生效的变更顶回去，学生按「确认保存」就会静默把它撤销；
   * - 权威值没变：保留本页正在表达的生命周期。学生点过回收/恢复但本机记录还没写完的窗口里，
   *   这次 head 推进读到的仍是旧权威，不能拿它把意图抹掉。
   */
  useEffect(() => {
    if (!loaded || !seed) return
    setFiles(old => {
      const before = new Map(old.map(f => [f.fileId, f]))
      // 权威清单里没有、且从未确认过的本机实例（草稿与未发出的回收/恢复意图）继续保留在列表里
      return [...seed.files, ...old.filter(f => f.confirmed === null && !seed.files.some(s => s.fileId === f.fileId))]
        .map(f => ({ ...f, lifecycle: mergedLifecycle(before.get(f.fileId), f) }))
    })
  }, [loaded, seed?.files])

  const draftText = useCallback(
    (fileId: string): string => {
      if (Object.hasOwn(drafts, fileId)) return drafts[fileId]!
      return files.find((f) => f.fileId === fileId)?.confirmed?.text ?? ''
    },
    [drafts, files],
  )

  const access = useMemo<ProjectAccess>(
    () => seed?.access ?? { kind: 'read-only', reason: '这门课还没有接入代码工具包' },
    [seed?.access],
  )

  const usage = useMemo<WorkspaceUsage>(() => {
    // 只统计期望 active 的实例：回收意图（含待确认）不占 active 名额，也不该污染读数。
    const active = activeFiles(files)
    return {
      activeFiles: active.length,
      activeBytes: active.reduce((sum, f) => sum + utf8Bytes(draftText(f.fileId)), 0),
    }
  }, [files, draftText])

  const lifecyclePendingCount = useMemo(
    () => files.filter((f) => f.confirmed !== null && f.confirmed.lifecycle !== f.lifecycle).length,
    [files],
  )

  const unconfirmedCount = useMemo(
    () => files.filter((f) =>
      // 期望 active 的正文意图：本机新建，或草稿与确认正文不同。
      (f.lifecycle === 'active' && (f.confirmed === null || draftText(f.fileId) !== f.confirmed.text)) ||
      // 未确认的回收/恢复：期望生命周期与最近确认不一致。已回收且与确认一致的不算。
      (f.confirmed !== null && f.confirmed.lifecycle !== f.lifecycle),
    ).length,
    [files, draftText],
  )

  const protect = useCallback(async (): Promise<FrozenDraft[]> => {
    const currentScope = scopeRef.current
    if (!key || !currentScope || !loaded) throw new Error('本机草稿尚未载入')
    // 生命周期意图也随这次确认发出：回收/恢复的草稿同样要有基线，恢复后才谈得上继续改。
    const captured = files.map(f => ({
      localId: f.fileId, serverFileId: f.serverFileId ?? (f.confirmed ? f.fileId : undefined),
      path: f.path, text: draftText(f.fileId), draftRevision: revisions.current[f.fileId] ?? null,
      lifecycle: f.lifecycle,
    }))
    const ui = uiRecordOf(activeFileId, openFileIds, files)
    const serialized = JSON.stringify(ui), seq = ++saveSeq.current
    const loadConflicts = conflicts.current
    const valid = () => liveKey.current === key && conflicts.current === loadConflicts
    const conflictMessage = '与另一处写入冲突：败方正文已留作候选，本页已禁止直接保存；请比较双方正文后明确选择，或刷新重新载入'
    const keepCandidate = async (item: typeof captured[number]) => {
      if (lastCandidate.current[item.localId] === item.text) return
      await repo.keepCandidate(clientFileKey(currentScope, item.localId), item.text, 'draftRevision 冲突')
      if (!valid()) throw new Error('草稿上下文已失效')
      lastCandidate.current[item.localId] = item.text
    }
    const persist = async () => {
      if (!valid()) throw new Error('草稿上下文已失效')
      if (loadConflicts.size > 0) {
        for (const item of captured) if (loadConflicts.has(item.localId)) await keepCandidate(item)
        throw new Error(conflictMessage)
      }
      await repo.saveUi({ ...ui, scopeKey: key })
      if (!valid()) throw new Error('草稿上下文已失效')
      for (const item of captured) {
        if (lastWritten.current?.drafts[item.localId] === item.text) {
          item.draftRevision = revisions.current[item.localId] ?? null
          continue
        }
        const expected = revisions.current[item.localId] ?? null
        const result = await repo.saveDraft({ clientFileKey: clientFileKey(currentScope, item.localId),
          fileId: item.serverFileId ?? item.localId, text: item.text,
          draftRevision: (expected ?? 0) + 1, updatedAt: Date.now() }, expected)
        if (!valid()) throw new Error('草稿上下文已失效')
        if (!result.ok) {
          if (result.reason === 'conflict') {
            loadConflicts.add(item.localId)
            setConflictIds([...loadConflicts])
            await keepCandidate(item)
            throw new Error(conflictMessage)
          }
          throw new Error(result.message ?? '本机草稿写入失败')
        }
        revisions.current[item.localId] = result.draftRevision
        item.draftRevision = result.draftRevision
        if (lastWritten.current) lastWritten.current.drafts[item.localId] = item.text
      }
      if (valid() && seq === saveSeq.current) {
        lastWritten.current = { ui: serialized, drafts: { ...lastWritten.current?.drafts } }
        pendingWrite.current = false
        setProtection({ status: 'protected', reason: null })
      }
      return captured
    }
    const operation = writing.current.catch(() => {}).then(persist)
    writing.current = operation
    try { return await operation } catch (error) {
      if (valid() && seq === saveSeq.current) setProtection({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }, [key, loaded, files, draftText, activeFileId, openFileIds, repo])

  /* 只有实际操作产生落盘；确认保存调用同一串行写入边界，不另开覆盖通道。 */
  useEffect(() => {
    if (!key || !loaded || !pendingWrite.current) return
    const timer = window.setTimeout(() => { void protect().catch(() => {}) }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [key, loaded, protect])

  const markSaving = useCallback(() => {
    saveSeq.current++
    pendingWrite.current = true
    setProtection({ status: 'saving', reason: null })
  }, [])

  const open = useCallback(
    (fileId: string) => {
      markSaving()
      setOpenFileIds((ids) => (ids.includes(fileId) ? ids : [...ids, fileId]))
      setActiveFileId(fileId)
    },
    [markSaving],
  )

  const closeTab = useCallback(
    (fileId: string) => {
      const index = openFileIds.indexOf(fileId)
      if (index < 0) return
      markSaving()
      const next = openFileIds.filter((id) => id !== fileId)
      setOpenFileIds(next)
      // 关掉活动文件时激活相邻标签，没有相邻就清空编辑区（文件实例本身不删）
      if (activeFileId === fileId) setActiveFileId(next[index] ?? next[index - 1] ?? null)
    },
    [openFileIds, activeFileId, markSaving],
  )

  const create = useCallback(
    (path: string, text: string): CreateOutcome => {
      if (seed?.access.kind !== 'editable' || scope === null) return { ok: false, problem: 'not-allowed' }
      // 路径占用按「期望 active」的实例算：已回收实例的路径是空的，可以同名重建。
      const existing = activeFiles(files).map((f) => f.path)
      const problem = pathProblem(path, existing) ?? createLimitProblem(text, usage)
      if (problem) return { ok: false, problem }
      const fileId = `local-${crypto.randomUUID()}`
      markSaving()
      setFiles((rows) => [...rows, { fileId, path, lifecycle: 'active', confirmed: null }])
      setDrafts((rows) => ({ ...rows, [fileId]: text }))
      setOpenFileIds((ids) => [...ids, fileId])
      setActiveFileId(fileId)
      // 实例映射先落库：刷新后同名路径能找回这个实例的草稿
      void repo
        .saveInstance({
          clientFileKey: clientFileKey(scope, fileId),
          fileId,
          path,
          createdAt: Date.now(),
          lifecycle: 'active',
        })
        .catch((error: unknown) => {
          setProtection({
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        })
      return { ok: true, fileId }
    },
    [files, seed?.access.kind, scope, usage, markSaving, repo],
  )

  const setDraft = useCallback(
    (fileId: string, text: string) => {
      setDrafts((rows) => (rows[fileId] === text ? rows : { ...rows, [fileId]: text }))
      markSaving()
    },
    [markSaving],
  )

  /* 04A：比较视图只读，落库读取也只读；学生明确选择后才写回。 */
  const loadStoredDraftText = useCallback(async (fileId: string): Promise<string | null> => {
    const currentScope = scopeRef.current
    if (!currentScope) return null
    return (await repo.loadDraft(clientFileKey(currentScope, fileId)))?.text ?? null
  }, [repo])

  const resolveConflict = useCallback(
    async (fileId: string, choice: 'mine' | 'stored'): Promise<'resolved' | 'conflict-again'> => {
      const currentScope = scopeRef.current
      if (!key || !currentScope || !loaded) throw new Error('本机草稿尚未载入')
      markSaving()
      // 与防抖落盘同一条串行写入边界：选择不能与在途 persist 交错出虚假 CAS 冲突，
      // 更不能把库中正文回写成选择前的旧文。
      const operation = writing.current.catch(() => {}).then(async (): Promise<'resolved' | 'conflict-again'> => {
        const stored = await repo.loadDraft(clientFileKey(currentScope, fileId))
        if (!stored) throw new Error('本机草稿记录不存在，请刷新重新载入')
        const memoryText = draftText(fileId)
        if (choice === 'stored') {
          // 采用库中赢方：本页正文若与它不同，先留底成候选，不丢学生文字
          if (memoryText !== stored.text && lastCandidate.current[fileId] !== memoryText) {
            await repo.keepCandidate(clientFileKey(currentScope, fileId), memoryText, '比较选择：本页正文先留底')
            lastCandidate.current[fileId] = memoryText
          }
          conflicts.current.delete(fileId)
          setConflictIds([...conflicts.current])
          revisions.current[fileId] = stored.draftRevision
          setDrafts((rows) => ({ ...rows, [fileId]: stored.text }))
          if (lastWritten.current) lastWritten.current.drafts[fileId] = stored.text
          setProtection({ status: 'protected', reason: null })
          return 'resolved'
        }
        // 采用本页正文：对库中最新修订重新 CAS；期间别处又写入则再次冲突并保留新候选
        const result = await repo.saveDraft({ clientFileKey: clientFileKey(currentScope, fileId),
          fileId: stored.fileId, text: memoryText, draftRevision: stored.draftRevision + 1,
          updatedAt: Date.now() }, stored.draftRevision)
        if (!result.ok) {
          if (result.reason === 'conflict') {
            if (lastCandidate.current[fileId] !== memoryText) {
              await repo.keepCandidate(clientFileKey(currentScope, fileId), memoryText, '比较选择后再次冲突：败方正文')
              lastCandidate.current[fileId] = memoryText
            }
            setProtection({ status: 'failed', reason: '再次冲突：另一处又写入了新修订，败方正文已留作候选，可重新比较' })
            return 'conflict-again'
          }
          throw new Error(result.message ?? '本机草稿写入失败')
        }
        conflicts.current.delete(fileId)
        setConflictIds([...conflicts.current])
        revisions.current[fileId] = result.draftRevision
        if (stored.text !== memoryText && lastCandidate.current[fileId] !== stored.text) {
          await repo.keepCandidate(clientFileKey(currentScope, fileId), stored.text, '比较选择：已保存正文让位')
          lastCandidate.current[fileId] = stored.text
        }
        if (lastWritten.current) lastWritten.current.drafts[fileId] = memoryText
        setProtection({ status: 'protected', reason: null })
        return 'resolved'
      })
      writing.current = operation
      try {
        return await operation
      } catch (error) {
        // 抛出即「这次选择没有完成」：如实显示未保护，让学生重试或刷新
        if (liveKey.current === key) {
          setProtection({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
        }
        throw error
      }
    },
    [key, loaded, repo, draftText, markSaving],
  )

  /**
   * 把生命周期意图写进本机实例记录（与草稿同一个库，无新 store）。
   * 写失败保留内存意图——学生这次明确点过，界面必须如实说它还没保护住。
   */
  const persistLifecycle = useCallback(async (file: ProjectFile, lifecycle: 'active' | 'recycled') => {
    const currentScope = scopeRef.current
    if (!key || currentScope === null) return
    const instanceKey = clientFileKey(currentScope, file.fileId)
    try {
      const stored = await repo.loadInstance(instanceKey)
      await repo.saveInstance({
        clientFileKey: instanceKey,
        fileId: stored?.fileId ?? file.fileId,
        path: stored?.path ?? file.path,
        createdAt: stored?.createdAt ?? Date.now(),
        lifecycle,
      })
    } catch (error: unknown) {
      if (liveKey.current !== key) return
      setProtection({
        status: 'failed',
        reason: `生命周期意图未保护：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }, [key, repo])

  const recycle = useCallback(
    (fileId: string) => {
      const file = files.find((f) => f.fileId === fileId)
      // 不能回收时一个字节都不改：拒绝不是「先记下来再说」。
      if (!file || recycleProblem(file, access) !== null) return
      markSaving()
      setFiles((rows) => rows.map((f) => (f.fileId === fileId ? { ...f, lifecycle: 'recycled' } : f)))
      void persistLifecycle(file, 'recycled')
    },
    [files, access, markSaving, persistLifecycle],
  )

  const restore = useCallback(
    (fileId: string): { ok: true } | { ok: false; problem: LifecycleProblem; occupant: ProjectFile | null } => {
      const file = files.find((f) => f.fileId === fileId)
      if (!file) return { ok: false, problem: 'not-allowed', occupant: null }
      const { problem, occupant } = restoreProblem(file, files, access)
      if (problem !== null) return { ok: false, problem, occupant }
      markSaving()
      setFiles((rows) => rows.map((f) => (f.fileId === fileId ? { ...f, lifecycle: 'active' } : f)))
      void persistLifecycle(file, 'active')
      return { ok: true }
    },
    [files, access, markSaving, persistLifecycle],
  )

  const openFiles = useMemo(
    () => openFileIds.map((id) => files.find((f) => f.fileId === id)).filter((f): f is ProjectFile => f !== undefined),
    [openFileIds, files],
  )
  const activeFile = useMemo(() => files.find((f) => f.fileId === activeFileId) ?? null, [files, activeFileId])

  return {
    loaded,
    files,
    openFiles,
    activeFile,
    access,
    confirmedRevision: seed?.confirmedRevision ?? 0,
    protection,
    unconfirmedCount,
    lifecyclePendingCount,
    usage,
    draftText,
    readCodeDraft: (fileId) => {
      const file = files.find(f => f.fileId === fileId)
      if (!loaded || !key || liveKey.current !== key || loadedKey.current !== key || !file) return null
      return Object.freeze({ workspaceKey: key, fileId: file.fileId,
        serverFileId: file.serverFileId ?? (file.confirmed ? file.fileId : null), path: file.path,
        lifecycle: file.lifecycle, text: draftText(fileId),
        confirmed: file.confirmed ? Object.freeze({ ...file.confirmed }) : null })
    },
    isCreated: (file) => file.confirmed === null && !file.serverFileId,
    isDirty: (file) => file.confirmed !== null && draftText(file.fileId) !== file.confirmed.text,
    open,
    closeTab,
    create,
    setDraft,
    prepareSave: protect,
    conflictedFileIds: conflictIds,
    loadStoredDraftText,
    resolveConflict,
    recycle,
    restore,
  }
}

function uiRecordOf(
  activeFileId: string | null,
  openFileIds: string[],
  files: ProjectFile[],
): Omit<import('../../lib/draftStore').WorkspaceUiRecord, 'scopeKey'> {
  return {
    activeFileId,
    openFileIds,
    created: files.filter((f) => f.confirmed === null).map((f) => ({ fileId: f.fileId, path: f.path })),
  }
}
