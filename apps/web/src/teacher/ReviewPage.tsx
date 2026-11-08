import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PreviewReviewHeading, PreviewReviewSummary, PreviewReviewToolbar, PreviewLearnerTable,
  PreviewReviewSnapshot, PreviewAbilityPanel, PreviewWorkPanel, PreviewObservationPanels, PreviewUnknownPanel,
  PreviewFeedbackPanel, PreviewReviewHistory, PreviewRawEvidenceDialog, PreviewDecisionDialog,
  PreviewLearnerHeading, PreviewNextActionPanel, PreviewReviewEmpty, PreviewReviewFootnote } from '@xunjie/ui/teacher-review'
export { EvidenceButton } from '@xunjie/ui/teacher-review'
import { useTeacher } from './context'
import type { TeacherEvidence, TeacherLearner } from './types'
import './review-materials.css'

type Claim = TeacherLearner['claims'][number]
type DecisionAction = 'confirm' | 'correct' | 'defer' | 'revision'
const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const decisions = { confirm: '确认判断', correct: '纠正判断', defer: '暂缓判断', revision: '允许修订' }

export default function ReviewPage() {
  const { preview, base, data, courseId, saveReview, notify, loading } = useTeacher()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const selectedId = searchParams.get('learner')
  const [raw, setRaw] = useState<TeacherEvidence | null>(null)
  const [decision, setDecision] = useState<{ action: DecisionAction; claim?: Claim } | null>(null)
  const [reason, setReason] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [correction, setCorrection] = useState('')
  const [correctedState, setCorrectedState] = useState<Claim['state']>('insufficient')
  const [feedback, setFeedback] = useState('')
  const [formError, setFormError] = useState('')
  const rawDialog = useRef<HTMLDialogElement>(null)
  const decisionDialog = useRef<HTMLDialogElement>(null)
  const learners = data.learners.filter(l => !courseId || courseId === 'all' || l.courseId === courseId)
  const progressUnavailable = !preview && learners.length === 0
  const selected = learners.find(l => l.id === selectedId)
  const filtered = learners.filter(l => (status === 'all' || l.status === status) && `${l.name} ${l.id} ${l.activityTitle} ${l.route}`.toLowerCase().includes(query.toLowerCase()))

  function setSelectedId(id: string | null, replace = false) {
    setSearchParams(current => { const next = new URLSearchParams(current); if (id) next.set('learner', id); else next.delete('learner'); return next }, { replace })
  }
  useEffect(() => {
    if (selectedId && !loading && !learners.some(l => l.id === selectedId)) {
      setSearchParams(current => { const next = new URLSearchParams(current); next.delete('learner'); return next }, { replace: true })
    }
  }, [courseId, data.learners, selectedId, loading, setSearchParams])
  useEffect(() => { setFeedback(selected?.feedback ?? '') }, [selected?.id, selected?.feedback])
  useEffect(() => { if (raw && !rawDialog.current?.open) rawDialog.current?.showModal() }, [raw])
  useEffect(() => { if (decision && !decisionDialog.current?.open) decisionDialog.current?.showModal() }, [decision])

  function beginDecision(action: DecisionAction, claim?: Claim) {
    setDecision({ action, claim }); setReason(''); setReferences(claim?.evidenceIds.filter(id => selected?.evidence.some(e => e.id === id)) ?? [])
    setCorrection(claim?.text ?? ''); setCorrectedState(claim?.state ?? 'insufficient'); setFormError('')
  }
  function closeDecision() { decisionDialog.current?.close(); setDecision(null) }
  function commitDecision() {
    if (!preview || !selected || !decision) return
    if (!reason.trim() || !references.some(id => selected.evidence.some(e => e.id === id))) { setFormError('请填写理由，并选择至少一条原始证据。'); return }
    if (decision.action === 'correct' && !correction.trim()) { setFormError('请填写纠正后的具体判断。'); return }
    const date = new Date().toLocaleString('zh-CN', { hour12: false })
    const entry = `${date} · ${decisions[decision.action]}${decision.claim ? ` · ${decision.claim.id}` : ''}\n理由：${reason.trim()}\n引用：${references.join('、')}${decision.action === 'correct' ? `\n修正为：${correction.trim()}（${claimStates[correctedState]}）` : ''}`
    saveReview({ ...selected,
      claims: selected.claims.map(c => c.id === decision.claim?.id && decision.action === 'correct' ? { ...c, text: correction.trim(), state: correctedState, evidenceIds: references } : c),
      decision: selected.decision ? `${selected.decision}\n\n${entry}` : entry,
      revisionAllowed: decision.action === 'revision' ? true : selected.revisionAllowed,
    })
    closeDecision(); notify('已保存到本机预览；未发送至教学服务。')
  }
  function commitFeedback() {
    if (!preview || !selected || !selected.submission || !feedback.trim()) return
    saveReview({ ...selected, feedback: feedback.trim(), status: 'reviewed' })
    notify('反馈已保存到本机预览；未向学生发布。')
  }

  return <div className="t-rm-page">
    {selected ? <>
      <PreviewLearnerHeading selected={selected} onBack={() => setSelectedId(null)} />
      <PreviewReviewSnapshot selected={selected} />
      <div className="t-rm-review-grid">
        <div className="t-rm-review-main">
          <PreviewAbilityPanel selected={selected} preview={preview}
            onOpen={id => { const evidence = selected.evidence.find(item => item.id === id); if (evidence) setRaw(evidence) }}
            onDecision={(action, id) => { const claim = selected.claims.find(item => item.id === id); if (claim) beginDecision(action, claim) }} />
          <PreviewWorkPanel selected={selected} onOpen={id => { const evidence = selected.evidence.find(item => item.id === id); if (evidence) setRaw(evidence) }} />
          <PreviewObservationPanels selected={selected} onOpen={id => { const evidence = selected.evidence.find(item => item.id === id); if (evidence) setRaw(evidence) }} />
          <PreviewUnknownPanel selected={selected} />
        </div>
        <aside className="t-rm-review-side">
          <PreviewFeedbackPanel selected={selected} preview={preview} feedback={feedback} onFeedbackChange={setFeedback} onSave={commitFeedback} />
          <PreviewNextActionPanel selected={selected} preview={preview} LinkComponent={Link} onRevision={() => beginDecision('revision')}
            designPath={`${base}/design/new?course=${encodeURIComponent(selected.courseId)}&from=${encodeURIComponent(selected.id)}`} />
          <PreviewReviewHistory selected={selected} />
        </aside>
      </div>
    </> : <>
      <PreviewReviewHeading />
      <PreviewReviewSummary learners={learners} progressUnavailable={progressUnavailable} />
      <PreviewReviewToolbar query={query} status={status} progressUnavailable={progressUnavailable} count={filtered.length} onQueryChange={setQuery} onStatusChange={setStatus} />
      {filtered.length ? <PreviewLearnerTable learners={filtered} onSelect={setSelectedId} /> :
        <PreviewReviewEmpty unavailable={!preview && !learners.length} hasLearners={!!learners.length} hasFilters={!!query || status !== 'all'}
          onReset={() => { setQuery(''); setStatus('all') }} />}
      <PreviewReviewFootnote />
    </>}
    <PreviewRawEvidenceDialog raw={raw} rawDialog={rawDialog} onClosed={() => setRaw(null)} />
    <PreviewDecisionDialog decisionDialog={decisionDialog} decision={decision} selected={selected} preview={preview}
      reason={reason} references={references} correction={correction} correctedState={correctedState} formError={formError}
      setReason={setReason} setReferences={setReferences} setCorrection={setCorrection} setCorrectedState={setCorrectedState}
      closeDecision={closeDecision} onClosed={() => setDecision(null)} onSubmit={commitDecision} />
  </div>
}
