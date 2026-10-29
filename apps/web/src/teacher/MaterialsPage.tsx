import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Icon, IconText } from '../icons'
import { useTeacher } from './context'
import type { TeacherResource } from './types'
import './review-materials.css'

const kinds: Record<TeacherResource['kind'], { label: string; description: string }> = {
  learning: { label: '学习材料', description: '面向学习活动的讲义、概念与任务材料。' },
  reference: { label: '参考资料', description: '为项目设计或学习提供补充依据。' },
  private_answer: { label: '教师私有答案', description: '教师专属评价材料，不向学生或辅导 Agent 开放。' },
  validation: { label: '验证资产', description: '课程验证专用材料，不向学生或辅导 Agent 开放。' },
}
function byteSize(text: string) { return new TextEncoder().encode(text).byteLength }
function formatSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB` }

export default function MaterialsPage() {
  const { preview, data, courseId, saveResource, notify, pendingCommand } = useTeacher()
  const CONTENT_LIMIT = preview ? 1024 * 1024 : 256 * 1024
  const limitLabel = preview ? '1 MiB' : '256 KiB'
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [visibility, setVisibility] = useState('all')
  const [opened, setOpened] = useState<TeacherResource | null>(null)
  const [importing, setImporting] = useState(false)
  const [importTab, setImportTab] = useState<'file' | 'paste'>('file')
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<TeacherResource['kind']>('learning')
  const [source, setSource] = useState('')
  const [content, setContent] = useState('')
  const [student, setStudent] = useState(false)
  const [tutor, setTutor] = useState(false)
  const [teacherDesign, setTeacherDesign] = useState(false)
  const [importCourseId, setImportCourseId] = useState('')
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const contentDialog = useRef<HTMLDialogElement>(null)
  const importDialog = useRef<HTMLDialogElement>(null)
  const readGeneration = useRef(0)
  const resources = data.resources.filter(r => !courseId || courseId === 'all' || r.courseId === courseId)
  const filtered = resources.filter(r => (kindFilter === 'all' || r.kind === kindFilter) &&
    (visibility === 'all' || visibility === 'private' && !r.student && !r.tutor || visibility === 'student' && r.student || visibility === 'tutor' && r.tutor || visibility === 'teacherDesign' && r.teacherDesign) &&
    `${r.title} ${r.source} ${r.content}`.toLowerCase().includes(query.toLowerCase()))
  const privateKind = kind === 'private_answer' || kind === 'validation'
  const bytes = byteSize(content)

  useEffect(() => { if (opened && !contentDialog.current?.open) contentDialog.current?.showModal() }, [opened])
  useEffect(() => { if (importing && !importDialog.current?.open) importDialog.current?.showModal() }, [importing])
  useEffect(() => { if (privateKind) { setStudent(false); setTutor(false) } }, [privateKind])
  useEffect(() => { setOpened(null); contentDialog.current?.close() }, [courseId])

  function startImport() {
    setImportTab('file'); setTitle(''); setKind('learning'); setSource(''); setContent(''); setStudent(false); setTutor(false)
    setTeacherDesign(false); setImportCourseId(courseId && courseId !== 'all' ? courseId : data.courses[0]?.id || ''); setFilename(''); setError(''); setReading(false)
    setImporting(true)
  }
  function closeImport() {
    if (saving) return
    readGeneration.current += 1
    importDialog.current?.close(); setImporting(false)
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const generation = ++readGeneration.current
    setError('')
    if (!/\.(txt|md|markdown)$/i.test(file.name)) { setError('仅支持 TXT、MD 和 Markdown 文本文件。'); event.target.value = ''; return }
    if (file.size > CONTENT_LIMIT) { setError(`文件超过 ${limitLabel}，请精简后重新选择。`); event.target.value = ''; return }
    setReading(true)
    try {
      const text = await file.text()
      if (generation !== readGeneration.current) return
      if (byteSize(text) > CONTENT_LIMIT) { setError(`UTF-8 正文超过 ${limitLabel}，请精简后重新选择。`); return }
      if (text.includes('\u0000') || text.includes('\ufffd')) { setError('无法按 UTF-8 文本读取，请将文件另存为 UTF-8 后重试。'); return }
      setContent(text); setFilename(file.name)
      if (!title.trim()) setTitle(file.name.replace(/\.(txt|md|markdown)$/i, ''))
      if (!source.trim()) setSource(file.name)
    } catch { if (generation === readGeneration.current) setError('文件读取失败，请重新选择，或粘贴正文。') }
    finally { if (generation === readGeneration.current) setReading(false) }
  }
  async function commitImport() {
    if (saving || reading) return
    if (!importCourseId || !title.trim() || (preview && !source.trim()) || !content.trim()) { setError('请填写资料名称、所属课程和正文。'); return }
    if (bytes > CONTENT_LIMIT) { setError(`正文超过 ${limitLabel}，请精简后重试。`); return }
    if (content.includes('\u0000')) { setError('正文包含不可用的空字符，请移除后重试。'); return }
    setSaving(true); setError('')
    try {
      await saveResource({ id: `resource-${crypto.randomUUID()}`, courseId: importCourseId, title: title.trim(), kind, source: source.trim(), content,
        format: importTab === 'file' && filename ? /\.(md|markdown)$/i.test(filename) ? 'markdown' : 'txt' : 'paste',
        student: !privateKind && student, tutor: !privateKind && tutor, teacherDesign, version: 1 })
      importDialog.current?.close(); setImporting(false)
      notify(preview ? '资料已导入本机预览；未上传至教学服务。' : '资料已保存为课程材料版本。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入未完成，请核对原教师操作。') }
    finally { setSaving(false) }
  }

  return <div className="t-rm-page">
    <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">A WELL-PREPARED CLASSROOM</div><h1>课程材料</h1><p>把好的教学依据，放在合适的可见范围里。</p></div><button type="button" className="t-rm-button t-rm-button-primary" disabled={!data.courses.length} onClick={startImport}><IconText name="add">导入资料</IconText></button></div>
    <div className="t-rm-material-intro"><span className="t-rm-material-book"><Icon name="book-2" size={28} /></span><div><h2>资料有边界，设计有依据</h2><p>学生、辅导 Agent 与教师设计分别配置。私有答案和验证资产只留在教师侧。</p></div><div className="t-rm-material-total"><strong>{resources.length}</strong><span>份课程资料</span></div></div>
    <div className="t-rm-material-layout"><aside className="t-rm-material-categories" aria-label="资料分类"><div className="t-rm-eyebrow">资料分类</div><button type="button" className={kindFilter === 'all' ? 'is-active' : ''} onClick={() => setKindFilter('all')} aria-pressed={kindFilter === 'all'}><IconText name="folder-with-files">全部资料</IconText><span>{resources.length}</span></button>{Object.entries(kinds).map(([value, item]) => <button type="button" key={value} className={kindFilter === value ? 'is-active' : ''} onClick={() => setKindFilter(value)} aria-pressed={kindFilter === value}><IconText name={value === 'private_answer' || value === 'validation' ? 'lock-keyhole' : value === 'learning' ? 'book-2' : 'file-text'}>{item.label}</IconText><span>{resources.filter(r => r.kind === value).length}</span></button>)}<div className="t-rm-material-privacy"><Icon name="shield-check" size={20} /><p>新导入资料默认不向学生和辅导 Agent 开放。</p></div></aside>
      <section className="t-rm-material-main"><div className="t-rm-toolbar"><label className="t-rm-search"><Icon name="minimalistic-magnifier" /><input aria-label="搜索课程资料" placeholder="搜索名称、来源或正文" value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" aria-label="清空资料搜索" onClick={() => setQuery('')}><Icon name="close" size={14} /></button>}</label><label className="t-rm-filter-label">范围<select aria-label="筛选资料可见范围" value={visibility} onChange={e => setVisibility(e.target.value)}><option value="all">全部范围</option><option value="private">仅教师侧</option><option value="student">学生可见</option><option value="tutor">辅导可用</option><option value="teacherDesign">教师设计可用</option></select></label></div>
      {filtered.length ? <div className="t-rm-material-list">{filtered.map(resource => <button type="button" className="t-rm-material-card" key={resource.id} onClick={() => setOpened(resource)}><span className={`t-rm-resource-icon ${resource.kind === 'private_answer' || resource.kind === 'validation' ? 'is-private' : ''}`}><Icon name={resource.kind === 'private_answer' || resource.kind === 'validation' ? 'lock-keyhole' : 'file-text'} size={22} /></span><div className="t-rm-material-card-main"><div className="t-rm-material-title"><strong>{resource.title}</strong><span className="t-rm-mono">{preview ? `v${resource.version}` : '固定版本'}</span></div><p>{resource.content.replace(/^#+\s*/gm, '').slice(0, 90)}</p><div className="t-rm-material-card-meta"><span>{kinds[resource.kind].label}</span><span>{resource.source}</span><span>{formatSize(byteSize(resource.content))}</span></div><div className="t-rm-visibility-tags">{resource.student && <span><Icon name="user-rounded" size={12} />学生可见</span>}{resource.tutor && <span><Icon name="chat-round-dots" size={12} />辅导可用</span>}{resource.teacherDesign && <span><Icon name="pen" size={12} />教师设计</span>}{!resource.student && !resource.tutor && <span className="t-rm-private-tag"><Icon name="lock-keyhole" size={12} />仅教师侧</span>}</div></div><Icon name="alt-arrow-right" size={16} /></button>)}</div> : <div className="t-rm-empty"><Icon name="folder-search" size={36} /><h2>{resources.length ? '没有符合条件的资料' : '从第一份课程材料开始'}</h2><p>{resources.length ? '调整分类、可见范围或搜索词，再找找看。' : `支持 TXT、Markdown 或直接粘贴正文，每份不超过 ${limitLabel}。`}</p>{resources.length ? <button type="button" className="t-rm-button" onClick={() => { setQuery(''); setKindFilter('all'); setVisibility('all') }}>重置筛选</button> : <button type="button" className="t-rm-button" disabled={!data.courses.length} onClick={startImport}>导入第一份资料</button>}</div>}
      <p className="t-rm-page-footnote"><Icon name="info-circle" size={14} />{preview ? '资料与可见范围只保存于本机预览。正式访问范围仍须由服务端校验。' : '资料权限由服务端会话和所属课程决定。'}</p></section>
    </div>
    <dialog ref={contentDialog} className="t-rm-dialog t-rm-document-dialog" onClose={() => setOpened(null)} aria-labelledby="t-rm-resource-title">{opened && <><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">{kinds[opened.kind].label} · {preview ? `v${opened.version}` : '固定版本'}</span><h2 id="t-rm-resource-title">{opened.title}</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭资料正文" onClick={() => contentDialog.current?.close()}><Icon name="close" /></button></div><div className="t-rm-dialog-body"><div className="t-rm-meta-pairs"><span>来源<strong>{opened.source}</strong></span><span>所属课程<strong>{data.courses.find(c => c.id === opened.courseId)?.title || opened.courseId}</strong></span></div><div className="t-rm-visibility-tags"><span>学生：{opened.student ? '可见' : '不可见'}</span><span>辅导 Agent：{opened.tutor ? '可用' : '不可用'}</span><span>教师设计：{opened.teacherDesign ? '可用' : '不可用'}</span></div><pre className="t-rm-document-content">{opened.content}</pre></div><div className="t-rm-dialog-footer"><span className="t-rm-caption">{formatSize(byteSize(opened.content))} · 保留原始文本</span><button type="button" className="t-rm-button" onClick={() => contentDialog.current?.close()}>关闭</button></div></>}</dialog>
    <dialog ref={importDialog} className="t-rm-dialog t-rm-import-dialog" onCancel={event => { if (saving) event.preventDefault() }} onClose={() => { readGeneration.current += 1; setImporting(false) }} aria-labelledby="t-rm-import-title">{importing && <form onSubmit={e => { e.preventDefault(); void commitImport() }}><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">{preview ? '仅本机预览' : '当前任教课程'} · TXT / MARKDOWN</span><h2 id="t-rm-import-title">导入课程材料</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭导入资料" onClick={closeImport}><Icon name="close" /></button></div><div className="t-rm-dialog-body"><fieldset disabled={saving || pendingCommand} style={{ border: 0, padding: 0, margin: 0 }}><div className="t-rm-form-grid"><label className="t-rm-field"><span>资料名称 <em>必填</em></span><input autoFocus value={title} disabled={reading} onChange={e => setTitle(e.target.value)} placeholder="例如：TextScope 项目说明" maxLength={200} required /></label><label className="t-rm-field"><span>所属课程</span><select value={importCourseId} onChange={e => setImportCourseId(e.target.value)} required>{data.courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><label className="t-rm-field"><span>资料分类</span><select value={kind} onChange={e => setKind(e.target.value as TeacherResource['kind'])}>{Object.entries(kinds).filter(([value]) => preview || value !== 'reference').map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>{preview && <label className="t-rm-field"><span>材料来源 <em>必填</em></span><input value={source} disabled={reading} onChange={e => setSource(e.target.value)} placeholder="文件名、作者或课程来源" maxLength={500} required /></label>}</div><p className="t-rm-caption t-rm-kind-description">{kinds[kind].description}</p><div className="t-rm-import-tabs" role="group" aria-label="资料输入方式"><button type="button" disabled={reading} aria-pressed={importTab === 'file'} className={importTab === 'file' ? 'is-active' : ''} onClick={() => setImportTab('file')}><IconText name="paperclip">上传文本</IconText></button><button type="button" disabled={reading} aria-pressed={importTab === 'paste'} className={importTab === 'paste' ? 'is-active' : ''} onClick={() => setImportTab('paste')}><IconText name="clipboard-text">粘贴正文</IconText></button></div>{importTab === 'file' && <div className="t-rm-file-drop"><Icon name="file-text" size={28} /><strong>{reading ? '正在读取…' : filename || '选择一份 TXT 或 Markdown 文件'}</strong><span>UTF-8 编码 · 单份不超过 {limitLabel}</span><input ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" aria-label="选择课程材料文件" onChange={readFile} disabled={reading} /><button type="button" className="t-rm-button" onClick={() => fileInput.current?.click()} disabled={reading}>{filename ? '重新选择' : '选择文件'}</button></div>}{(importTab === 'paste' || content) && <label className="t-rm-field t-rm-content-field"><span>{importTab === 'file' ? '正文预览与编辑' : '材料正文'}<small className={bytes > CONTENT_LIMIT ? 't-rm-error' : ''}>{formatSize(bytes)} / {limitLabel}</small></span><textarea value={content} disabled={reading} onChange={e => setContent(e.target.value)} rows={7} placeholder="在这里粘贴课程正文或 Markdown。" required /></label>}<fieldset className="t-rm-visibility-fieldset"><legend>可见范围与使用用途</legend><label><input type="checkbox" checked={student} disabled={privateKind} onChange={e => setStudent(e.target.checked)} /><span><strong>学生可见</strong><small>允许关联活动的学生读取</small></span></label><label><input type="checkbox" checked={tutor} disabled={privateKind} onChange={e => setTutor(e.target.checked)} /><span><strong>辅导 Agent 可用</strong><small>允许进入学生辅导上下文</small></span></label><label><input type="checkbox" checked={teacherDesign} onChange={e => setTeacherDesign(e.target.checked)} /><span><strong>教师设计可用</strong><small>允许用于教师项目设计</small></span></label></fieldset><p className="t-rm-local-note"><Icon name="lock-keyhole" size={14} />{privateKind ? '私有答案与验证资产禁止向学生、辅导 Agent 开放。' : '学生和辅导默认不可见；勾选前请确认材料内容。'}</p></fieldset>{error && <p className="t-rm-error" role="alert">{error}</p>}</div><div className="t-rm-dialog-footer"><button type="button" className="t-rm-button" onClick={closeImport}>取消</button><button type="submit" className="t-rm-button t-rm-button-primary" disabled={saving || pendingCommand || reading || !content.trim() || bytes > CONTENT_LIMIT}><IconText name="add">{saving ? '正在保存…' : preview ? '导入到本机预览' : '保存课程材料'}</IconText></button></div></form>}</dialog>
  </div>
}
