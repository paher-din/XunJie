import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { MaterialsHeading, MaterialsIntro, MaterialsFootnote, MaterialsCategories, MaterialsToolbar, MaterialCard, MaterialsEmpty, MaterialDocumentDialog, MaterialImportDialog } from '@xunjie/ui/teacher-review'
import { useTeacher } from './context'
import type { TeacherResource } from './types'
import './review-materials.css'

function byteSize(text: string) { return new TextEncoder().encode(text).byteLength }

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
    <MaterialsHeading canImport={!!data.courses.length} onImport={startImport} />
    <MaterialsIntro count={resources.length} />
    <div className="t-rm-material-layout"><MaterialsCategories resources={resources} kindFilter={kindFilter} onChange={setKindFilter} />
      <section className="t-rm-material-main">
        <MaterialsToolbar query={query} visibility={visibility} onQueryChange={setQuery} onVisibilityChange={setVisibility} />
        {filtered.length ? <div className="t-rm-material-list">{filtered.map(resource =>
          <MaterialCard key={resource.id} resource={resource} preview={preview} onOpen={() => setOpened(resource)} />
        )}</div> : <MaterialsEmpty count={resources.length} canImport={!!data.courses.length} limitLabel={limitLabel}
          onReset={() => { setQuery(''); setKindFilter('all'); setVisibility('all') }} onImport={startImport} />}
        <MaterialsFootnote preview={preview} />
      </section>
    </div>
    <MaterialDocumentDialog opened={opened} preview={preview} courses={data.courses} contentDialog={contentDialog} onClosed={() => setOpened(null)} />
    <MaterialImportDialog importDialog={importDialog} fileInput={fileInput} importing={importing} preview={preview}
      saving={saving} pendingCommand={pendingCommand} reading={reading} title={title} importCourseId={importCourseId} kind={kind}
      source={source} importTab={importTab} content={content} filename={filename} student={student} tutor={tutor}
      teacherDesign={teacherDesign} contentLimit={CONTENT_LIMIT} limitLabel={limitLabel}
      error={error} courses={data.courses} setTitle={setTitle} setImportCourseId={setImportCourseId} setKind={setKind}
      setSource={setSource} setImportTab={setImportTab} setContent={setContent} setStudent={setStudent} setTutor={setTutor}
      setTeacherDesign={setTeacherDesign} onFileChange={readFile} closeImport={closeImport}
      onClosed={() => { readGeneration.current += 1; setImporting(false) }} onSubmit={() => { void commitImport() }} />
  </div>
}
