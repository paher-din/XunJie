import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingSkillDisableSchema, teachingSkillSelectSchema, teachingSkillCatalogEntrySchema, teachingSkillImportSchema,
  type TeachingSkillRange, type TeachingSkillReference } from '@xunjie/contracts/agent-skills'
import { Section, SettingsActionMenu } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'
import { readSkillPackage, skillImportInput, useSkillCatalog, type SkillCatalogEntry } from './skills'
import { learningSubjectRequest } from './learningTransport'
import './skills.css'

type Props = { identity: SpaceIdentity; spaceKey: string; namespace: string; readOnly?: boolean
  activityId?: string; courseId?: string }
type Operation = { route: string; input: unknown; label: string; importKind?: 'local' | 'github'; inputUrl?: string }
const pin = (skill: TeachingSkillReference) => ({ skillId: skill.skillId, version: skill.version })
const entryKey = (skill: TeachingSkillReference) => `${skill.skillId}:${skill.version}`
const rangeKey = (range: TeachingSkillRange) => JSON.stringify(range)

export function PersonalSkillsSettings(props: Props) {
  const key = JSON.stringify([props.namespace, props.spaceKey, props.identity.environmentId, props.identity.spaceId,
    props.identity.principalId, props.activityId, props.courseId])
  return <SkillsSettingsBody key={key} {...props} />
}
function SkillsSettingsBody({ identity, spaceKey, namespace, activityId, courseId, readOnly = false }: Props) {
  const catalog = useSkillCatalog(identity, spaceKey, namespace, activityId)
  const [range, setRange] = useState<TeachingSkillRange>({ kind: 'all' })
  const [search, setSearch] = useState(''), [importOpen, setImportOpen] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false), [githubUrl, setGithubUrl] = useState('')
  const [importMenuOpen, setImportMenuOpen] = useState(false)
  // Edits are scoped by range; rereads never overwrite a person's unfinished selection.
  const [choices, setChoices] = useState<Record<string, TeachingSkillReference[]>>({})
  const [source, setSource] = useState(''), [packageVersion, setPackageVersion] = useState('')
  const [files, setFiles] = useState<File[]>([]), [updating, setUpdating] = useState<SkillCatalogEntry | null>(null)
  const [localFiles, setLocalFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Operation | null>(null)
  const [rejectedSelection, setRejectedSelection] = useState<Operation | null>(null)
  const live = useRef(false), acting = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null)
  const importId = useId(), sourceInput = useRef<HTMLInputElement>(null), githubInput = useRef<HTMLInputElement>(null)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const ranges: { value: TeachingSkillRange; label: string }[] = [
    { value: { kind: 'all' }, label: '本空间全部活动' }, { value: { kind: 'self-study' }, label: '自主学习' },
    ...(courseId ? [{ value: { kind: 'course' as const, courseId }, label: '当前课程' }] : []),
    ...(activityId ? [{ value: { kind: 'activity' as const, activityId }, label: '当前活动' }] : []),
  ]
  const currentRange = rangeKey(range)
  const savedSelection = catalog.data?.selections
    ? catalog.data.selections.find(item => rangeKey(item.range) === currentRange)?.skills ?? []
    : (range.kind === 'all' ? catalog.data?.skills.filter(item => item.origin === 'personal' && item.selected).map(pin) : []) ?? []
  const selected = choices[currentRange] ?? savedSelection
  const olderSelections = selected.filter(ref => !catalog.data?.skills.some(skill => entryKey(skill) === entryKey(ref)))
  const query = search.trim().toLocaleLowerCase()
  const visibleSkills = catalog.data?.skills.filter(skill => !query || [skill.name, skill.description, skill.source]
    .some(value => value.toLocaleLowerCase().includes(query))) ?? []
  const deliver = async (operation: Operation) => {
    setPending(operation)
    try {
      const result = await catalog.request(operation.route, operation.input)
      if (operation.route === 'skills/import' || operation.route === 'skills/disable') teachingSkillCatalogEntrySchema.parse(result)
      if (!live.current) return false
      setPending(null); setNotice(operation.label + '已确认。'); setError('')
      if (operation.route === 'skills/select') setRejectedSelection(null)
      // Do not clear import inputs or range edits: later input may already differ from the sent bytes.
      const refreshed = await catalog.reload()
      if (refreshed && operation.route === 'skills/select' && live.current) {
        const selection = teachingSkillSelectSchema.parse(operation.input)
        setChoices(previous => { const next = { ...previous }; delete next[rangeKey(selection.range)]; return next })
      }
      if (operation.importKind === 'local') setLocalFiles([])
      if (operation.importKind === 'github' && githubInput.current?.value.trim() === operation.inputUrl) {
        setGithubOpen(false); setImportMenuOpen(false)
      }
      return true
    } catch (cause) {
      if (!live.current) return false
      const code = (cause as { code?: string }).code
      if (['invalid', 'conflict', 'identity-conflict', 'forbidden', 'missing'].includes(code ?? '')) {
        setPending(null)
        if (operation.route === 'skills/select') setRejectedSelection(operation)
      }
      setError(code === 'invalid' ? '操作未通过校验，请核对 SKILL.md 元信息、附件和选择范围。'
        : code === 'forbidden' ? '原空间资格已失效，当前输入仍保留。'
          : code === 'conflict' || code === 'identity-conflict' ? '配置发生冲突，当前输入保留；请重新读取后核对。'
            : '操作结果尚未确认，当前输入已保留；可沿原请求核对。')
      return false
    }
  }
  const act = async (task: () => Promise<unknown>) => {
    if (acting.current || readOnly) return
    acting.current = true; setBusy(true); setError(''); setNotice('')
    try { await task() }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : '操作未完成，当前输入仍保留。') }
    finally { acting.current = false; if (live.current) setBusy(false) }
  }
  const importPackage = () => {
    const captured = { source, packageVersion, files: [...files], skillId: updating?.skillId }
    void act(async () => {
      const packed = await readSkillPackage(captured.files)
      if (!live.current) return
      const input = skillImportInput({ requestId: crypto.randomUUID(), source: captured.source, packageVersion: captured.packageVersion,
        files: packed, ...(captured.skillId ? { skillId: captured.skillId } : {}) })
      await deliver({ route: 'skills/import', input, label: captured.skillId ? '更新 Skill' : '导入 Skill' })
    })
  }
  const importLocal = (selectedFiles: File[]) => {
    if (!selectedFiles.length) return
    void act(async () => {
      const packed = await readSkillPackage(selectedFiles)
      if (!live.current) return
      const input = skillImportInput({ requestId: crypto.randomUUID(), source: '本地文件',
        packageVersion: new Date().toISOString(), files: packed })
      await deliver({ route: 'skills/import', input, label: '导入 Skill', importKind: 'local' })
    })
  }
  const importGithub = () => {
    const url = githubUrl.trim()
    void act(async () => {
      let raw: unknown
      try { raw = await learningSubjectRequest(identity, spaceKey, namespace, 'skills/github-package', { url }, 75000) }
      catch (cause) {
        const code = (cause as { code?: string }).code
        const reasons: Record<string, string> = {
          'github-invalid-url': '请输入 GitHub 公共仓库或 Skill 目录链接。',
          'github-not-found': '未找到公开仓库、版本或 Skill 目录，请检查链接。',
          'github-invalid-package': '所选目录不是有效的 Skill 包，请检查 SKILL.md 和包内文件。',
          'github-too-large': 'Skill 包超过大小或文件数量限制。',
          'github-rate-limit': 'GitHub 暂时限制了读取，请稍后重试。',
          'github-timeout': '读取 GitHub 超时，请检查网络后重试。',
        }
        throw new Error(reasons[code ?? ''] ?? '无法读取 GitHub Skill，请检查地址、网络和仓库可见性后重试。')
      }
      const result = raw as { source: string; packageVersion: string; files: unknown }
      const input = teachingSkillImportSchema.parse({ requestId: crypto.randomUUID(), source: result.source,
        packageVersion: result.packageVersion, files: result.files })
      if (live.current) await deliver({ route: 'skills/import', input, label: '导入 Skill', importKind: 'github', inputUrl: url })
    })
  }
  const disabled = readOnly || busy || !!pending
  const saveSelection = (skills: TeachingSkillReference[]) => {
    if (disabled || !catalog.isCurrent()) return
    setRejectedSelection(null)
    setChoices(previous => ({ ...previous, [currentRange]: skills }))
    void act(() => deliver({ route: 'skills/select', input: teachingSkillSelectSchema.parse({
      requestId: crypto.randomUUID(), range, skills,
    }), label: '范围选择' }))
  }
  const choose = (skill: SkillCatalogEntry, checked: boolean) => saveSelection(checked
    ? [...selected.filter(item => item.skillId !== skill.skillId), pin(skill)]
    : selected.filter(item => item.skillId !== skill.skillId))
  return <Section title="技能/Skills">
    <div className="personal-skills">
      {catalog.loading && <p className="detail" role="status">正在读取 Skills…</p>}
      {catalog.error && <p role="alert" className="learning-error">{catalog.error}</p>}
      {(catalog.error || error.includes('配置发生冲突')) && <button className="outline" type="button" disabled={catalog.loading}
        onClick={() => void catalog.reload()}>重新读取</button>}
      <div className="skill-toolbar">
        <input className="st-input skill-search" type="search" aria-label="搜索技能" placeholder="搜索技能" value={search}
          onChange={event => setSearch(event.target.value)} />
        <select className="st-input skill-range" aria-label="使用范围" value={currentRange}
          onChange={event => setRange(ranges.find(item => rangeKey(item.value) === event.target.value)!.value)}>
          {ranges.map(item => <option key={rangeKey(item.value)} value={rangeKey(item.value)}>{item.label}</option>)}
        </select>
        <SettingsActionMenu label="导入 Skill" icon={<Icon name="add" size={16} />} disabled={disabled}
          open={importMenuOpen} onOpenChange={open => { setImportMenuOpen(open); if (!open) setGithubOpen(false) }}
          panelLabel="GitHub 导入" panel={githubOpen ? <form className="skill-github" onSubmit={event => { event.preventDefault(); importGithub() }}>
            <input ref={githubInput} className="st-input" type="url" required aria-label="GitHub 地址" placeholder="输入 GitHub 仓库或 Skill 目录链接"
              value={githubUrl} onChange={event => setGithubUrl(event.target.value)} />
            <button className="primary" type="submit" disabled={disabled || !githubUrl.trim()}>{busy ? '导入中…' : '导入'}</button>
          </form> : undefined} items={[
          { id: 'local', label: '本地导入', icon: <Icon name="folder-with-files" size={16} />,
            onSelect: () => { setUpdating(null); setImportOpen(false); setGithubOpen(false); fileInput.current?.click() } },
          { id: 'github', label: 'GitHub 导入', icon: <Icon name="brand-github" size={16} />, keepOpen: true,
            onSelect: () => { setUpdating(null); setImportOpen(false); setGithubOpen(true); requestAnimationFrame(() => githubInput.current?.focus()) } },
        ]} />
      </div>
      {!githubOpen && localFiles.length > 0 && <div className="skill-local-import">
        <p className="detail">已选择 {localFiles.length} 个文件</p>
        <div className="skill-actions">
          <button className="outline" type="button" disabled={disabled} onClick={() => directoryInput.current?.click()}>选择目录</button>
          <button className="primary" type="button" disabled={disabled} onClick={() => importLocal(localFiles)}>导入</button>
          <button className="outline" type="button" disabled={disabled} onClick={() => setLocalFiles([])}>取消</button>
        </div>
      </div>}
      {catalog.data?.skills.length === 0 && <p className="detail">尚未导入 Skill。</p>}
      {catalog.data && catalog.data.skills.length > 0 && !visibleSkills.length && <p className="detail">没有找到匹配的技能。</p>}
      <div className="skill-list">{visibleSkills.map(skill => <article className="skill-entry" key={entryKey(skill)}>
        <label className="skill-check"><input type="checkbox" disabled={disabled || !catalog.isCurrent() || skill.origin === 'course'
          || skill.disabled && !selected.some(item => entryKey(item) === entryKey(skill))}
          checked={skill.origin === 'course' ? skill.selected : selected.some(item => entryKey(item) === entryKey(skill))}
          onChange={event => choose(skill, event.target.checked)} />
          <span><strong>{skill.name}</strong><span className="skill-version">{skill.packageVersion} · 版本 {skill.version}</span></span></label>
        <p>{skill.description}</p><p className="detail">{skill.source} · {skill.origin === 'course' ? '课程提供' : '个人导入'} · {skill.disabled ? '已停用' : '可用'}</p>
        {skill.unavailable && <p className="detail">{skill.unavailable.detail}</p>}
        {skill.origin === 'personal' && <div className="skill-actions">
          <button type="button" className="outline st-xs" disabled={disabled} onClick={() => {
            setUpdating(skill); setSource(skill.source); setPackageVersion(''); setFiles([])
            setGithubOpen(false); setImportOpen(true); requestAnimationFrame(() => sourceInput.current?.focus())
          }}>更新版本</button>
          <button type="button" className="outline st-xs" disabled={disabled} onClick={() => void act(() => deliver({ route: 'skills/disable',
            input: teachingSkillDisableSchema.parse({ requestId: crypto.randomUUID(), skillId: skill.skillId, disabled: !skill.disabled }),
            label: skill.disabled ? '启用 Skill' : '停用 Skill' }))}>{skill.disabled ? '启用' : '停用'}</button>
        </div>}
        <details><summary>包信息</summary><ul>{skill.attachments.map(file => <li key={file.path}>{file.path} · {file.byteLength} B</li>)}</ul>
          {skill.metadata.compatibility && <p>兼容要求：{skill.metadata.compatibility}</p>}
          {skill.metadata.dependencies.length > 0 && <p>依赖：{skill.metadata.dependencies.join('、')}</p>}
          {skill.metadata.conflicts.length > 0 && <p>冲突：{skill.metadata.conflicts.join('、')}</p>}
          {skill.metadata['allowed-tools'].length > 0 && <p>声明工具：{skill.metadata['allowed-tools'].join('、')}</p>}
        </details>
      </article>)}</div>
      {!query && olderSelections.map(ref => <label className="skill-check" key={entryKey(ref)}><input type="checkbox" checked disabled={disabled || !catalog.isCurrent()}
        onChange={() => saveSelection(selected.filter(item => item.skillId !== ref.skillId))} />
        <span>{catalog.data?.skills.find(skill => skill.skillId === ref.skillId)?.name ?? '原 Skill'} · 固定版本 {ref.version}
          <small className="detail">原范围仍选用旧版本；勾选目录中的新版可替换。</small></span></label>)}
      {pending && <div className="skill-actions"><button className="outline" type="button" disabled={busy || readOnly} onClick={() => void act(() => deliver(pending))}>核对原操作</button></div>}
      {rejectedSelection && <div className="skill-actions"><button className="outline" type="button" disabled={disabled || !catalog.isCurrent()}
        onClick={() => void act(() => deliver({ ...rejectedSelection, input: { ...teachingSkillSelectSchema.parse(rejectedSelection.input), requestId: crypto.randomUUID() } }))}>重试保存</button></div>}
      <input ref={fileInput} type="file" multiple hidden aria-label="选择 Skill 包文件"
        onChange={event => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ''
          if (updating) setFiles(chosen); else if (chosen.length) setLocalFiles(chosen)
        }} />
      <input ref={directoryInput} type="file" multiple hidden aria-label="选择 Skill 包目录"
        {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
        onChange={event => {
          const chosen = Array.from(event.target.files ?? []); event.target.value = ''
          if (updating) setFiles(chosen); else if (chosen.length) setLocalFiles(chosen)
        }} />
      <div className="skill-import" id={importId} hidden={!importOpen}>
        {updating && <h3>更新「{updating.name}」</h3>}
        <div className="skill-fields">
          <label>来源<input ref={sourceInput} className="st-input" value={source} maxLength={2000} placeholder="仓库地址或包来源"
            onChange={event => setSource(event.target.value)} /></label>
          <label>包版本<input className="st-input" value={packageVersion} maxLength={100} placeholder="例如 1.0.0"
            onChange={event => setPackageVersion(event.target.value)} /></label>
        </div>
        <div className="skill-actions">
          <button className="outline" type="button" disabled={disabled} onClick={() => directoryInput.current?.click()}>选择目录</button>
          <button className="outline" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>选择多个文件</button>
          <button className="primary" type="button" disabled={disabled || !files.length || !source.trim() || !packageVersion.trim()} onClick={importPackage}>
            {updating ? '导入新版本' : '导入 Skill'}</button>
          {updating && <button className="outline" type="button" disabled={disabled} onClick={() => setUpdating(null)}>取消更新</button>}
        </div>
        <p className="detail">{files.length ? `已选 ${files.length} 个文件：${files.map(file => file.webkitRelativePath || file.name).join('、')}` : '选择包含 SKILL.md 的目录或文件包；附件会保留原路径。'}</p>
      </div>
      {busy && <p role="status" className="detail">正在处理…</p>}
      {error && <p role="alert" className="learning-error">{error}</p>}
      {notice && <p role="status" className="detail">{notice}</p>}
    </div>
  </Section>
}
