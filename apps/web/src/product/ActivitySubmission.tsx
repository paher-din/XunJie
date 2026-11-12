import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from '@xunjie/ui/foundation'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { acceptsState, componentInstanceId, componentStateSchema, componentStateMediaType, componentStateName, matchesComponentState } from '@xunjie/contracts/components'
import { canonicalValue, executionQuerySchema, type ExecutionHistoryEntry, type ExecutionQuery } from '@xunjie/contracts/execution'
import { schoolSubmissionInputSchema, schoolSubmissionListSchema, schoolSubmissionReceiptSchema, schoolSubmissionSchema,
  type SchoolSubmissionInput, type SchoolSubmissionReceipt, type SchoolSubmission } from '@xunjie/contracts/school-deliveries'
import type { ReliableWorkspace } from '../reliable-workspace'
import { ReliableRecordStore } from '../reliable-workspace/record-store'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'
import type { ArtifactEntry } from '../teaching-artifacts/useTeachingArtifacts'
import { staticPreviewDocument } from '../teaching-artifacts/partial-html'
import { frameTheme } from '../teaching-artifacts/frame'
import { createExecutionTransport, createSessionTransport } from './executionTransport'
import { learningRequest, workspaceScope } from './learningTransport'
import './activity-submission.css'

export interface ActivitySubmissionTransport {
  list(): Promise<unknown>
  receipt(requestId: string): Promise<unknown>
  submit(input: SchoolSubmissionInput): Promise<unknown>
  read(submissionId: string): Promise<unknown>
  history(): Promise<ExecutionHistoryEntry[]>
  nativeSessions?(): Promise<ExecutionQuery[]>
  artifact: NonNullable<ReturnType<typeof createExecutionTransport>['artifact']>
}
interface Journal { key: string; entries: { input: SchoolSubmissionInput; receipt?: SchoolSubmissionReceipt }[] }
const records = new ReliableRecordStore<Journal>('agentControls')
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(canonicalValue(value)))))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const contentOf = ({ works, artifacts, evidence }: SchoolSubmissionInput) => ({ works, artifacts, evidence })
/** Upgrade the earlier connection-keyed journals without dropping an uncertain request on rebind. */
async function legacyJournals(key: string): Promise<Journal[]> {
  const parts = JSON.parse(key) as string[], prefix = JSON.stringify(parts.slice(0, 4)).slice(0, -1) + ','
  const db = await openWorkspaceDatabase()
  const saved = await new Promise<Journal[]>((resolve, reject) => {
    const tx = db.transaction('agentControls', 'readonly')
    const request = tx.objectStore('agentControls').getAll(IDBKeyRange.bound(prefix, prefix + '\uffff'))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => {}
  })
  return saved.filter(item => {
    const candidate = JSON.parse(item.key) as unknown[]
    return candidate.length === 6 && candidate[5] === parts[4]
  })
}
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
type Props = { activity: LearningActivity; spaceKey: string; namespace: string; authorized: boolean
  workspace: Pick<ReliableWorkspace, 'snapshot' | 'leave' | 'isReadOnly'>; artifacts: ArtifactEntry[]
  beforeFreeze?: () => Promise<void>; isComposing?: () => boolean; transport?: ActivitySubmissionTransport }

/** The account/target key also remounts every async lifetime, including late modal replies. */
export function ActivitySubmission(props: Props) {
  const { activity, workspace, namespace, spaceKey } = props
  if (activity.identity.kind !== 'school' || !activity.course || activity.purpose === 'preview' || workspace.isReadOnly()) return null
  const key = JSON.stringify(['school-submissions', workspaceScope(namespace, activity), activity.target.environmentId,
    activity.target.serviceId, activity.course.releaseId])
  return <SchoolSubmissionControl key={JSON.stringify([key, spaceKey, props.authorized, activity.status])} {...props} journalKey={key} />
}

