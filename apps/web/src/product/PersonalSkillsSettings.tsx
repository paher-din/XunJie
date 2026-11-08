import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingSkillDisableSchema, teachingSkillSelectSchema, teachingSkillCatalogEntrySchema,
  type TeachingSkillRange, type TeachingSkillReference } from '@xunjie/contracts/agent-skills'
import { Section } from '../components/settings/controls'
import { readSkillPackage, skillImportInput, useSkillCatalog, type SkillCatalogEntry } from './skills'
import './skills.css'

type Props = { identity: SpaceIdentity; spaceKey: string; namespace: string; readOnly?: boolean
  activityId?: string; courseId?: string }
type Operation = { route: string; input: unknown; label: string }
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
  // Edits are scoped by range; rereads never overwrite a person's unfinished selection.
  const [choices, setChoices] = useState<Record<string, TeachingSkillReference[]>>({})
  const [source, setSource] = useState(''), [packageVersion, setPackageVersion] = useState('')
  const [files, setFiles] = useState<File[]>([]), [updating, setUpdating] = useState<SkillCatalogEntry | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Operation | null>(null)
  const live = useRef(false), acting = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null)
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
  const deliver = async (operation: Operation) => {
    setPending(operation)
    try {
      const result = await catalog.request(operation.route, operation.input)
      if (operation.route === 'skills/import' || operation.route === 'skills/disable') teachingSkillCatalogEntrySchema.parse(result)
      if (!live.current) return
      setPending(null); setNotice(operation.label + '已确认。'); setError('')
      // Do not clear import inputs or range edits: later input may already differ from the sent bytes.
      await catalog.reload()
    } catch (cause) {
      if (!live.current) return
      const code = (cause as { code?: string }).code
      if (['invalid', 'conflict', 'identity-conflict', 'forbidden', 'missing'].includes(code ?? '')) setPending(null)
      setError(code === 'invalid' ? '操作未通过校验，请核对 SKILL.md 元信息、附件和选择范围。'
        : code === 'forbidden' ? '原空间资格已失效，当前输入仍保留。'
          : code === 'conflict' || code === 'identity-conflict' ? '配置发生冲突，当前输入保留；请重新读取后核对。'
            : '操作结果尚未确认，当前输入已保留；可沿原请求核对。')
    }
  }
  const act = async (task: () => Promise<void>) => {
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
  const disabled = readOnly || busy || !!pending
  const choose = (skill: SkillCatalogEntry, checked: boolean) => setChoices(previous => ({ ...previous,
    [currentRange]: checked ? [...selected.filter(item => item.skillId !== skill.skillId), pin(skill)]
      : selected.filter(item => item.skillId !== skill.skillId) }))
  return <Section title="个人 Skills">
    <div className="personal-skills">
      <div className="skill-actions"><button className="outline" type="button" disabled={catalog.loading}
        onClick={() => void catalog.reload()}>重新读取 Skills</button></div>
      {catalog.loading && <p className="detail" role="status">正在读取 Skills…</p>}
      {catalog.error && <p role="alert" className="learning-error">{catalog.error}</p>}
      <div className="skill-import">
        <h3>{updating ? `更新「${updating.name}」` : '导入 Skill'}</h3>
        <div className="skill-fields">
          <label>来源<input className="st-input" value={source} maxLength={2000} placeholder="仓库地址或包来源"
            onChange={event => setSource(event.target.value)} /></label>
          <label>包版本<input className="st-input" value={packageVersion} maxLength={100} placeholder="例如 1.0.0"
            onChange={event => setPackageVersion(event.target.value)} /></label>
        </div>
        <input ref={fileInput} type="file" multiple hidden aria-label="选择 Skill 包文件"
          onChange={event => { setFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <input ref={directoryInput} type="file" multiple hidden aria-label="选择 Skill 包目录"
          {...({ webkitdirectory: '' } as InputHTMLAttributes<HTMLInputElement>)}
          onChange={event => { setFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
        <div className="skill-actions">
          <button className="outline" type="button" disabled={disabled} onClick={() => directoryInput.current?.click()}>选择目录</button>
          <button className="outline" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>选择多个文件</button>
          <button className="primary" type="button" disabled={disabled || !files.length || !source.trim() || !packageVersion.trim()} onClick={importPackage}>
            {updating ? '导入新版本' : '导入 Skill'}</button>
          {updating && <button className="outline" type="button" disabled={disabled} onClick={() => setUpdating(null)}>取消更新</button>}
        </div>
        <p className="detail">{files.length ? `已选 ${files.length} 个文件：${files.map(file => file.webkitRelativePath || file.name).join('、')}` : '选择包含 SKILL.md 的目录或文件包；附件会保留原路径。'}</p>
      </div>
      <label className="skill-range">使用范围<select className="st-input" value={currentRange}
        onChange={event => setRange(ranges.find(item => rangeKey(item.value) === event.target.value)!.value)}>
        {ranges.map(item => <option key={rangeKey(item.value)} value={rangeKey(item.value)}>{item.label}</option>)}
      </select></label>
      {catalog.data?.skills.length === 0 && <p className="detail">尚未导入 Skill。</p>}
      <div className="skill-list">{catalog.data?.skills.map(skill => <article className="skill-entry" key={entryKey(skill)}>
        <label className="skill-check"><input type="checkbox" disabled={disabled || skill.origin === 'course'
          || skill.disabled && !selected.some(item => entryKey(item) === entryKey(skill))}
          checked={skill.origin === 'course' ? skill.selected : selected.some(item => entryKey(item) === entryKey(skill))}
          onChange={event => choose(skill, event.target.checked)} />
          <span><strong>{skill.name}</strong><span className="skill-version">{skill.packageVersion} · 版本 {skill.version}</span></span></label>
        <p>{skill.description}</p><p className="detail">{skill.source} · {skill.origin === 'course' ? '课程提供' : '个人导入'} · {skill.disabled ? '已停用' : '可用'}</p>
        {skill.unavailable && <p className="detail">{skill.unavailable.detail}</p>}
        {skill.origin === 'personal' && <div className="skill-actions">
          <button type="button" className="outline st-xs" disabled={disabled} onClick={() => {
            setUpdating(skill); setSource(skill.source); setPackageVersion(''); setFiles([])
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
      {olderSelections.map(ref => <label className="skill-check" key={entryKey(ref)}><input type="checkbox" checked disabled={disabled}
        onChange={() => setChoices(previous => ({ ...previous, [currentRange]: selected.filter(item => item.skillId !== ref.skillId) }))} />
        <span>{catalog.data?.skills.find(skill => skill.skillId === ref.skillId)?.name ?? '原 Skill'} · 固定版本 {ref.version}
          <small className="detail">原范围仍选用旧版本；勾选目录中的新版可替换。</small></span></label>)}
      <div className="skill-actions"><button className="outline" type="button" disabled={disabled || !catalog.data} onClick={() => void act(() => deliver({
        route: 'skills/select', input: teachingSkillSelectSchema.parse({ requestId: crypto.randomUUID(), range, skills: selected }), label: '范围选择',
      }))}>应用到所选范围</button>
        {pending && <button className="outline" type="button" disabled={busy || readOnly} onClick={() => void act(() => deliver(pending))}>核对原操作</button>}</div>
      {error && <p role="alert" className="learning-error">{error}</p>}
      {notice && <p role="status" className="detail">{notice}</p>}
    </div>
  </Section>
}
