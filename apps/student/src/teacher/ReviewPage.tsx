import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { useTeacher } from './context'
import type { TeacherEvidence, TeacherLearner } from './types'
import './review-materials.css'

type Claim = TeacherLearner['claims'][number]
type DecisionAction = 'confirm' | 'correct' | 'defer' | 'revision'
const statuses = { ready: '未开始', active: '进行中', submitted: '待审阅', reviewed: '已反馈', paused: '已暂停' }
const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const domains = [
  { key: 'domain', label: '学科知识与技能', aliases: ['学科知识', '学科知识与技能'], icon: 'book-2' as const, number: '01' },
  { key: 'project', label: '项目能力', aliases: ['项目能力'], icon: 'structure' as const, number: '02' },
  { key: 'ai_collaboration', label: '人机协同与 AI 素养', aliases: ['AI 协作', 'AI 素养', '人机协同与 AI 素养'], icon: 'chat-square-line' as const, number: '03' },
]
const decisions = { confirm: '确认判断', correct: '纠正判断', defer: '暂缓判断', revision: '允许修订' }

function EvidenceButton({ evidence, onOpen }: { evidence: TeacherEvidence; onOpen: (e: TeacherEvidence) => void }) {
  return <button type="button" className="t-rm-reference" onClick={() => onOpen(evidence)}><Icon name="link" size={13} /><span>{evidence.id} · {evidence.title}</span><Icon name="alt-arrow-right" size={13} /></button>
}

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
      <button type="button" className="t-rm-back" onClick={() => setSelectedId(null)}><IconText name="alt-arrow-left">全部学生</IconText></button>
      <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>{selected.name}<span className="t-rm-title-secondary">的学习记录</span></h1><p>{selected.activityTitle} <span className="t-rm-dot">·</span> {selected.route}</p></div><span className={`t-rm-status t-rm-status-${selected.status}`}>{statuses[selected.status]}</span></div>
      <div className="t-rm-snapshot"><Icon name="lock-keyhole" size={18} /><div><strong>{selected.submission ? '本次审阅绑定固定提交' : '尚未提交 · 当前为过程记录'}</strong><span>{selected.submission || '没有可用于正式反馈的提交'} <span className="t-rm-dot">·</span> 版本 v{selected.version}</span></div><span className="t-rm-mono">更新于 {selected.updated}</span></div>
      <div className="t-rm-review-grid">
        <div className="t-rm-review-main">
          <section className="t-rm-panel t-rm-ability-panel"><div className="t-rm-section-head"><h2>三条能力线</h2><span className="t-rm-caption">具体表现与引用依据</span></div>
            {domains.map(domain => {
              const claims = selected.claims.filter(c => c.domain === domain.key || domain.aliases.includes(c.domain))
              return <div className="t-rm-domain" key={domain.key}><div className="t-rm-domain-heading"><span className="t-rm-domain-number">{domain.number}</span><Icon name={domain.icon} size={18} /><h3>{domain.label}</h3></div>
                {claims.length ? claims.map(claim => <article className="t-rm-claim" key={claim.id}>
                  <span className={`t-rm-claim-state t-rm-claim-${claim.state}`}>{claimStates[claim.state]}</span><p>{claim.text}</p>
                  <div className="t-rm-references">{claim.evidenceIds.map(id => { const evidence = selected.evidence.find(e => e.id === id); return evidence ? <EvidenceButton key={id} evidence={evidence} onOpen={setRaw} /> : <span className="t-rm-caption" key={id}>{id} · 原始引用不可用</span> })}</div>
                  <div className="t-rm-claim-actions"><button type="button" disabled={!preview} onClick={() => beginDecision('confirm', claim)}>确认</button><button type="button" disabled={!preview} onClick={() => beginDecision('correct', claim)}>纠正</button><button type="button" disabled={!preview} onClick={() => beginDecision('defer', claim)}>暂缓</button></div>
                </article>) : <p className="t-rm-unobserved">暂无这一能力线的可用表现，保持未知。</p>}
              </div>
            })}
          </section>
          <section className="t-rm-panel"><div className="t-rm-section-head"><h2>作品与原始记录</h2><span className="t-rm-caption">作品结果独立于能力判断</span></div>
            {selected.evidence.filter(e => e.type === '作品' || e.type === '运行记录').map(e => <button className="t-rm-evidence-row" type="button" key={e.id} onClick={() => setRaw(e)}><span className="t-rm-file-icon"><Icon name={e.type === '作品' ? 'file-code' : 'clipboard-check'} size={20} /></span><span><strong>{e.title}</strong><small>{e.type} · {e.source}</small></span><Icon name="alt-arrow-right" /></button>)}
            {!selected.evidence.some(e => e.type === '作品' || e.type === '运行记录') && <p className="t-rm-unobserved">暂无作品或运行记录。</p>}
          </section>
          <div className="t-rm-context-grid"><section className="t-rm-panel"><div className="t-rm-section-head"><h2>实际帮助</h2><Icon name="chat-round-dots" /></div><p className="t-rm-caption">只表达本系统可见的帮助条件。</p>{selected.evidence.filter(e => e.assistance).map(e => <div className="t-rm-observation" key={e.id}><p>{e.assistance}</p><EvidenceButton evidence={e} onOpen={setRaw} /></div>)}{!selected.evidence.some(e => e.assistance) && <p className="t-rm-unobserved">帮助情况未知，不能据此认定独立完成。</p>}</section>
            <section className="t-rm-panel"><div className="t-rm-section-head"><h2>学生自述</h2><Icon name="user-rounded" /></div><p className="t-rm-caption">自述单独呈现，不作为掌握证明。</p>{selected.evidence.filter(e => e.type === '学生自述').map(e => <div className="t-rm-observation" key={e.id}><blockquote>{e.text}</blockquote><EvidenceButton evidence={e} onOpen={setRaw} /></div>)}{!selected.evidence.some(e => e.type === '学生自述') && <p className="t-rm-unobserved">暂无学生自述。</p>}</section></div>
          <section className="t-rm-panel t-rm-unknown-panel"><div className="t-rm-section-head"><h2>反证与未知</h2><Icon name="question-circle" /></div>{selected.unknowns.length ? <ul>{selected.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p className="t-rm-unobserved">暂无已记录的未知项；不代表观察完整。</p>}</section>
        </div>
        <aside className="t-rm-review-side">
          <section className="t-rm-panel"><div className="t-rm-section-head"><h2>教师反馈</h2><Icon name="pen" /></div><p className="t-rm-caption">面向这一次固定提交，给出具体的下一步。</p><label className="t-rm-field"><span>反馈正文</span><textarea rows={8} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="哪些表现有依据？下一次可以尝试什么？" disabled={!preview || !selected.submission} /></label><button type="button" className="t-rm-button t-rm-button-primary t-rm-full" disabled={!preview || !selected.submission || !feedback.trim() || feedback.trim() === selected.feedback} onClick={commitFeedback}><IconText name="check">保存反馈到预览</IconText></button>{!selected.submission && <p className="t-rm-caption">学生提交后才能形成针对固定提交的正式反馈。</p>}<p className="t-rm-local-note"><Icon name="info-circle" size={14} />本机预览，不会向学生发布。</p></section>
          <section className="t-rm-panel"><div className="t-rm-section-head"><h2>下一步教学行动</h2></div><p>{selected.revisionAllowed ? '本机预览中已允许学生主动重开修订。' : '反馈之后，可允许学生在保留旧提交的基础上继续修订。'}</p><button type="button" className="t-rm-button t-rm-full" disabled={!preview || selected.status !== 'reviewed' || !selected.submission || selected.revisionAllowed} onClick={() => beginDecision('revision')}><IconText name="undo-left-round">{selected.revisionAllowed ? '已允许修订' : '允许修订'}</IconText></button>{selected.status !== 'reviewed' && <p className="t-rm-caption">先保存本次提交的反馈，再明确发放修订许可。</p>}<p>也可以据此设计后续活动。新活动固定新版本，学生开始新尝试，旧提交与判断继续保留。</p>{preview ? <Link className="t-rm-button t-rm-full" to={`${base}/design/new?course=${encodeURIComponent(selected.courseId)}&from=${encodeURIComponent(selected.id)}`}><IconText name="pen-new-square">设计后续活动</IconText></Link> : <button type="button" className="t-rm-button t-rm-full" disabled><IconText name="pen-new-square">设计后续活动</IconText></button>}</section>
          <section className="t-rm-panel"><div className="t-rm-section-head"><h2>复核记录</h2><Icon name="clock-circle" /></div>{selected.decision ? <pre className="t-rm-decision-history">{selected.decision}</pre> : <p className="t-rm-caption">尚未形成教师决定。确认、纠正与暂缓都会保留理由及引用。</p>}</section>
        </aside>
      </div>
    </> : <>
      <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">UNDERSTAND THE LEARNING</div><h1>学生进展与审阅</h1><p>从具体表现出发，理解过程，回应下一步。</p></div><span className="t-rm-heading-icon"><Icon name="clipboard-check" size={28} /></span></div>
      <div className="t-rm-summary-strip"><div><span>当前课程学生</span><strong>{progressUnavailable ? '—' : learners.length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><div><span>等待审阅</span><strong>{progressUnavailable ? '—' : learners.filter(l => l.status === 'submitted').length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><div><span>已给出反馈</span><strong>{progressUnavailable ? '—' : learners.filter(l => l.status === 'reviewed').length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><p>{progressUnavailable ? <>学生进展尚未接入，<br />当前数量未知。</> : <>作品结果、实际帮助与能力判断<br />各自保留依据。</>}</p></div>
      <div className="t-rm-toolbar"><label className="t-rm-search"><Icon name="minimalistic-magnifier" /><input aria-label="搜索学生或项目" placeholder="搜索学生、项目或路线" value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="close" size={14} /></button>}</label><label className="t-rm-filter-label">状态<select aria-label="筛选学生状态" value={status} onChange={e => setStatus(e.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="t-rm-caption">{progressUnavailable ? '列表未接入' : `${filtered.length} 条记录`}</span></div>
      {!preview && !learners.length ? <div className="t-rm-empty"><Icon name="shield-check" size={36} /><h2>学生进展等待真实接线</h2><p>当前宿主尚未提供教师学生列表、证据复核与正式反馈入口。接通后，将在这里显示负责课程的真实记录。</p></div> : filtered.length ? <div className="t-rm-learner-table"><div className="t-rm-learner-table-head"><span>学生</span><span>项目与路线</span><span>证据</span><span>状态 / 最近更新</span><span /></div>{filtered.map(learner => <button type="button" className="t-rm-learner-row" key={learner.id} onClick={() => setSelectedId(learner.id)}><span className="t-rm-learner-identity"><span className="t-rm-avatar">{learner.name.slice(0, 1)}</span><span><strong>{learner.name}</strong><small>{learner.id}</small></span></span><span className="t-rm-learner-project"><strong>{learner.activityTitle}</strong><small>{learner.route}</small></span><span className="t-rm-evidence-count"><Icon name="link" size={14} />{learner.evidence.length}<small>条引用</small></span><span className="t-rm-learner-meta"><span className={`t-rm-status t-rm-status-${learner.status}`}>{statuses[learner.status]}</span><small>{learner.updated}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}</div> : <div className="t-rm-empty"><Icon name="folder-search" size={36} /><h2>{learners.length ? '没有符合条件的学生' : '还没有学生记录'}</h2><p>{learners.length ? '试试调整搜索词或状态筛选。' : '学生开始活动后，可以在这里查看可用的过程与提交。'}</p>{(query || status !== 'all') && <button type="button" className="t-rm-button" onClick={() => { setQuery(''); setStatus('all') }}>重置筛选</button>}</div>}
      <p className="t-rm-page-footnote"><Icon name="info-circle" size={14} />不计算综合掌握率。一次尝试中的相关观察不会被当作多份独立能力证据。</p>
    </>}
    <dialog ref={rawDialog} className="t-rm-dialog" onClose={() => setRaw(null)} aria-labelledby="t-rm-evidence-title">{raw && <><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">原始引用 · {raw.id}</span><h2 id="t-rm-evidence-title">{raw.title}</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭原始引用" onClick={() => rawDialog.current?.close()}><Icon name="close" /></button></div><div className="t-rm-dialog-body"><div className="t-rm-meta-pairs"><span>类型<strong>{raw.type}</strong></span><span>来源<strong>{raw.source}</strong></span></div><pre className="t-rm-raw-content">{raw.text}</pre><div className="t-rm-note"><strong>当时的帮助条件</strong><p>{raw.assistance || '未记录，保持未知。'}</p></div></div><div className="t-rm-dialog-footer"><button type="button" className="t-rm-button" onClick={() => rawDialog.current?.close()}>关闭</button></div></>}</dialog>
    <dialog ref={decisionDialog} className="t-rm-dialog" onClose={() => setDecision(null)} aria-labelledby="t-rm-decision-title">{decision && selected && <form onSubmit={e => { e.preventDefault(); commitDecision() }}><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">教师决定 · 仅本机预览</span><h2 id="t-rm-decision-title">{decisions[decision.action]}</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭教师决定" onClick={closeDecision}><Icon name="close" /></button></div><div className="t-rm-dialog-body">{decision.claim && <div className="t-rm-note"><strong>原判断 · {decision.claim.id}</strong><p>{decision.claim.text}</p></div>}{decision.action === 'revision' && <div className="t-rm-note"><p>许可绑定 {selected.submission}。学生仍需主动重开；旧提交保留。</p></div>}{decision.action === 'correct' && <><label className="t-rm-field"><span>纠正后的具体判断</span><textarea rows={3} value={correction} onChange={e => setCorrection(e.target.value)} required /></label><label className="t-rm-field"><span>证据状态</span><select value={correctedState} onChange={e => setCorrectedState(e.target.value as Claim['state'])}>{Object.entries(claimStates).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></>}<label className="t-rm-field"><span>{decision.action === 'revision' ? '允许修订的理由与建议' : '判断理由'} <em>必填</em></span><textarea autoFocus rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="说明原始依据，以及仍需保留的限制。" required /></label><fieldset className="t-rm-evidence-checks"><legend>引用依据 <em>至少一条</em></legend>{selected.evidence.map(e => <label key={e.id}><input type="checkbox" checked={references.includes(e.id)} onChange={event => setReferences(ids => event.target.checked ? [...ids, e.id] : ids.filter(id => id !== e.id))} /><span>{e.id} · {e.title}<small>{e.type} · {e.source}</small></span></label>)}{!selected.evidence.length && <p className="t-rm-caption">没有可用原始引用，暂不能保存带依据的决定。</p>}</fieldset>{formError && <p className="t-rm-error" role="alert">{formError}</p>}</div><div className="t-rm-dialog-footer"><button type="button" className="t-rm-button" onClick={closeDecision}>取消</button><button type="submit" className="t-rm-button t-rm-button-primary" disabled={!preview}>保存到本机预览</button></div></form>}</dialog>
  </div>
}
