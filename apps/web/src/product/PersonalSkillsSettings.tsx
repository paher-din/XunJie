import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingSkillDisableSchema, teachingSkillCatalogEntrySchema, teachingSkillDocumentSchema, teachingSkillRemoveSchema, teachingSkillImportSchema, teachingSkillLimits } from '@xunjie/contracts/agent-skills'
import { Section, SettingsActionMenu, SettingsEmptyState, SkillListItem, SkillDocumentDialog, SkillImportFeedback } from '@xunjie/ui/settings'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import { toast, useToastFeedback } from '@xunjie/ui/feedback'
import { readSkillPackage, skillImportInput, skillImportErrorMessage, useSkillCatalog, type SkillCatalogEntry } from './skills'
import { learningSubjectRequest } from './learningTransport'
import { LocalSkillImportBatch, type LocalSkillImportProgress } from './skill-import'
import './skills.css'

type Props = { identity: SpaceIdentity; spaceKey: string; namespace: string; readOnly?: boolean; active?: boolean
  activityId?: string; courseId?: string }
type Operation = { route: string; input: unknown; label: string; importKind?: 'local' | 'github'; inputUrl?: string; update?: 'local' | 'github' }
const fromGithub = (source: string) => /^https:\/\/github\.com\//i.test(source)
const localImportSummary = (progress: LocalSkillImportProgress) => [
  progress.imported > 0 ? `已导入 ${progress.imported} 个技能` : '',
  progress.existing > 0 ? `${progress.existing} 个已在列表中` : '',
  progress.remaining > 0 ? `${progress.remaining} 个未完成` : '',
].filter(Boolean).join('，')

