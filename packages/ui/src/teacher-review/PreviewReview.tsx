import { useId, type ComponentType, type RefObject } from 'react'
import { Icon, IconText } from '../icons'
import type { TeacherRouteLinkProps } from './Settings'

export type PreviewLearnerStatus = 'ready' | 'active' | 'submitted' | 'reviewed' | 'paused'
export type PreviewClaimState = 'insufficient' | 'supported_with_assistance' | 'supported_in_check' | 'conflicting'
export type PreviewDecisionAction = 'confirm' | 'correct' | 'defer' | 'revision'
export interface ReviewEvidenceView {
  id: string; type: '作品' | '运行记录' | '学生自述' | '辅导消息'
  title: string; text: string; source: string; assistance: string
}
export interface PreviewClaimView {
  id: string; domain: string; text: string; state: PreviewClaimState; evidenceIds: string[]
}
export interface PreviewLearnerView {
  id: string; name: string; courseId: string; activityTitle: string; status: PreviewLearnerStatus
  route: string; updated: string; submission: string; version: number; evidence: ReviewEvidenceView[]
  claims: PreviewClaimView[]; unknowns: string[]; feedback: string; decision: string; revisionAllowed: boolean
}
const statuses = { ready: '未开始', active: '进行中', submitted: '待审阅', reviewed: '已反馈', paused: '已暂停' }
const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const domains = [
  { key: 'domain', label: '学科知识与技能', aliases: ['学科知识', '学科知识与技能'], icon: 'book-2' as const, number: '01' },
  { key: 'project', label: '项目能力', aliases: ['项目能力'], icon: 'structure' as const, number: '02' },
  { key: 'ai_collaboration', label: '人机协同与 AI 素养', aliases: ['AI 协作', 'AI 素养', '人机协同与 AI 素养'], icon: 'chat-square-line' as const, number: '03' },
]
const decisions = { confirm: '确认判断', correct: '纠正判断', defer: '暂缓判断', revision: '允许修订' }