function SchoolSubmissionControl({ activity, spaceKey, namespace, authorized, workspace, artifacts, beforeFreeze,
  isComposing, transport: provided, journalKey }: Props & { journalKey: string }) {
  const transport = useMemo<ActivitySubmissionTransport>(() => {
    if (provided) return provided
    const path = `submissions/${activity.activityId}`, executions = createExecutionTransport(activity, spaceKey, namespace)
    return { list: () => learningRequest(activity, spaceKey, namespace, path),
      receipt: id => learningRequest(activity, spaceKey, namespace, `${path}/receipts/${id}`),
      read: id => learningRequest(activity, spaceKey, namespace, `${path}/${id}`),
      submit: input => learningRequest(activity, spaceKey, namespace, path, input),
      history: () => executions.history!(), nativeSessions: () => createSessionTransport(activity, spaceKey, namespace).list(),
      artifact: id => executions.artifact!(id) }
  }, [provided, activity, spaceKey, namespace])
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [ready, setReady] = useState(false)
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [historyError, setHistoryError] = useState('')
  const [journal, setJournal] = useState<Journal>({ key: journalKey, entries: [] })
  const [receipts, setReceipts] = useState<SchoolSubmissionReceipt[]>([]), [reading, setReading] = useState<SchoolSubmission | null>(null)
  const [draft, setDraft] = useState<{ works: WorkFile[]; artifacts: SchoolSubmissionInput['artifacts']; requiredArtifacts: string[] } | null>(null)
  const [selectedArtifacts, setSelectedArtifacts] = useState<string[]>([]), [selectedEvidence, setSelectedEvidence] = useState<string[]>([])
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]), [historyLoading, setHistoryLoading] = useState(false)
  const [nativeSessions, setNativeSessions] = useState<ExecutionQuery[]>([])
  const trigger = useRef<HTMLButtonElement>(null), alive = useRef(true), composing = useRef(false), running = useRef(false)
  const artifactSource = useRef(artifacts); artifactSource.current = artifacts
  const prepared = useRef<SchoolSubmissionInput | null>(null), latest = useRef({ authorized, writable: activity.status === 'open' })
  latest.current = { authorized, writable: activity.status === 'open' && !workspace.isReadOnly() }
  const pending = journal.entries.find(entry => !entry.receipt)
  const current = () => alive.current && latest.current.authorized
  const writable = () => current() && latest.current.writable && !workspace.isReadOnly()
  const assertScope = (receipt: SchoolSubmissionReceipt) => {
    const identity = activity.identity, course = activity.course!
    if (receipt.scope.environmentId !== identity.environmentId || receipt.scope.spaceId !== identity.spaceId
      || receipt.scope.principalId !== identity.principalId || receipt.scope.activityId !== activity.activityId
      || receipt.course.courseId !== course.courseId || receipt.course.taskId !== course.taskId
      || receipt.course.releaseId !== course.releaseId || receipt.course.contentDigest !== course.contentDigest)
      throw new Error('提交回执不属于当前课程与账号。')
  }
  async function acknowledge(input: SchoolSubmissionInput, value: unknown) {
    const receipt = schoolSubmissionReceiptSchema.parse(value); assertScope(receipt)
    if (receipt.requestId !== input.requestId || receipt.contentDigest !== await digest(contentOf(input)))
      throw new Error('学校回执与这次固定内容不一致，请核对原提交。')
    const saved = await records.change(journalKey, saved => {
      if (!saved?.entries.some(entry => entry.input.requestId === input.requestId)) throw new Error('本机原提交记录不可用。')
      return { ...saved, entries: saved.entries.map(entry => entry.input.requestId === input.requestId ? { ...entry, receipt } : entry) }
    })
    if (!current()) return
    setJournal(saved); setReceipts(previous => [receipt, ...previous.filter(item => item.submissionId !== receipt.submissionId)])
    setDraft(null); prepared.current = null; setMessage('学校已接收。你可以继续修改作品，再提交新版本。'); setError('')
  }
  async function deliver(input: SchoolSubmissionInput) {
    if (!current()) return
    const known = await transport.receipt(input.requestId)
    if (!current()) return
    if (known !== null) { await acknowledge(input, known); return }
    if (!writable()) throw new Error('活动已关闭，仍可核对学校回执；重新开始活动后可重试原提交。')
    try {
      const result = await transport.submit(structuredClone(input))
      if (current()) await acknowledge(input, result)
    } catch (cause) {
      if (!current()) return
      const confirmed = await transport.receipt(input.requestId)
      if (!current()) return
      if (confirmed !== null) { await acknowledge(input, confirmed); return }
      throw cause
    }
  }
  async function retry() {
    if (running.current || !current()) return
    running.current = true; setBusy(true); setError('')
    try {
      const saved = await records.read(journalKey), original = saved?.entries.find(entry => !entry.receipt)
      if (original && current()) await deliver(schoolSubmissionInputSchema.parse(original.input))
    } catch (cause) { if (current()) setError(cause instanceof Error && cause.message.startsWith('活动已关闭') ? cause.message
      : '提交结果尚未确认。固定内容已留在本机，请恢复连接后核对原提交。') }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function loadList() {
    try {
      const list = schoolSubmissionListSchema.parse(await transport.list())
      list.submissions.forEach(assertScope)
      if (current()) setReceipts(previous => [...new Map([...previous, ...list.submissions].map(item => [item.submissionId, item])).values()]
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)))
    } catch { if (current()) setError('暂时无法读取学校提交记录，本机的原提交仍保留。') }
  }
  async function loadHistory() {
    setHistoryLoading(true); setHistoryError('')
    try {
      const [entries, sessions] = await Promise.all([transport.history(), transport.nativeSessions?.() ?? []])
      const fixedSessions = sessions.map(value => executionQuerySchema.parse(value)).filter(query => {
        if (query.scope.activityId !== activity.activityId || query.scope.environmentId !== activity.identity.environmentId
          || query.scope.spaceId !== activity.identity.spaceId || query.scope.principalId !== activity.identity.principalId)
          throw new Error('forbidden')
        return query.session && query.statusKnowledge === 'confirmed' && ['succeeded', 'failed', 'cancelled'].includes(query.state)
          && query.session.observations.length > 0
      })
      if (current()) {
        setHistory(entries.filter(entry => entry.query.output?.artifact && ['succeeded', 'failed', 'cancelled'].includes(entry.query.state)))
        setNativeSessions(fixedSessions)
      }
    } catch { if (current()) setHistoryError('实验结果暂时无法读取，可以不附实验结果提交作品。') }
    finally { if (alive.current) setHistoryLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    const start = () => { composing.current = true }, end = () => { composing.current = false }
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true)
    void (async () => {
      const legacy = await legacyJournals(journalKey)
      for (const item of legacy) item.entries.forEach(entry => {
        schoolSubmissionInputSchema.parse(entry.input)
        if (entry.receipt) assertScope(schoolSubmissionReceiptSchema.parse(entry.receipt))
      })
      if (!current()) return
      const saved = legacy.length ? await records.change(journalKey, saved => ({ key: journalKey,
        entries: [...new Map([...legacy.flatMap(item => item.entries), ...(saved?.entries ?? [])].map(entry => [entry.input.requestId, entry])).values()] }))
        : await records.read(journalKey)
      if (!current()) return
      if (saved) {
        saved.entries.forEach(entry => { schoolSubmissionInputSchema.parse(entry.input); if (entry.receipt) assertScope(entry.receipt) })
        setJournal(saved); setReceipts(saved.entries.flatMap(entry => entry.receipt ? [entry.receipt] : []).reverse())
      }
      setReady(true)
      if (saved?.entries.some(entry => !entry.receipt)) void retry()
    })().catch(() => { if (alive.current) setError('本机提交记录无法读取，请保留页面，恢复浏览器存储后重试。') })
    const online = () => { void retry() }
    window.addEventListener('online', online)
    return () => { alive.current = false; document.removeEventListener('compositionstart', start, true)
      document.removeEventListener('compositionend', end, true); window.removeEventListener('online', online) }
    // The keyed control owns one immutable subject/target lifetime. Transport refreshes do not replay effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journalKey, authorized])

  async function begin() {
    if (!current() || running.current || !ready) return
    if (composing.current || isComposing?.()) { setError('请先完成当前输入，再打开提交。'); return }
    running.current = true; setBusy(true); setError(''); setMessage(''); setReading(null)
    try {
      // An existing immutable request must remain reviewable while today's workspace or page templates are loading.
      if (pending || !latest.current.writable) {
        setOpen(true); void loadList(); return
      }
      const state = workspace.snapshot()
      if (!state.ready || state.conflict || state.error) throw new Error('请先处理作品的保存问题或版本分歧，再提交。')
      // Capture synchronously after the composition guard. Protection and network waits cannot change this version.
      const captured = structuredClone({ works: state.files, entries: artifactSource.current })
      const requiredArtifacts: string[] = []
      for (const file of captured.works) {
        if (file.mediaType !== componentStateMediaType || !/^components\/artifact-[0-9a-f-]{36}\.json$/.test(file.name)) continue
        const entry = captured.entries.find(item => item.revision && componentStateName(item.revision.binding.key) === file.name)
        if (!entry?.revision || entry.artifact.activeRevisionId !== entry.revision.revisionId
          || !matchesComponentState(entry.revision.binding, activity.activityId, file))
          throw new Error('作品中的教学页面尚未就绪，请回到原页面核对后再提交。')
        requiredArtifacts.push(entry.artifact.artifactId)
      }
      const fixed = { works: captured.works, requiredArtifacts, artifacts: captured.entries.flatMap(entry => entry.revision ? [{
        artifactId: entry.artifact.artifactId, revisionId: entry.revision.revisionId, payload: entry.revision.payload }] : []) }
      await beforeFreeze?.(); await workspace.leave()
      if (!current()) return
      const protectedState = workspace.snapshot()
      if (protectedState.conflict || protectedState.error) throw new Error('请先处理作品的保存问题或版本分歧，再提交。')
      if (!pending && latest.current.writable) {
        setDraft(fixed)
        prepared.current = null; setSelectedArtifacts(requiredArtifacts); setSelectedEvidence([])
      }
      setOpen(true); void loadList(); void loadHistory()
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '当前输入尚未保护，请保留页面后重试。') }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function confirm() {
    if (!draft || !writable() || running.current) return
    running.current = true; setBusy(true); setError('')
    let protectedInput = false, protecting = false
    try {
      if (!prepared.current) {
        const evidence: SchoolSubmissionInput['evidence'] = []
        for (const requestId of selectedEvidence) {
          const session = nativeSessions.find(query => query.requestId === requestId)
          if (session?.session) {
            evidence.push({ requestId, executionRef: session.executionRef, mediaType: 'application/json',
              text: JSON.stringify({ kind: 'native-session-observations', state: session.state,
                observations: session.session.observations, finalObservation: session.session.observation }) })
            continue
          }
          const entry = history.find(item => item.query.requestId === requestId), original = await transport.artifact(requestId)
          if (!writable()) return
          if (!entry?.query.output?.artifact || !original || original.requestId !== requestId || original.executionRef !== entry.query.executionRef
            || original.sha256 !== entry.query.output.artifact.sha256 || original.byteLength !== entry.query.output.artifact.byteLength
            || original.mediaType !== entry.query.output.artifact.mediaType || original.name !== entry.query.output.artifact.name)
            throw new Error('选中的实验原结果无法核对，请重新读取实验结果。')
          evidence.push({ requestId, executionRef: original.executionRef, mediaType: original.mediaType, text: original.text,
            ...(original.resources ? { resources: original.resources } : {}) })
        }
        const parsed = schoolSubmissionInputSchema.safeParse({ requestId: crypto.randomUUID(), works: draft.works,
          artifacts: draft.artifacts.filter(item => selectedArtifacts.includes(item.artifactId)), evidence })
        if (!parsed.success) throw new Error('请至少选择一份作品或结果，并将提交内容控制在 24 MiB 以内。')
        prepared.current = structuredClone(parsed.data)
      }
      const input = prepared.current
      protecting = true
      const saved = await records.change(journalKey, saved => {
        if (saved?.entries.some(entry => !entry.receipt)) return saved
        return { key: journalKey, entries: [...(saved?.entries ?? []), { input: structuredClone(input) }] }
      })
      protectedInput = true
      if (!writable()) return
      setJournal(saved)
      const original = saved.entries.find(entry => !entry.receipt)!
      await deliver(original.input)
    } catch (cause) {
      if (!protecting) prepared.current = null
      if (current()) setError(cause instanceof Error && /^(选中的实验|请至少选择)/.test(cause.message) ? cause.message
        : protectedInput ? '学校尚未确认接收。固定内容已留在本机，恢复连接后可核对原提交。'
          : protecting ? '这次提交尚未在本机可靠保留，没有发往学校。请保留页面，恢复浏览器存储后重试。'
            : '暂时无法固定所选内容，请重新读取实验结果或检查文件内容后重试。')
    }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  async function read(receipt: SchoolSubmissionReceipt) {
    if (!current() || running.current) return
    running.current = true; setBusy(true); setError(''); setReading(null)
    try {
      const fixed = schoolSubmissionSchema.parse(await transport.read(receipt.submissionId)); assertScope(fixed)
      if (fixed.submissionId !== receipt.submissionId || fixed.requestId !== receipt.requestId || fixed.contentDigest !== receipt.contentDigest
        || fixed.contentDigest !== await digest(contentOf(fixed))) throw new Error('提交版本校验未通过。')
      if (current()) setReading(fixed)
    } catch { if (current()) setError('暂时无法回读这次提交，请恢复连接后重试。') }
    finally { running.current = false; if (alive.current) setBusy(false) }
  }
  const toggle = (set: typeof setSelectedArtifacts, id: string) => set(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id])
  return <>
    <button ref={trigger} type="button" className="ws-btn solid" disabled={busy || !authorized || !ready}
      onPointerDown={event => { if (composing.current || isComposing?.()) event.preventDefault() }}
      onClick={() => void begin()}>{pending ? '核对提交' : activity.status === 'open' ? '提交作品' : '提交记录'}</button>
    {!open && error && <span className="activity-submission-trigger-error" role="status">{error}</span>}
    <Dialog.Root open={open} onOpenChange={next => { if (!busy) setOpen(next) }}>
      <Dialog.Portal><Dialog.Overlay className="xj-confirm-overlay" />
        <Dialog.Content className="xj-confirm-dialog activity-submission-dialog" aria-busy={busy || undefined}
          onCloseAutoFocus={event => { event.preventDefault(); if (trigger.current?.isConnected) trigger.current.focus() }}>
          <Dialog.Title className="xj-confirm-title">提交作品</Dialog.Title>
          <Dialog.Description className="xj-confirm-description">将本次选定的作品版本交给学校。之后的修改不会改变这次提交。</Dialog.Description>
          {error && <p role="alert" className="activity-submission-error">{error}</p>}
          {message && <p role="status">{message}</p>}
          {pending ? <section className="activity-submission-section" aria-label="待确认的原提交">
            <h3>这次提交尚未确认</h3><SubmissionContents input={pending.input} activityId={activity.activityId} />
            <Button type="button" disabled={busy || !authorized} onClick={() => void retry()}>核对并重试原提交</Button>
          </section> : draft && <section className="activity-submission-section" aria-label="本次提交清单">
            <h3>本次作品</h3><WorkContents works={draft.works} />
            {draft.artifacts.length > 0 && <fieldset disabled={busy || !!prepared.current}><legend>教学页面</legend>
              {draft.artifacts.map(item => <label key={item.artifactId} className="activity-submission-choice">
                <input type="checkbox" checked={selectedArtifacts.includes(item.artifactId)} disabled={draft.requiredArtifacts.includes(item.artifactId)}
                  title={draft.requiredArtifacts.includes(item.artifactId) ? '当前作品包含此页面的状态，需一同提交' : undefined}
                  onChange={() => toggle(setSelectedArtifacts, item.artifactId)} />{item.payload.title}</label>)}
            </fieldset>}
            <fieldset disabled={busy || !!prepared.current}><legend>附上实验结果</legend>
              {historyLoading ? <p role="status" aria-label="正在读取实验结果" /> : history.length || nativeSessions.length ? <>{history.map(entry => <label key={entry.query.requestId} className="activity-submission-choice">
                <input type="checkbox" checked={selectedEvidence.includes(entry.query.requestId)} onChange={() => toggle(setSelectedEvidence, entry.query.requestId)} />
                {entry.query.output!.artifact!.name}<span>{date(entry.createdAt)}</span></label>)}
                {nativeSessions.map(query => <label key={query.requestId} className="activity-submission-choice">
                  <input type="checkbox" checked={selectedEvidence.includes(query.requestId)} onChange={() => toggle(setSelectedEvidence, query.requestId)} />
                  本机会话观察<span>{date(query.session!.observations.at(-1)!.at)}</span></label>)}</> : <p>没有可附上的实验结果。</p>}
              {historyError && <p>{historyError}<button type="button" className="ws-btn ghost" onClick={() => void loadHistory()}>重新读取</button></p>}
            </fieldset>
            <Button type="button" disabled={busy || !authorized || !latest.current.writable} onClick={() => void confirm()}>确认提交</Button>
          </section>}
          <section className="activity-submission-section" aria-label="我的提交记录"><header><h3>提交记录</h3>
            <button type="button" className="ws-btn ghost" disabled={busy} onClick={() => void loadList()}>刷新记录</button></header>
            {receipts.length ? <ol className="activity-submission-records">{receipts.map(receipt => <li key={receipt.submissionId}>
              <span>学校已接收 <time dateTime={receipt.receivedAt}>{date(receipt.receivedAt)}</time></span>
              <button type="button" className="ws-btn ghost" disabled={busy} onClick={() => void read(receipt)}>查看提交内容</button>
            </li>)}</ol> : <p>还没有学校已确认的提交。</p>}
          </section>
          {reading && <section className="activity-submission-section" aria-label="已提交作品（只读）"><h3>已提交作品 · 只读</h3><SubmissionContents input={reading} activityId={activity.activityId} /></section>}
          <div className="xj-confirm-actions"><Dialog.Close asChild><Button type="button" variant="outline" disabled={busy}>返回作品</Button></Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

function WorkContents({ works }: { works: WorkFile[] }) {
  const files = works.filter(file => file.mediaType !== componentStateMediaType || !/^components\/artifact-[0-9a-f-]{36}\.json$/.test(file.name))
  if (works.length && !files.length) return null
  return files.length ? <div className="activity-submission-files">{files.map(file => <details key={file.objectId}>
    <summary>{file.name}</summary><pre>{file.value}</pre></details>)}</div> : <p>本次没有作品文件。</p>
}
function SubmissionContents({ input, activityId }: { input: SchoolSubmissionInput; activityId: string }) {
  return <><WorkContents works={input.works} />{input.artifacts.map(item => <SubmittedArtifact key={item.artifactId}
    artifact={item} works={input.works} activityId={activityId} />)}{input.evidence.map(item => <details key={item.requestId}>
    <summary>实验结果</summary><EvidenceContents text={item.text} />{item.resources?.map(resource => <details key={resource.contentId}>
      <summary>{resource.name}</summary><pre>{resource.text}</pre></details>)}</details>)}</>
}

function EvidenceContents({ text }: { text: string }) {
  try {
    const value = JSON.parse(text) as { kind?: string; observations?: { seq: number; state: unknown }[] }
    if (value.kind === 'native-session-observations' && Array.isArray(value.observations)
      && value.observations.every(item => item && typeof item === 'object' && Number.isSafeInteger(item.seq)
        && item.seq > 0 && Object.hasOwn(item, 'state')))
      return <ol>{value.observations.map(item => <li key={item.seq}>第 {item.seq} 次观察<pre>{JSON.stringify(item.state, null, 2)}</pre></li>)}</ol>
  } catch { /* Other retained experiment formats keep their original visible text. */ }
  return <pre>{text}</pre>
}

function SubmittedArtifact({ artifact, works, activityId }: {
  artifact: SchoolSubmissionInput['artifacts'][number]; works: WorkFile[]; activityId: string
}) {
  const [theme, setTheme] = useState(frameTheme)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(frameTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const previewDocument = useMemo(() => staticPreviewDocument(artifact.payload.html,
    { canvas: theme.canvas, ink: theme.ink, line: theme.line, muted: theme.muted }), [artifact.payload.html, theme])
  const key = `artifact-${artifact.artifactId}`
  const file = works.find(file => file.name === componentStateName(key) && file.kind === 'state'
    && file.encoding === 'json' && file.mediaType === componentStateMediaType)
  let content: Record<string, unknown> | undefined
  if (file) {
    try {
      const state = componentStateSchema.parse(JSON.parse(file.value))
      if (state.instanceId === componentInstanceId(activityId, key) && state.componentId === artifact.artifactId
        && state.stateVersion === artifact.payload.stateVersion && acceptsState(artifact.payload.stateShape, state.content))
        content = state.content as Record<string, unknown>
    } catch { /* Keep unavailable submitted state explicit; never substitute the page's initial state. */ }
  }
  const savedContent = content
  return <details><summary>{artifact.payload.title}</summary>
    <iframe className="activity-submission-preview" title={artifact.payload.title + '（只读静态预览）'} sandbox="" srcDoc={previewDocument} />
    {savedContent ? <dl className="activity-submission-state">{artifact.payload.semanticFields.map(field => <div key={field.key}>
      <dt>{field.meaning}</dt><dd><pre>{typeof savedContent[field.key] === 'string' ? savedContent[field.key] as string : JSON.stringify(savedContent[field.key], null, 2)}</pre></dd>
    </div>)}</dl> : <p>本次未包含可读取的页面状态。</p>}
  </details>
}