export function PersonalSkillsSettings(props: Props) {
  const key = JSON.stringify([props.namespace, props.spaceKey, props.identity.environmentId, props.identity.spaceId,
    props.identity.principalId, props.activityId, props.courseId])
  return <SkillsSettingsBody key={key} {...props} />
}
function SkillsSettingsBody({ identity, spaceKey, namespace, readOnly = false, active = true }: Props) {
  const catalog = useSkillCatalog(identity, spaceKey, namespace, undefined, active)
  const [search, setSearch] = useState('')
  const [githubOpen, setGithubOpen] = useState(false), [githubUrl, setGithubUrl] = useState('')
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  const [choices, setChoices] = useState<Record<string, boolean>>({})
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [updateFailure, setUpdateFailure] = useState<{ skillId: string; message: string } | null>(null)
  const [localImportBusy, setLocalImportBusy] = useState(false)
  const [localImportProgress, setLocalImportProgress] = useState<LocalSkillImportProgress | null>(null)
  const localImportBatch = useRef<LocalSkillImportBatch | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [needsReload, setNeedsReload] = useState(false)
  const [pending, setPending] = useState<Operation | null>(null)
  const [opened, setOpened] = useState<SkillCatalogEntry | null>(null), [removing, setRemoving] = useState<SkillCatalogEntry | null>(null)
  const openedRef = useRef(opened)
  openedRef.current = opened
  const [documentRead, setDocumentRead] = useState<{ content: string | null; loading: boolean; error: string }>({ content: null, loading: false, error: '' })
  const [documentAttempt, setDocumentAttempt] = useState(0)
  const viewActive = useRef(active)
  viewActive.current = active
  const returnFocus = useRef<HTMLButtonElement | null>(null), searchInput = useRef<HTMLInputElement>(null)
  useToastFeedback(active ? error : '')
  const [rejectedToggle, setRejectedToggle] = useState<Operation | null>(null)
  const live = useRef(false), acting = useRef(false)
  const directoryInput = useRef<HTMLInputElement>(null), updateDirectoryInput = useRef<HTMLInputElement>(null)
  const updateTarget = useRef<SkillCatalogEntry | null>(null)
  const feedbackId = useId(), githubInput = useRef<HTMLInputElement>(null)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => { if (importMenuOpen && githubOpen) githubInput.current?.focus() }, [importMenuOpen, githubOpen])
  useEffect(() => { if (!active) { setOpened(null); setRemoving(null); toast.dismiss(feedbackId) } }, [active, feedbackId])
  useEffect(() => () => { toast.dismiss(feedbackId) }, [feedbackId])
  useEffect(() => {
    if (!opened || !active) return
    let cancelled = false
    setDocumentRead(previous => ({ ...previous, loading: true, error: '' }))
    void catalog.request('skills/document', { skillId: opened.skillId, version: opened.version }).then(value => {
      const document = teachingSkillDocumentSchema.parse(value)
      if (document.skillId !== opened.skillId || document.version !== opened.version) throw new Error('Unexpected document')
      if (!cancelled) setDocumentRead({ content: document.content, loading: false, error: '' })
    }).catch(() => {
      if (!cancelled) setDocumentRead({ content: null, loading: false, error: '暂时无法打开技能，请重试。' })
    })
    return () => { cancelled = true }
  }, [opened, active, catalog.request, documentAttempt])
  const query = search.trim().toLocaleLowerCase()
  const visibleSkills = catalog.data?.skills.filter(skill => !query || [skill.name, skill.description, skill.source]
    .some(value => value.toLocaleLowerCase().includes(query))) ?? []
  const reportUpdateFailure = (skillId: string, message: string) => {
    setUpdateFailure({ skillId, message })
    if (viewActive.current && openedRef.current?.skillId !== skillId)
      toast.error(message, { id: feedbackId, duration: 8000, closeButton: false })
  }
  const deliver = async (operation: Operation) => {
    setPending(operation)
    try {
      const result = await catalog.request(operation.route, operation.input)
      const updated = operation.route === 'skills/import' || operation.route === 'skills/disable'
        ? teachingSkillCatalogEntrySchema.parse(result) : null
      if (!live.current) return false
      setPending(null); setError(''); setNeedsReload(false)
      const toggle = operation.route === 'skills/disable' ? teachingSkillDisableSchema.parse(operation.input) : null
      if (viewActive.current) toast.success(operation.label, { id: feedbackId, duration: 2400, closeButton: false, icon: undefined, action: undefined, description: undefined,
        ...(toggle || operation.update ? { icon: <Icon name={toggle?.disabled ? 'minus-circle' : 'check-circle'} variant="linear" tone="neutral" size={18}
          style={{ color: toggle?.disabled ? 'var(--muted)' : 'var(--progress-fill-done)' }} /> } : {}) })
      if (updated) setRejectedToggle(null)
      if (operation.route === 'skills/remove') { returnFocus.current = null; setRemoving(null) }
      if (operation.update && updated) {
        setUpdateFailure(null)
        setOpened(previous => previous?.skillId === updated.skillId ? updated : previous)
      }
      // Preserve pending input until the owner's confirmed state has been read back.
      const refreshed = await catalog.reload()
      if (refreshed && updated && live.current) {
        setChoices(previous => { const next = { ...previous }; delete next[updated.skillId]; return next })
      }
      if (operation.importKind === 'local') setImportMenuOpen(false)
      if (operation.importKind === 'github' && githubInput.current?.value.trim() === operation.inputUrl) {
        setGithubOpen(false); setImportMenuOpen(false)
      }
      return true
    } catch (cause) {
      if (!live.current) return false
      if (operation.route === 'skills/remove') setRemoving(null)
      const code = (cause as { code?: string }).code
      setNeedsReload(code === 'conflict' || code === 'identity-conflict')
      if (['invalid', 'invalid-skill', 'conflict', 'identity-conflict', 'forbidden', 'missing'].includes(code ?? '')) {
        setPending(null)
        if (operation.route === 'skills/disable') setRejectedToggle(operation)
      }
      const message = skillImportErrorMessage(cause) ?? (code === 'invalid' || code === 'invalid-skill' ? operation.update === 'github' ? '仓库中的技能内容有误，请修正后重试。'
        : operation.update === 'local' ? '无法更新这个技能，请检查文件内容，或重新选择技能文件夹。'
        : operation.route === 'skills/import' ? '无法导入这个技能，请检查文件内容，或重新选择技能文件夹。' : '暂时无法更改技能，请刷新列表后重试。'
        : code === 'forbidden' ? '没有修改此技能的权限，请检查当前账号。'
          : code === 'conflict' || code === 'identity-conflict' ? '技能已在其他位置更新，请刷新列表后重试。'
            : code === 'missing' && operation.update ? '这个技能已被移除，请关闭文档后刷新列表。'
              : operation.update ? '暂时无法确认更新结果，请重试。' : '暂时无法确认结果，请重试。')
      if (operation.update) reportUpdateFailure(teachingSkillImportSchema.parse(operation.input).skillId!, message)
      else setError(message)
      return false
    }
  }
  const act = async (task: () => Promise<unknown>, localImport = false) => {
    if (acting.current || readOnly) return
    acting.current = true; setBusy(true); setLocalImportBusy(localImport); setError('')
    try { await task() }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。') }
    finally { acting.current = false; if (live.current) { setBusy(false); setLocalImportBusy(false) } }
  }
  const runUpdate = (skillId: string, task: () => Promise<unknown>) => {
    void act(async () => {
      setUpdatingId(skillId); setUpdateFailure(null)
      try { await task() }
      catch (cause) {
        if (live.current) reportUpdateFailure(skillId, cause instanceof Error && /[\u3400-\u9fff]/.test(cause.message)
          ? cause.message : '更新未完成，请重试。')
      } finally { if (live.current) setUpdatingId(null) }
    })
  }
  const replaceLocalSkill = (skill: SkillCatalogEntry, files: File[]) => {
    if (!files.length || disabled) return
    runUpdate(skill.skillId, async () => {
      const packed = await readSkillPackage(files)
      if (!live.current) return
      const input = skillImportInput({ requestId: crypto.randomUUID(), source: skill.source,
        packageVersion: new Date().toISOString(), files: packed, skillId: skill.skillId })
      await deliver({ route: 'skills/import', input, label: '已更新', update: 'local' })
    })
  }
  const runLocalImport = (batch: LocalSkillImportBatch) => {
    void act(async () => {
      const stop = () => {
        batch.stop()
        if (viewActive.current) toast.loading('正在停止导入…', { id: feedbackId, duration: Infinity, closeButton: false,
          icon: undefined, action: undefined, description: undefined })
      }
      const progress = await batch.run({
        request: input => catalog.request('skills/import', input), isActive: () => live.current,
        onProgress: value => {
          if (!live.current) return
          if (!value.running) setLocalImportProgress(value)
          if (value.running && value.total > 1 && viewActive.current) toast.loading(
            value.pauseReason === 'stopped' ? '正在停止导入…' : `正在导入技能 ${value.current?.index ?? 1}/${value.current?.total ?? value.total}`,
            { id: feedbackId, duration: Infinity, closeButton: false, icon: undefined, description: undefined,
              action: value.pauseReason === 'stopped' ? undefined : { label: '停止', onClick: stop } })
        },
      })
      if (!live.current) return
      const refreshed = await catalog.reload()
      if (!live.current) return
      if (refreshed) setChoices(previous => {
        const next = { ...previous }; for (const id of progress.confirmedIds) delete next[id]; return next
      })
      if (progress.remaining === 0) localImportBatch.current = null
      if (!viewActive.current) return
      const options = { id: feedbackId, closeButton: false, icon: undefined, action: undefined, description: undefined }
      if (progress.remaining === 0) toast.success(progress.total === 1
        ? progress.existing ? '技能已在列表中' : '技能已导入' : localImportSummary(progress), { ...options, duration: 2400 })
      else if (progress.uncertain) toast.error(progress.total === 1 ? '暂时无法确认导入结果，请重试。' : localImportSummary(progress), { ...options, duration: 8000 })
      else if (progress.pauseReason === 'stopped') toast.info('已停止导入', { ...options, duration: 2400 })
      else if (progress.total === 1 && progress.failures[0]) toast.error(progress.failures[0].message, { ...options, duration: 8000 })
      else toast.warning(localImportSummary(progress), { ...options, duration: 5000 })
    }, true)
  }
  const importLocal = (selectedFiles: File[]) => {
    if (!selectedFiles.length || pending || localImportProgress?.uncertain || acting.current || readOnly || !live.current) return
    localImportBatch.current = null; setLocalImportProgress(null); setError('')
    try {
      const batch = new LocalSkillImportBatch(selectedFiles, catalog.data?.skills.map(skill => skill.skillId) ?? [])
      localImportBatch.current = batch; setLocalImportProgress(batch.progress); setImportMenuOpen(false)
      runLocalImport(batch)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法读取所选文件夹，请重新选择。') }
  }
  const readGithubPackage = async (url: string, latest = false) => {
    let raw: unknown
    try { raw = await learningSubjectRequest(identity, spaceKey, namespace, 'skills/github-package',
      { url, ...(latest ? { latest: true } : {}) }, teachingSkillLimits.githubReadTimeoutMs + 15000) }
    catch (cause) {
      const code = (cause as { code?: string }).code
      const reasons: Record<string, string> = {
        'github-invalid-url': '请输入 GitHub 公开仓库或技能文件夹的链接。',
        'github-not-found': latest ? '原仓库中已找不到这个技能，请检查是否已移动或删除。' : '未找到这个仓库或技能，请检查链接。',
        'github-invalid-package': '所选文件夹中没有有效的 SKILL.md，请检查链接。',
        'github-too-large': '这个技能的文件过多或过大，请选择更小的文件夹。',
        'github-rate-limit': 'GitHub 暂时限制了读取，请稍后重试。',
        'github-timeout': '读取 GitHub 超时，请检查网络后重试。',
      }
      throw new Error(reasons[code ?? ''] ?? (latest ? '无法读取 GitHub 最新版本，请检查网络后重试。' : '无法从 GitHub 导入，请检查链接和网络后重试。'))
    }
    const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const parsed = teachingSkillImportSchema.safeParse({ requestId: crypto.randomUUID(), source: result.source,
      packageVersion: result.packageVersion, files: result.files })
    if (!parsed.success) throw new Error('无法读取这个技能，请检查 SKILL.md 和文件格式。')
    return parsed.data
  }
  const importGithub = () => {
    const url = githubUrl.trim()
    void act(async () => {
      const input = await readGithubPackage(url)
      if (live.current) await deliver({ route: 'skills/import', input, label: '技能已导入', importKind: 'github', inputUrl: url })
    })
  }
  const disabled = readOnly || busy || !!pending || !!localImportProgress?.uncertain
  const choose = (skill: SkillCatalogEntry, checked: boolean) => {
    if (disabled || !catalog.isCurrent()) return
    setRejectedToggle(null)
    setChoices(previous => ({ ...previous, [skill.skillId]: checked }))
    void act(() => deliver({ route: 'skills/disable', input: teachingSkillDisableSchema.parse({
      requestId: crypto.randomUUID(), skillId: skill.skillId, disabled: !checked,
    }), label: checked ? '技能已启用' : '技能已停用' }))
  }
  const restoreFocus = () => {
    if (returnFocus.current?.isConnected) returnFocus.current.focus()
    else searchInput.current?.focus()
  }
  const updateSkill = (skill: SkillCatalogEntry) => {
    if (disabled) return
    if (fromGithub(skill.source)) runUpdate(skill.skillId, async () => {
      const latest = await readGithubPackage(skill.source, true)
      if (!live.current) return
      // Source identifies the original library entry; the new commit is its package version.
      const input = skillImportInput({ ...latest, source: skill.source, skillId: skill.skillId })
      await deliver({ route: 'skills/import', input, label: '已更新', update: 'github' })
    })
    else { updateTarget.current = skill; updateDirectoryInput.current?.click() }
  }
  const chooseLocalFolder = () => {
    setGithubOpen(false); directoryInput.current?.click()
  }
  const pendingUpdate = pending?.update && (pending.input as { skillId: string }).skillId === opened?.skillId ? pending : null
  const updateMessage = updateFailure?.skillId === opened?.skillId ? updateFailure?.message : ''
  const refreshingDocument = documentRead.loading && documentRead.content !== null
  const updateBusy = !!opened && (busy && updatingId === opened.skillId || refreshingDocument)
  const retry = (operation: Operation) => {
    if (operation.update) runUpdate((operation.input as { skillId: string }).skillId, () => deliver(operation))
    else void act(() => deliver(operation), operation.importKind === 'local')
  }
  return <Section title="技能">
    <div className="personal-skills">
      {catalog.loading && !catalog.data && <p className="detail" role="status">正在加载技能…</p>}
      {catalog.error && <p className="detail" role="alert">{catalog.error}</p>}
      {(catalog.error || needsReload) && <button className="outline" type="button" disabled={catalog.loading}
        onClick={() => { setNeedsReload(false); void catalog.reload() }}>刷新列表</button>}
      <div className="skill-toolbar">
        <div className="skill-search-field"><Icon name="minimalistic-magnifier" size={16} />
          <input ref={searchInput} className="st-input skill-search" type="search" aria-label="搜索技能" placeholder="搜索技能" value={search}
            onChange={event => setSearch(event.target.value)} /></div>
        <SettingsActionMenu label={localImportBusy ? '导入中…' : '导入技能'} icon={<Icon name="add" size={16} />} disabled={disabled}
          open={importMenuOpen} onOpenChange={open => { setImportMenuOpen(open); if (!open) setGithubOpen(false) }}
          panelLabel="从 GitHub 导入" panel={githubOpen ? <form className="skill-github" onSubmit={event => { event.preventDefault(); importGithub() }}>
            <label>GitHub 链接<input ref={githubInput} className="st-input" type="url" required placeholder="https://github.com/…"
              value={githubUrl} onChange={event => setGithubUrl(event.target.value)} /></label>
            <button className="primary" type="submit" disabled={disabled || !githubUrl.trim()}>{busy ? '导入中…' : '导入'}</button>
          </form> : undefined} items={[
          { id: 'local', label: '本地导入', icon: <Icon name="folder-with-files" size={16} />,
            onSelect: chooseLocalFolder },
          { id: 'github', label: '从 GitHub 导入', icon: <Icon name="brand-github" size={16} />, keepOpen: true,
            onSelect: () => setGithubOpen(true) },
        ]} />
      </div>
      {localImportProgress && localImportProgress.remaining > 0 && (localImportProgress.failures.length > 0 || localImportProgress.pauseReason) && <SkillImportFeedback
        summary={localImportSummary(localImportProgress)} failures={localImportProgress.failures}
        retryLabel={localImportBusy ? '导入中…' : localImportProgress.total === 1 ? '重试' : localImportProgress.pauseReason ? '继续导入' : '重试未完成'}
        disabled={readOnly || busy || !!pending}
        onRetry={() => { if (localImportBatch.current) runLocalImport(localImportBatch.current) }}
        {...(!localImportProgress.uncertain ? { onChooseFolder: chooseLocalFolder, onDismiss: () => {
          localImportBatch.current = null; setLocalImportProgress(null); toast.dismiss(feedbackId)
        } } : {})} />}
      {catalog.data?.skills.length === 0 && <SettingsEmptyState icon={<Icon name="skill" size={24} />} title="还没有技能" />}
      {catalog.data && catalog.data.skills.length > 0 && !visibleSkills.length && <SettingsEmptyState icon={<Icon name="minimalistic-magnifier" size={24} />} title="没有找到匹配的技能" />}
      {visibleSkills.length > 0 && <div className="skill-list">{visibleSkills.map(skill => <SkillListItem key={`${skill.origin}:${skill.skillId}`}
        name={skill.name} description={skill.description} checked={skill.origin === 'course' ? skill.selected : choices[skill.skillId] ?? !skill.disabled}
        disabled={disabled || !catalog.isCurrent()} readOnly={readOnly || skill.origin === 'course'}
        busy={busy && (pending?.input as { skillId?: string } | undefined)?.skillId === skill.skillId}
        onCheckedChange={checked => choose(skill, checked)}
        onOpen={trigger => { returnFocus.current = trigger; setDocumentRead({ content: null, loading: true, error: '' }); setOpened(skill) }}
        onRemove={skill.origin === 'personal' ? trigger => { returnFocus.current = trigger; setRemoving(skill) } : undefined}
      />)}</div>}
      <SkillDocumentDialog open={!!opened} name={opened?.name ?? ''} {...documentRead}
        onClose={() => setOpened(null)} onRetry={() => setDocumentAttempt(value => value + 1)} onReturnFocus={restoreFocus}
        footer={opened?.origin === 'personal' && <>
          {updateMessage && <p className="skill-update-error" role="alert">{updateMessage}</p>}
          <button type="button" className="outline skill-update-button" aria-busy={updateBusy || undefined}
            disabled={readOnly || busy || documentRead.loading || !!localImportProgress?.uncertain || !!pending && !pendingUpdate}
            onClick={() => pendingUpdate ? retry(pendingUpdate) : updateSkill(opened)}>
            <Icon name="restart" variant="linear" tone="neutral" size={16} className={updateBusy ? 'skill-update-spinning' : undefined} />
            {updateBusy ? '更新中…' : pendingUpdate || updateMessage && fromGithub(opened.source) ? '重试更新' : updateMessage ? '重新选择文件夹' : '更新技能'}
          </button>
          <input ref={updateDirectoryInput} type="file" multiple hidden aria-label="选择更新技能文件夹"
            {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
            onChange={event => {
              const files = Array.from(event.target.files ?? []), target = updateTarget.current
              event.target.value = ''; updateTarget.current = null
              if (target) replaceLocalSkill(target, files)
            }} />
        </>} />
      <ConfirmationDialog open={!!removing} title={`删除「${removing?.name ?? ''}」？`} description="将从你的技能列表中移除。"
        confirmLabel="删除" pendingLabel="删除中…" busy={busy} onReturnFocus={restoreFocus} onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing && !disabled) void act(() => deliver({ route: 'skills/remove', label: '技能已删除',
          input: teachingSkillRemoveSchema.parse({ requestId: crypto.randomUUID(), skillId: removing.skillId }) })) }} />
      {pending && !busy && (!pending.update || !opened) && <div className="skill-actions"><button className="outline" type="button" disabled={readOnly} onClick={() => retry(pending)}>重试</button></div>}
      {rejectedToggle && <div className="skill-actions"><button className="outline" type="button" disabled={disabled || !catalog.isCurrent()}
        onClick={() => void act(() => deliver({ ...rejectedToggle, input: { ...teachingSkillDisableSchema.parse(rejectedToggle.input), requestId: crypto.randomUUID() } }))}>重试</button></div>}
      <input ref={directoryInput} type="file" multiple hidden aria-label="选择技能文件夹"
        {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
        onChange={event => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ''
          importLocal(chosen)
        }} />
    </div>
  </Section>
}
