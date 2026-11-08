import { useEffect, useRef, useState } from 'react'
import { pendingTeacherCommands, teacherCommand } from './backend'
import { adoptDesignProposal, designFields, proposalPatch, readDesignRun, runningDesignJob } from './designAgent'
import type { DesignJob, DesignMode, DesignProposal, DesignRun } from './designAgent'
import type { BlueprintContent, BlueprintDraft, TeacherWorkbench } from './wire'
import './design-agent.css'

import { DesignAgentView } from '@xunjie/ui/teacher-design'
export { DesignValue as Value } from '@xunjie/ui/teacher-design'

const describe = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请核对原教师操作。'
interface Props {
  account: string; workbench: TeacherWorkbench; draft?: BlueprintDraft; content: BlueprintContent
  disabled: boolean; dirty: boolean; onAdopt: (draft: BlueprintDraft) => void
}
export default function DesignAgentPanel(props: Props) {
  const { account, workbench, draft, content, disabled, dirty } = props
  const editor = JSON.stringify(content)
  const storageKey = `xunjie.teacher.design-ai.v1:${encodeURIComponent(account)}:${encodeURIComponent(workbench.courseId)}:${draft?.blueprintId ?? 'new'}`
  const [mode, setMode] = useState<DesignMode>(draft ? 'patch' : 'candidates')
  const [request, setRequest] = useState('')
  const [fields, setFields] = useState<(keyof BlueprintContent)[]>(['problem'])
  const [selected, setSelected] = useState<string[]>([])
  const [samples, setSamples] = useState<string[]>([])
  const [run, setRun] = useState<DesignRun | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as DesignRun | null
      return value && value.courseId === workbench.courseId && value.blueprintId === (draft?.blueprintId ?? null)
        && typeof value.jobId === 'string' && typeof value.editor === 'string' && Array.isArray(value.fields) ? value : null
    } catch { return null }
  })
  const [job, setJob] = useState<DesignJob | null>(null)
  const [proposal, setProposal] = useState<DesignProposal | null>(null)
  const [candidate, setCandidate] = useState<number | undefined>()
  const [restoreId, setRestoreId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(props); latest.current = props
  const alive = useRef(true)
  const serial = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++ } }, [])
  function remember(next: DesignRun) {
    sessionStorage.setItem(storageKey, JSON.stringify(next))
    setRun(next); setJob(null); setProposal(null); setCandidate(undefined)
  }
  const paragraphs = workbench.resources.filter(resource => resource.available && resource.teacherDesignAllowed)
    .flatMap(resource => resource.material.paragraphs.map(paragraph => ({
      ...paragraph, resourceVersionId: resource.resourceVersionId,
      title: resource.material.title, private: resource.material.kind !== 'learning_material',
    })))
  const stale = !!run && (run.generation !== workbench.recoveryGeneration || run.editor !== editor ||
    run.baseRevision !== (draft?.revision ?? 0) || (proposal && (!proposal.applicable || proposal.baseRevision !== run.baseRevision)))
  const active = !!run?.jobId && (!job || runningDesignJob(job))
  const blocked = disabled || busy || !!(draft && dirty)
  const prefix = draft ? `/blueprints/${encodeURIComponent(draft.blueprintId)}` : `/courses/${encodeURIComponent(workbench.courseId)}/blueprints`
  const pending = pendingTeacherCommands(account).find(item => draft
    ? [`${prefix}/proposals`, `${prefix}/rubric-trials`].includes(item.path) : item.path === prefix)

  useEffect(() => {
    if (!run?.jobId) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const original = run, pollDeadline = Date.now() + 60_000
    async function read() {
      const ticket = ++serial.current
      try {
        const result = await readDesignRun(original)
        if (cancelled || !alive.current || ticket !== serial.current) return
        setJob(result.job); setProposal(result.proposal ?? null); setError('')
        if (runningDesignJob(result.job)) {
          if (Date.now() < pollDeadline) timer = setTimeout(() => { void read() }, 1500)
          else setError('持续等待仍未取得终态，已停止自动读取。请重新读取原任务或明确取消，不要重复生成。')
        }
      } catch (cause) { if (!cancelled && alive.current && ticket === serial.current) setError(describe(cause)) }
    }
    void read()
    return () => { cancelled = true; serial.current++; clearTimeout(timer) }
  }, [run])

  async function generate(recover = false) {
    if (busy || (!recover && (blocked || active))) return
    const original = latest.current
    setBusy(true); setError('')
    try {
      let path: string, body: unknown, next: DesignRun
      if (recover) {
        if (!pending || !run) throw new Error('没有可核对的原生成请求。')
        path = pending.path; body = JSON.parse(pending.wire); next = run
      } else {
        if (!request.trim()) throw new Error('请填写设计要求。')
        if (draft && mode !== 'rubric_trial' && !fields.length) throw new Error('请选择允许建议修改的字段。')
        const references = selected.map(id => {
          const paragraph = paragraphs.find(p => p.paragraphId === id)
          if (!paragraph) throw new Error('材料权限或版本已变化，请重新选择。')
          return { resourceVersionId: paragraph.resourceVersionId, paragraphId: id, contentHash: paragraph.contentHash }
        })
        const sampleReferenceIds = samples.filter(id => selected.includes(id))
        if (mode === 'rubric_trial' && !sampleReferenceIds.length) throw new Error('请明确选择至少一个教师认可的试评样例段落。')
        path = draft ? `${prefix}/${mode === 'rubric_trial' ? 'rubric-trials' : 'proposals'}` : prefix
        body = { recoveryGeneration: workbench.recoveryGeneration, request, references,
          ...(draft ? { expectedRevision: draft.revision, ...(mode === 'rubric_trial' ? { sampleReferenceIds } : { mode, allowedFields: fields }) }
            : { mode: 'agent', generationMode: mode }) }
        next = { jobId: '', courseId: workbench.courseId, blueprintId: draft?.blueprintId ?? null, baseRevision: draft?.revision ?? 0,
          generation: workbench.recoveryGeneration, editor, fields: [...fields] }
        // Preserve the editor basis before any request; an unknown response must not cause a fresh paid job.
        remember(next)
      }
      const accepted = await teacherCommand<{ jobId: string; status: string }>(account, 'POST', path, body)
      if (!accepted?.jobId || accepted.status !== 'queued') throw new Error('没有取得原任务ID，请核对原教师操作。')
      if (alive.current && latest.current.account === original.account && latest.current.workbench.courseId === original.workbench.courseId) remember({ ...next, jobId: accepted.jobId })
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function adopt() {
    if (!run || !proposal || blocked || stale || active) return
    const original = latest.current
    setBusy(true); setError('')
    try {
      const next = await adoptDesignProposal(account, run, proposal, editor, draft, candidate, () =>
        alive.current && latest.current.account === account && latest.current.workbench.courseId === workbench.courseId
        && latest.current.workbench.recoveryGeneration === run.generation && JSON.stringify(latest.current.content) === editor
        && latest.current.draft?.revision === draft?.revision && !latest.current.disabled, content)
      if (alive.current && latest.current.account === original.account && latest.current.workbench.courseId === original.workbench.courseId
        && JSON.stringify(latest.current.content) === editor) {
        sessionStorage.removeItem(storageKey)
        props.onAdopt(next)
      }
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  async function cancel() {
    if (!run || !active || disabled || busy) return
    setBusy(true)
    try {
      await teacherCommand(account, 'POST', `/jobs/${encodeURIComponent(run.jobId)}/cancel`, { recoveryGeneration: run.generation })
      if (alive.current) setRun({ ...run })
    } catch (cause) { if (alive.current) setError(describe(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const canAdopt = !!proposal && proposal.body.kind !== 'rubric_trial' && !stale && !blocked && !active
    && (draft ? Object.keys(proposalPatch(proposal, run?.fields ?? [])).length > 0
      : proposal.body.kind === 'blueprint' || (proposal.body.kind === 'candidates' && candidate !== undefined))
  return <DesignAgentView hasDraft={!!draft} dirty={dirty} blocked={blocked} active={active} disabled={disabled} busy={busy}
    mode={mode} setMode={setMode} request={request} setRequest={setRequest} fields={fields} setFields={setFields} availableFields={designFields}
    selected={selected} setSelected={setSelected} samples={samples} setSamples={setSamples} paragraphs={paragraphs} error={error}
    canRecover={!!(pending && run)} run={run} job={job} restoreId={restoreId} setRestoreId={setRestoreId}
    proposal={proposal} candidate={candidate} setCandidate={setCandidate} stale={!!stale} canAdopt={canAdopt}
    onGenerate={recover => { void generate(recover) }} onCancel={() => { void cancel() }} onAdopt={() => { void adopt() }}
    onReload={() => { if (run) setRun({ ...run }) }} onRestore={() => {
      try { remember({ jobId: restoreId.trim(), courseId: workbench.courseId, blueprintId: draft?.blueprintId ?? null, baseRevision: draft?.revision ?? 0, generation: workbench.recoveryGeneration, editor, fields: [] }); setError('') } catch (cause) { setError(describe(cause)) }
    }} />
}
