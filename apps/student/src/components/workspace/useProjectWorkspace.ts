import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectAccess, ProjectFile, ProjectSeed } from '../../bridge/types'
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
  /** 有未确认内容的文件数（含本机新建）。 */
  unconfirmedCount: number
  usage: WorkspaceUsage
  draftText: (fileId: string) => string
  isCreated: (file: ProjectFile) => boolean
  isDirty: (file: ProjectFile) => boolean
  open: (fileId: string) => void
  closeTab: (fileId: string) => void
  create: (path: string, text: string) => CreateOutcome
  setDraft: (fileId: string, text: string) => void
}

export function useProjectWorkspace(
  seed: ProjectSeed | null,
  repo: DraftRepository,
  scope: DraftScope | null,
): ProjectWorkspace {
  // seed 为 null（这门课没有代码工具包）时返回一个惰性工作区：钩子照样跑，动作一律无效
  const key = seed === null || scope === null ? null : scopeKey(scope)
  const [loaded, setLoaded] = useState(false)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [openFileIds, setOpenFileIds] = useState<string[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [protection, setProtection] = useState<{ status: ProtectionStatus; reason: string | null }>({
    status: 'protected',
    reason: null,
  })

  // 每个实例当前已知的库中修订；写入带期望修订做 CAS，成功才推进
  const revisions = useRef<Record<string, number | null>>({})
  // 已留过候选的败方正文：同一份字不重复堆候选行
  const lastCandidate = useRef<Record<string, string>>({})
  // 写入序号：只有最新一次写入的结果才能改可见状态，迟到的成功/失败不覆盖当前判断
  const saveSeq = useRef(0)
  const lastWritten = useRef<{ ui: string; drafts: Record<string, string> } | null>(null)
  // 只有学生真的动过内容或标签才落盘：进入工作区读取本身不产生「正在保护」的假状态
  const pendingWrite = useRef(false)
  const seedRef = useRef(seed)
  const scopeRef = useRef(scope)

  useEffect(() => {
    seedRef.current = seed
    scopeRef.current = scope
  })

  /* 载入：确认作品来自 seed，本机草稿来自新库；两边按 fileId 对齐，对不上的一律丢弃 */
  useEffect(() => {
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
        const merged = [...current.files, ...created.filter((f) => !known.has(f.fileId))]

        const nextDrafts: Record<string, string> = {}
        const nextRevisions: Record<string, number | null> = {}
        const writtenDrafts: Record<string, string> = {}
        for (const file of merged) {
          const record = await repo.loadDraft(clientFileKey(currentScope, file.fileId))
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

  const draftText = useCallback(
    (fileId: string): string => {
      if (Object.hasOwn(drafts, fileId)) return drafts[fileId]!
      return files.find((f) => f.fileId === fileId)?.confirmed?.text ?? ''
    },
    [drafts, files],
  )

  const usage = useMemo<WorkspaceUsage>(() => {
    const active = files.filter((f) => f.lifecycle === 'active')
    return {
      activeFiles: active.length,
      activeBytes: active.reduce((sum, f) => sum + utf8Bytes(draftText(f.fileId)), 0),
    }
  }, [files, draftText])

  const unconfirmedCount = useMemo(
    () => files.filter((f) => f.confirmed === null || draftText(f.fileId) !== f.confirmed.text).length,
    [files, draftText],
  )

  /* 落盘：学生动过内容或标签才写；写事务 complete 才把状态改成「已保护」 */
  useEffect(() => {
    const currentScope = scopeRef.current
    if (key === null || currentScope === null || !loaded || !pendingWrite.current) return
    const uiRecord = uiRecordOf(activeFileId, openFileIds, files)
    const uiSerialized = JSON.stringify(uiRecord)
    const dirtyDrafts = Object.entries(drafts).filter(
      ([fileId, text]) => lastWritten.current?.drafts[fileId] !== text,
    )
    if (uiSerialized === lastWritten.current?.ui && dirtyDrafts.length === 0) {
      pendingWrite.current = false
      setProtection({ status: 'protected', reason: null })
      return
    }
    const timer = window.setTimeout(() => {
      const seq = ++saveSeq.current
      void (async () => {
        try {
          await repo.saveUi({ ...uiRecord, scopeKey: key })
          for (const [fileId, text] of dirtyDrafts) {
            const expected = revisions.current[fileId] ?? null
            const result = await repo.saveDraft(
              {
                clientFileKey: clientFileKey(currentScope, fileId),
                fileId,
                text,
                draftRevision: expected === null ? 1 : expected + 1,
                updatedAt: Date.now(),
              },
              expected,
            )
            // 库事实按实际写入结果记：迟到的 seq 不能把修订冻住，否则下一轮必带旧期望修订而冲突
            if (result.ok) {
              revisions.current[fileId] = result.draftRevision
              if (lastWritten.current !== null) lastWritten.current.drafts[fileId] = text
              continue
            }
            if (result.reason === 'conflict') {
              const stored = await repo.loadDraft(clientFileKey(currentScope, fileId))
              // 同一份败方正文只留一次候选；同步到赢方修订后不再无限重试，
              // 学生继续编辑时按新修订写入（完整比较选择由 04A 交付）
              if (lastCandidate.current[fileId] !== text) {
                await repo.keepCandidate(
                  clientFileKey(currentScope, fileId),
                  text,
                  'draftRevision 冲突：库中已有更新修订',
                )
                lastCandidate.current[fileId] = text
              }
              revisions.current[fileId] = stored?.draftRevision ?? null
              if (lastWritten.current !== null) lastWritten.current.drafts[fileId] = text
              if (seq !== saveSeq.current) return
              setProtection({ status: 'failed', reason: '与另一处写入冲突：本次正文已留作冲突候选，未覆盖库中更新版本' })
              return
            }
            if (seq !== saveSeq.current) return
            setProtection({ status: 'failed', reason: result.message ?? '本机草稿写入失败' })
            return
          }
          if (seq !== saveSeq.current) return
          lastWritten.current = { ui: uiSerialized, drafts: { ...lastWritten.current?.drafts, ...Object.fromEntries(dirtyDrafts) } }
          pendingWrite.current = false
          setProtection({ status: 'protected', reason: null })
        } catch (error: unknown) {
          if (seq !== saveSeq.current) return
          // 正文仍在内存里，学生可以继续编辑；只是刷新会丢，必须说清楚
          setProtection({
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [loaded, key, repo, activeFileId, openFileIds, drafts, files])

  const markSaving = useCallback(() => {
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
      const existing = files.filter((f) => f.lifecycle === 'active').map((f) => f.path)
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
    access: seed?.access ?? { kind: 'read-only', reason: '这门课还没有接入代码工具包' },
    confirmedRevision: seed?.confirmedRevision ?? 0,
    protection,
    unconfirmedCount,
    usage,
    draftText,
    isCreated: (file) => file.confirmed === null,
    isDirty: (file) => file.confirmed !== null && draftText(file.fileId) !== file.confirmed.text,
    open,
    closeTab,
    create,
    setDraft,
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