/** 纯展示引用，不读取证据；保留调用方数据类型。 */
export function EvidenceButton<T extends ReviewEvidenceView>({ evidence, onOpen }: { evidence: T; onOpen: (evidence: T) => void }) {
  return <button type="button" className="t-rm-reference" onClick={() => onOpen(evidence)}><Icon name="link" size={13} /><span>{evidence.id} · {evidence.title}</span><Icon name="alt-arrow-right" size={13} /></button>
}
export function PreviewReviewHeading() { return <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">UNDERSTAND THE LEARNING</div><h1>学生进展与审阅</h1><p>从具体表现出发，理解过程，回应下一步。</p></div><span className="t-rm-heading-icon"><Icon name="clipboard-check" size={28} /></span></div> }
export function PreviewLearnerHeading({ selected, onBack }: { selected: PreviewLearnerView; onBack: () => void }) {
  return <><button type="button" className="t-rm-back" onClick={onBack}><IconText name="alt-arrow-left">全部学生</IconText></button>
    <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>{selected.name}<span className="t-rm-title-secondary">的学习记录</span></h1><p>{selected.activityTitle} <span className="t-rm-dot">·</span> {selected.route}</p></div><span className={`t-rm-status t-rm-status-${selected.status}`}>{statuses[selected.status]}</span></div></>
}
export function PreviewReviewSummary({ learners, progressUnavailable }: { learners: PreviewLearnerView[]; progressUnavailable: boolean }) {
  return <div className="t-rm-summary-strip"><div><span>当前课程学生</span><strong>{progressUnavailable ? '—' : learners.length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><div><span>等待审阅</span><strong>{progressUnavailable ? '—' : learners.filter(l => l.status === 'submitted').length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><div><span>已给出反馈</span><strong>{progressUnavailable ? '—' : learners.filter(l => l.status === 'reviewed').length}<small>{progressUnavailable ? '未接入' : '位'}</small></strong></div><p>{progressUnavailable ? <>学生进展尚未接入，<br />当前数量未知。</> : <>作品结果、实际帮助与能力判断<br />各自保留依据。</>}</p></div>
}
export function PreviewReviewToolbar({ query, status, progressUnavailable, count, onQueryChange, onStatusChange }: {
  query: string; status: string; progressUnavailable: boolean; count: number
  onQueryChange: (value: string) => void; onStatusChange: (value: string) => void
}) { return <div className="t-rm-toolbar"><label className="t-rm-search"><Icon name="minimalistic-magnifier" /><input aria-label="搜索学生或项目" placeholder="搜索学生、项目或路线" value={query} onChange={e => onQueryChange(e.target.value)} />{query && <button type="button" aria-label="清空搜索" onClick={() => onQueryChange('')}><Icon name="close" size={14} /></button>}</label><label className="t-rm-filter-label">状态<select aria-label="筛选学生状态" value={status} onChange={e => onStatusChange(e.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="t-rm-caption">{progressUnavailable ? '列表未接入' : `${count} 条记录`}</span></div> }
export function PreviewLearnerTable({ learners, onSelect }: { learners: PreviewLearnerView[]; onSelect: (id: string) => void }) {
  return <div className="t-rm-learner-table"><div className="t-rm-learner-table-head"><span>学生</span><span>项目与路线</span><span>证据</span><span>状态 / 最近更新</span><span /></div>{learners.map(learner => <button type="button" className="t-rm-learner-row" key={learner.id} onClick={() => onSelect(learner.id)}><span className="t-rm-learner-identity"><span className="t-rm-avatar">{learner.name.slice(0, 1)}</span><span><strong>{learner.name}</strong><small>{learner.id}</small></span></span><span className="t-rm-learner-project"><strong>{learner.activityTitle}</strong><small>{learner.route}</small></span><span className="t-rm-evidence-count"><Icon name="link" size={14} />{learner.evidence.length}<small>条引用</small></span><span className="t-rm-learner-meta"><span className={`t-rm-status t-rm-status-${learner.status}`}>{statuses[learner.status]}</span><small>{learner.updated}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}</div>
}
export function PreviewReviewEmpty({ unavailable, hasLearners, hasFilters, onReset }: {
  unavailable: boolean; hasLearners: boolean; hasFilters: boolean; onReset: () => void
}) {
  return unavailable ? <div className="t-rm-empty"><Icon name="shield-check" size={36} /><h2>学生进展等待真实接线</h2><p>当前宿主尚未提供教师学生列表、证据复核与正式反馈入口。接通后，将在这里显示负责课程的真实记录。</p></div>
    : <div className="t-rm-empty"><Icon name="folder-search" size={36} /><h2>{hasLearners ? '没有符合条件的学生' : '还没有学生记录'}</h2><p>{hasLearners ? '试试调整搜索词或状态筛选。' : '学生开始活动后，可以在这里查看可用的过程与提交。'}</p>{hasFilters && <button type="button" className="t-rm-button" onClick={onReset}>重置筛选</button>}</div>
}
export function PreviewReviewFootnote() {
  return <p className="t-rm-page-footnote"><Icon name="info-circle" size={14} />不计算综合掌握率。一次尝试中的相关观察不会被当作多份独立能力证据。</p>
}
export function PreviewReviewSnapshot({ selected }: { selected: PreviewLearnerView }) { return <div className="t-rm-snapshot"><Icon name="lock-keyhole" size={18} /><div><strong>{selected.submission ? '本次审阅绑定固定提交' : '尚未提交 · 当前为过程记录'}</strong><span>{selected.submission || '没有可用于正式反馈的提交'} <span className="t-rm-dot">·</span> 版本 v{selected.version}</span></div><span className="t-rm-mono">更新于 {selected.updated}</span></div> }
export function PreviewAbilityPanel({ selected, preview, onOpen, onDecision }: {
  selected: PreviewLearnerView; preview: boolean; onOpen: (evidenceId: string) => void
  onDecision: (action: Exclude<PreviewDecisionAction, 'revision'>, claimId: string) => void
}) { return <section className="t-rm-panel t-rm-ability-panel"><div className="t-rm-section-head"><h2>三条能力线</h2><span className="t-rm-caption">具体表现与引用依据</span></div>
            {domains.map(domain => {
              const claims = selected.claims.filter(c => c.domain === domain.key || domain.aliases.includes(c.domain))
              return <div className="t-rm-domain" key={domain.key}><div className="t-rm-domain-heading"><span className="t-rm-domain-number">{domain.number}</span><Icon name={domain.icon} size={18} /><h3>{domain.label}</h3></div>
                {claims.length ? claims.map(claim => <article className="t-rm-claim" key={claim.id}>
                  <span className={`t-rm-claim-state t-rm-claim-${claim.state}`}>{claimStates[claim.state]}</span><p>{claim.text}</p>
                  <div className="t-rm-references">{claim.evidenceIds.map(id => { const evidence = selected.evidence.find(e => e.id === id); return evidence ? <EvidenceButton key={id} evidence={evidence} onOpen={e => onOpen(e.id)} /> : <span className="t-rm-caption" key={id}>{id} · 原始引用不可用</span> })}</div>
                  <div className="t-rm-claim-actions"><button type="button" disabled={!preview} onClick={() => onDecision('confirm', claim.id)}>确认</button><button type="button" disabled={!preview} onClick={() => onDecision('correct', claim.id)}>纠正</button><button type="button" disabled={!preview} onClick={() => onDecision('defer', claim.id)}>暂缓</button></div>
                </article>) : <p className="t-rm-unobserved">暂无这一能力线的可用表现，保持未知。</p>}
              </div>
            })}
          </section> }
export function PreviewWorkPanel({ selected, onOpen }: { selected: PreviewLearnerView; onOpen: (evidenceId: string) => void }) { return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>作品与原始记录</h2><span className="t-rm-caption">作品结果独立于能力判断</span></div>
            {selected.evidence.filter(e => e.type === '作品' || e.type === '运行记录').map(e => <button className="t-rm-evidence-row" type="button" key={e.id} onClick={() => onOpen(e.id)}><span className="t-rm-file-icon"><Icon name={e.type === '作品' ? 'file-code' : 'clipboard-check'} size={20} /></span><span><strong>{e.title}</strong><small>{e.type} · {e.source}</small></span><Icon name="alt-arrow-right" /></button>)}
            {!selected.evidence.some(e => e.type === '作品' || e.type === '运行记录') && <p className="t-rm-unobserved">暂无作品或运行记录。</p>}
          </section> }
export function PreviewObservationPanels({ selected, onOpen }: { selected: PreviewLearnerView; onOpen: (evidenceId: string) => void }) { return <div className="t-rm-context-grid"><section className="t-rm-panel"><div className="t-rm-section-head"><h2>实际帮助</h2><Icon name="chat-round-dots" /></div><p className="t-rm-caption">只表达本系统可见的帮助条件。</p>{selected.evidence.filter(e => e.assistance).map(e => <div className="t-rm-observation" key={e.id}><p>{e.assistance}</p><EvidenceButton evidence={e} onOpen={e => onOpen(e.id)} /></div>)}{!selected.evidence.some(e => e.assistance) && <p className="t-rm-unobserved">帮助情况未知，不能据此认定独立完成。</p>}</section>
            <section className="t-rm-panel"><div className="t-rm-section-head"><h2>学生自述</h2><Icon name="user-rounded" /></div><p className="t-rm-caption">自述单独呈现，不作为掌握证明。</p>{selected.evidence.filter(e => e.type === '学生自述').map(e => <div className="t-rm-observation" key={e.id}><blockquote>{e.text}</blockquote><EvidenceButton evidence={e} onOpen={e => onOpen(e.id)} /></div>)}{!selected.evidence.some(e => e.type === '学生自述') && <p className="t-rm-unobserved">暂无学生自述。</p>}</section></div> }
export function PreviewUnknownPanel({ selected }: { selected: PreviewLearnerView }) { return <section className="t-rm-panel t-rm-unknown-panel"><div className="t-rm-section-head"><h2>反证与未知</h2><Icon name="question-circle" /></div>{selected.unknowns.length ? <ul>{selected.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul> : <p className="t-rm-unobserved">暂无已记录的未知项；不代表观察完整。</p>}</section> }
export function PreviewFeedbackPanel({ selected, preview, feedback, onFeedbackChange, onSave }: {
  selected: PreviewLearnerView; preview: boolean; feedback: string; onFeedbackChange: (value: string) => void; onSave: () => void
}) { return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>教师反馈</h2><Icon name="pen" /></div><p className="t-rm-caption">面向这一次固定提交，给出具体的下一步。</p><label className="t-rm-field"><span>反馈正文</span><textarea rows={8} value={feedback} onChange={e => onFeedbackChange(e.target.value)} placeholder="哪些表现有依据？下一次可以尝试什么？" disabled={!preview || !selected.submission} /></label><button type="button" className="t-rm-button t-rm-button-primary t-rm-full" disabled={!preview || !selected.submission || !feedback.trim() || feedback.trim() === selected.feedback} onClick={onSave}><IconText name="check">保存反馈到预览</IconText></button>{!selected.submission && <p className="t-rm-caption">学生提交后才能形成针对固定提交的正式反馈。</p>}<p className="t-rm-local-note"><Icon name="info-circle" size={14} />本机预览，不会向学生发布。</p></section> }
export function PreviewNextActionPanel({ selected, preview, designPath, LinkComponent, onRevision }: {
  selected: PreviewLearnerView; preview: boolean; designPath: string
  LinkComponent: ComponentType<TeacherRouteLinkProps>; onRevision: () => void
}) {
  return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>下一步教学行动</h2></div><p>{selected.revisionAllowed ? '本机预览中已允许学生主动重开修订。' : '反馈之后，可允许学生在保留旧提交的基础上继续修订。'}</p><button type="button" className="t-rm-button t-rm-full" disabled={!preview || selected.status !== 'reviewed' || !selected.submission || selected.revisionAllowed} onClick={onRevision}><IconText name="undo-left-round">{selected.revisionAllowed ? '已允许修订' : '允许修订'}</IconText></button>{selected.status !== 'reviewed' && <p className="t-rm-caption">先保存本次提交的反馈，再明确发放修订许可。</p>}<p>也可以据此设计后续活动。新活动固定新版本，学生开始新尝试，旧提交与判断继续保留。</p>{preview ? <LinkComponent className="t-rm-button t-rm-full" to={designPath}><IconText name="pen-new-square">设计后续活动</IconText></LinkComponent> : <button type="button" className="t-rm-button t-rm-full" disabled><IconText name="pen-new-square">设计后续活动</IconText></button>}</section>
}
export function PreviewReviewHistory({ selected }: { selected: PreviewLearnerView }) { return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>复核记录</h2><Icon name="clock-circle" /></div>{selected.decision ? <pre className="t-rm-decision-history">{selected.decision}</pre> : <p className="t-rm-caption">尚未形成教师决定。确认、纠正与暂缓都会保留理由及引用。</p>}</section> }
export function PreviewRawEvidenceDialog({ raw, rawDialog, onClosed }: {
  raw: ReviewEvidenceView | null; rawDialog: RefObject<HTMLDialogElement | null>; onClosed: () => void
}) { const titleId = useId(); return <dialog ref={rawDialog} className="t-rm-dialog" onClose={onClosed} aria-labelledby={titleId}>{raw && <><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">原始引用 · {raw.id}</span><h2 id={titleId}>{raw.title}</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭原始引用" onClick={() => rawDialog.current?.close()}><Icon name="close" /></button></div><div className="t-rm-dialog-body"><div className="t-rm-meta-pairs"><span>类型<strong>{raw.type}</strong></span><span>来源<strong>{raw.source}</strong></span></div><pre className="t-rm-raw-content">{raw.text}</pre><div className="t-rm-note"><strong>当时的帮助条件</strong><p>{raw.assistance || '未记录，保持未知。'}</p></div></div><div className="t-rm-dialog-footer"><button type="button" className="t-rm-button" onClick={() => rawDialog.current?.close()}>关闭</button></div></>}</dialog> }
export interface PreviewDecisionDialogProps {
  decisionDialog: RefObject<HTMLDialogElement | null>
  decision: { action: PreviewDecisionAction; claim?: PreviewClaimView } | null
  selected: PreviewLearnerView | undefined
  preview: boolean; reason: string; references: string[]; correction: string
  correctedState: PreviewClaimState; formError: string
  setReason: (value: string) => void; setReferences: (value: string[]) => void
  setCorrection: (value: string) => void; setCorrectedState: (value: PreviewClaimState) => void
  closeDecision: () => void; onClosed: () => void; onSubmit: () => void
}
export function PreviewDecisionDialog({ decisionDialog, decision, selected, preview, reason, references, correction,
  correctedState, formError, setReason, setReferences, setCorrection, setCorrectedState,
  closeDecision, onClosed, onSubmit }: PreviewDecisionDialogProps) {
  const titleId = useId()
  return <dialog ref={decisionDialog} className="t-rm-dialog" onClose={onClosed} aria-labelledby={titleId}>{decision && selected && <form onSubmit={e => { e.preventDefault(); onSubmit() }}><div className="t-rm-dialog-head"><div><span className="t-rm-eyebrow">教师决定 · 仅本机预览</span><h2 id={titleId}>{decisions[decision.action]}</h2></div><button type="button" className="t-rm-icon-button" aria-label="关闭教师决定" onClick={closeDecision}><Icon name="close" /></button></div><div className="t-rm-dialog-body">{decision.claim && <div className="t-rm-note"><strong>原判断 · {decision.claim.id}</strong><p>{decision.claim.text}</p></div>}{decision.action === 'revision' && <div className="t-rm-note"><p>许可绑定 {selected.submission}。学生仍需主动重开；旧提交保留。</p></div>}{decision.action === 'correct' && <><label className="t-rm-field"><span>纠正后的具体判断</span><textarea rows={3} value={correction} onChange={e => setCorrection(e.target.value)} required /></label><label className="t-rm-field"><span>证据状态</span><select value={correctedState} onChange={e => setCorrectedState(e.target.value as PreviewClaimState)}>{Object.entries(claimStates).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></>}<label className="t-rm-field"><span>{decision.action === 'revision' ? '允许修订的理由与建议' : '判断理由'} <em>必填</em></span><textarea autoFocus rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="说明原始依据，以及仍需保留的限制。" required /></label><fieldset className="t-rm-evidence-checks"><legend>引用依据 <em>至少一条</em></legend>{selected.evidence.map(e => <label key={e.id}><input type="checkbox" checked={references.includes(e.id)} onChange={event => setReferences(event.target.checked ? [...references, e.id] : references.filter(id => id !== e.id))} /><span>{e.id} · {e.title}<small>{e.type} · {e.source}</small></span></label>)}{!selected.evidence.length && <p className="t-rm-caption">没有可用原始引用，暂不能保存带依据的决定。</p>}</fieldset>{formError && <p className="t-rm-error" role="alert">{formError}</p>}</div><div className="t-rm-dialog-footer"><button type="button" className="t-rm-button" onClick={closeDecision}>取消</button><button type="submit" className="t-rm-button t-rm-button-primary" disabled={!preview}>保存到本机预览</button></div></form>}</dialog>
}
