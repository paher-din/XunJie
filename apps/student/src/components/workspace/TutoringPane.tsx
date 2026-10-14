import { useEffect, useRef, useState } from 'react'
import { AgentMessage } from '../chat/AgentMessage'
import { MessageRail } from '../chat/MessageRail'
import { Icon, IconText } from '../../icons'
import type { TutoringState, TutoringWorkspace } from '../../workspace/tutoringWorkspace'
import type { TutorMessage } from '../../workspace/tutoringStore'
import type { TutorObject, TutorHdlBasis, TutorHdlSelection } from '../../workspace/tutoringContracts'
import type { TutorHistoryEntry } from '../../workspace/tutoringContracts'
import { tutoringCommandFailureNotice } from '../../workspace/tutoringNotice'

/** Reuses WorkspacePage's existing ws-chatpop/ws-chatpane and AgentMessage slots. */
export function TutoringPane({ client, state, open, onClose, objectRef, objectLabel, onClearObject,
  onExample, objectCurrent, objectError, helpAllowed, assignmentActive, sourceStatus, hdlSelection }: { client: TutoringWorkspace | null; state: TutoringState; open: boolean; onClose: () => void
  helpAllowed?:boolean; assignmentActive?:boolean; sourceStatus?:(ref:TutorObject,message?:TutorMessage)=>string;hdlSelection?:TutorHdlSelection
  objectCurrent?: () => boolean; objectError?: string
  objectRef?: TutorObject; objectLabel?: string; onClearObject?: () => void; onExample?: (message: TutorMessage) => void }) {
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const ledger = state.ledger
  useEffect(()=> { setDraft('') }, [client])
  if (!open || client&&!client.confirmation.isCurrent(client.context)) return null
  const job = ledger?.job, pending = ledger?.commands.some(c=>c.state==='pending')
  const unknownHelp=ledger?.commands.some(c=>c.kind==='help'&&c.state==='pending')
  const running = !!job && !job.stopRequested && (!job.status || ['queued','running','cancelling','outcome_unknown'].includes(job.status))
  const waitExceeded=running && Number.isFinite(Date.parse(job!.deadline)) && Date.now()>=Date.parse(job!.deadline)
  const attempt=client?.confirmation.current.attempt
  const unavailable=helpAllowed!==true?'固定帮助政策未允许求助。':assignmentActive!==true?'当前分配未允许求助。'
    :!attempt||!['ready','active'].includes(attempt.status)?'当前尝试不允许新求助。'
    :state.limitedCheck===true?'限定检查进行中，当前不能发送辅导问题。'
    :state.limitedCheck!==false?'限定检查状态尚未确认，请重新读取后再求助。':null
  const canSend=!!client&&!!ledger&&!state.busy&&!pending&&!!draft.trim()&&!objectError&&!unavailable
  return <div className="ws-chatpop" data-testid="tutoring-pane">
    <div className="ws-chatpop-head"><IconText name="assistant-mark">学习助手 · 当前尝试</IconText>
      <button type="button" onClick={onClose}><IconText name="close" position="end">收起辅导</IconText></button></div>
    <div className="ws-chatpane">
      <div className="ws-chatbind">{client?.context.mode === 'preparation' ? '合成准备场景 · 不调用模型' : '获准教学内容'} · 收到、展示和回应分别记录</div>
      <div className="ws-chatbody" ref={scroller}>
        <MessageRail scrollerRef={scroller} onJump={el=>el.scrollIntoView({ block: 'center' })} />
        {!ledger?.messages.length && <p>暂无已取得的教学内容。可以直接问项目问题。</p>}
        {ledger?.commands.filter(c=>c.kind==='help').map(c=><div className="chat-message user" key={c.key}>
          <div className="bubble">{c.question}</div><small data-testid="tutor-question-status">{c.state==='confirmed' ? '已受理' : c.state==='pending'
            ? state.sendingKey===c.key ? '发送中' : c.error ? '结果未知 · 原请求待核对' : '原请求已保存，等待发送' : '服务未接纳'}</small>
          {c.error && <p role="status">{tutoringCommandFailureNotice(c)}</p>}</div>)}
        {attempt&&ledger?.messages.filter(m=>m.shown || (m.valid && state.synchronized && !ledger.blocked)).map(m=>
          <TutorMessageView key={m.payload.actionId} message={m} client={client} synchronized={state.synchronized}
            scroller={scroller.current} onExample={onExample} sourceStatus={sourceStatus} />)}
        <p className="ts-pane-lead">回答保留原问题、快照或运行来源；后续编辑不会改变该来源。下方历史保留原服务记录。</p>
        <section aria-label="已获准教学历史" data-testid="tutor-history">
          <p>已获准教学历史 · 只读原记录，不代表当前建议，也不新增收到、展示或回应回执。</p>
          <button type="button" disabled={!client||state.history?.phase==='loading'} onClick={()=>void client?.readHistory()}>刷新教学历史</button>
          {state.history?.phase==='loading'&&<p role="status">正在核对历史读取权限…</p>}
          {state.history?.notice&&<p role="status">{state.history.notice}</p>}
          {state.history?.phase==='ready'&&state.history.data.questions.filter(q=>!state.history!.data.entries.some(e=>e.question?.messageId===q.messageId)).map(q=>
            <div className="chat-message user" key={q.messageId} data-testid="tutor-history-question"><div className="bubble">{q.envelope.question}</div>
              <small>原已接纳问题 · 尚无可回取回答</small>
              {q.envelope.hdlSelection&&<p>原所选 HDL 快照：{q.envelope.hdlSelection.snapshotId} · Build：{q.envelope.hdlSelection.buildId}</p>}</div>)}
          {state.history?.phase==='ready'&&!state.history.data.entries.length&&<p>暂无可回取的已展示或已明确回应内容；缺项保持未知。</p>}
          {state.history?.phase==='ready'&&state.history.data.entries.map(entry=><TutorHistoryView key={entry.action.actionId}
            entry={entry} preparation={client?.context.mode==='preparation'}/>)}
        </section>
      </div>
      <div className="ws-chatbind" role="status">
        {job && <span data-testid="tutor-job">{job.stopRequested ? `已请求停止 · ${job.status ?? '状态待读'}` : `帮助状态 · ${job.status ?? '已受理，状态待读'}`} · {job.jobId}</span>}
        {waitExceeded && <p data-testid="tutor-wait-limit">已超过服务端给出的等待截止时间，终态尚未确认；原 Job 状态保持 {job!.status}。可以停止或主动重新读取，不会自动发起新求助。</p>}
        {state.notice && <p>{state.notice}</p>}
        {pending && <button type="button" disabled={state.busy} onClick={()=>void client?.retry()}>核对原辅导请求</button>}
        <button type="button" disabled={state.busy} onClick={()=>void client?.read(true)}>重新读取辅导</button>
        {(job&&!job.stopRequested||unknownHelp&&!ledger?.blocked) && <button type="button" onClick={()=>void client?.stop()}>停止这次帮助</button>}
      </div>
      {objectRef && <div className="ws-chatbind" data-testid="tutor-object">所指对象：{objectLabel ?? JSON.stringify(objectRef)}
        <button type="button" onClick={onClearObject}>改为项目问题</button>{objectError && <p role="status">{objectError}</p>}</div>}
      {hdlSelection&&<div className="ws-chatbind" data-testid="tutor-hdl-selection">所选 HDL：快照 {hdlSelection.snapshotId} · Build {hdlSelection.buildId}
        {hdlSelection.sessionId&&` · Session ${hdlSelection.sessionId}`}{hdlSelection.operationId&&` · Operation ${hdlSelection.operationId}`}
        {!objectRef&&onClearObject&&<button type="button" onClick={onClearObject}>改为项目问题</button>}
        {!objectRef&&objectError&&<p role="status">{objectError}</p>}</div>}
      {unavailable&&<p className="ws-chatbind" role="status" data-testid="tutor-help-limit">{unavailable}</p>}
      <form className="ws-chatinput" onSubmit={e=> { e.preventDefault(); if (!running && canSend) void client?.send(draft, objectRef, false, objectCurrent, hdlSelection) }}>
        <input aria-label="就这个任务提问" autoComplete="off" placeholder="就这个任务提问…" value={draft} onChange={e=>setDraft(e.target.value)} />
        <button type={running ? 'button' : 'submit'} className={running?'ws-action':'send'} aria-label={running ? '替换并发送' : '发送辅导问题'} title={running?'替换并发送新问题':'发送辅导问题'}
          disabled={!canSend}
          onClick={running ? ()=>{if(canSend)void client?.send(draft, objectRef, true, objectCurrent, hdlSelection)} : undefined}>{running ? '替换并发送' : <Icon name="arrow-up" size={18}/>}</button>
      </form>
    </div>
  </div>
}
function objectDescription(ref:TutorObject) {
  if(ref.kind==='code') {
    const range=ref.range as {startLine:number;startColumn:number;endLine:number;endColumn:number}|undefined
    return `${ref.path} · 文件版本 ${ref.documentVersion} · 原快照 ${ref.snapshotId}${range?` · 行列 ${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`:' · 整个文件'}`
  }
  if(ref.kind==='run')return `原运行 ${ref.runId} · 原快照 ${ref.snapshotId}`
  if(ref.kind==='project')return `原项目活动 ${ref.activityVersionId}`
  return `原资料 ${ref.resourceVersionId} · 段落 ${ref.paragraphId}`
}
function HdlSource({basis}:{basis:TutorHdlBasis}) {
  return <div data-testid="tutor-hdl-source"><p>原 HDL 快照：{basis.snapshotId} · Build：{basis.buildId}（{basis.buildStatus}）</p>
    <p>原确认作品版本：{basis.workspaceRevision??'旧记录未提供'} · 快照摘要：{basis.snapshotHash}</p>
    {basis.sessionId&&<p>原 Session：{basis.sessionId} · revision {basis.sessionRevision??'未知'} · sequence {basis.confirmedSequence??'未知'} · 模拟时间 {basis.simTimePs??'未知'} ps</p>}
    {basis.operationId&&<p>原 Operation：{basis.operationId} · 结果摘要：{basis.resultHash??'未提供'}</p>}</div>
}
function TutorHistoryView({entry,preparation}:{entry:TutorHistoryEntry;preparation:boolean}) {
  const {action,message,question}=entry,body=message.envelope.body
  return <article data-testid="tutor-history-message" data-action-id={action.actionId}>
    {question&&<div className="chat-message user"><div className="bubble">{question.envelope.question}</div><small>原已接纳问题</small></div>}
    <AgentMessage message={{role:'agent',text:body.content,phase:'settled'}} sourceLabel={preparation?'学习助手 · 合成历史记录':'学习助手 · 获准历史记录'}>
      <p>原 Job：{action.jobId} · 原 Message：{action.messageId}</p>
      {action.basis.objectRef&&<p data-testid="tutor-history-object">原对象：{JSON.stringify(action.basis.objectRef)}（仅核对来源，不定位当前作品）</p>}
      {action.basis.hdl&&<HdlSource basis={action.basis.hdl}/>}
      {question?.envelope.hdlSelection&&!action.basis.hdl&&<p>旧 HDL 记录缺少冻结来源，仅核对历史，不能视为当前板卡或代码建议。</p>}
      <p>原帮助政策：{action.targetVersions.policyVersionId} · 原 epoch：{action.basis.decisionEpoch}</p>
      <p>原状态：{action.disposition}{action.basisRevised?' · 依据后来修订':''}{action.stopReason?` · ${action.stopReason}`:''}</p>
      <p>下一步：{body.expectedStudentAction}</p><p>帮助条件：{body.assistanceContext}</p>
      <p>原回执：{action.receipts.some(r=>r.receiptKind==='displayed')?'曾报告展示':'没有展示回执'} · {action.receipts.some(r=>r.receiptKind==='acknowledged')?'曾明确回应':'没有明确回应回执'}；不证明阅读、理解或采纳。</p>
      {!!body.unresolved.length&&<p>原未解决项：{body.unresolved.join('；')}</p>}
    </AgentMessage>
  </article>
}
function TutorMessageView({ message, client, synchronized, scroller, onExample, sourceStatus }: {
  message: TutorMessage; client: TutoringWorkspace | null; synchronized: boolean; scroller: HTMLElement | null
  onExample?: (message: TutorMessage) => void; sourceStatus?:(ref:TutorObject,message?:TutorMessage)=>string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(()=> {
    const el = ref.current
    if (!el || !synchronized || !message.valid || message.facts.displayed) return
    let intersecting = false
    const report = () => {
      if (intersecting && document.visibilityState === 'visible' && el.getClientRects().length) void client?.fact(message.payload.actionId, 'displayed')
    }
    const observer = new IntersectionObserver(entries=> { intersecting = entries.some(e=>e.isIntersecting); report() }, { root: scroller, threshold: 0.05 })
    observer.observe(el); document.addEventListener('visibilitychange', report)
    return ()=> { observer.disconnect(); document.removeEventListener('visibilitychange',report) }
  }, [client, message.payload.actionId, message.valid, !!message.facts.displayed, synchronized, scroller])
  const p = message.payload
  return <div ref={ref} data-testid="tutor-message" data-action-id={p.actionId}>
    <AgentMessage message={{ role: 'agent', text: p.content!, phase: 'settled' }} sourceLabel={client?.context.mode==='preparation' ? '学习助手 · 合成准备内容' : '学习助手 · 获准完整正文'}>
      {p.jobId&&p.messageId&&p.basis&&p.targetVersions?<div data-testid="tutor-source">
        <p>原 Job：{p.jobId} · 原 Message：{p.messageId}</p>
        <p>回答来源：{p.basis.objectRef?objectDescription(p.basis.objectRef):'原尝试的项目问题'} · 原政策：{p.targetVersions.policyVersionId}</p>
        {p.basis.objectRef&&<p>{sourceStatus?.(p.basis.objectRef,message)??'只核对原对象，不定位或替换当前作品。'}</p>}
        {p.basis.hdl&&<HdlSource basis={p.basis.hdl}/>}
        {!!client?.hdlSourceStatus(message)&&<p>{client.hdlSourceStatus(message)}</p>}
      </div>:<p>当前公开结果缺少原始对象关联，不能确定对应的代码或运行。</p>}
      <p><b>下一步：</b>{p.expectedStudentAction ?? '公开结果未提供下一步。'}</p>
      {p.rationale && <p>支持目的：{p.rationale}</p>}
      {p.assistanceContext && <p>帮助条件：{p.assistanceContext}</p>}
      {!!p.unresolved?.length && <p>未解决：{p.unresolved.join('；')}</p>}
      {!!p.resourceRefs?.length && <p>公开资料引用：{p.resourceRefs.join('、')}（正文须另行获准读取）</p>}
      {!!p.evidenceIds?.length && <p>证据引用：{p.evidenceIds.join('、')}（详情未交接）</p>}
      {(!message.valid || p.basisRevised) && <p>原客户端已展示的历史；当前依据已变或尚未核验。</p>}
      <p data-testid="tutor-facts">收到：{message.facts.received?.state==='confirmed' ? '已确认' : '待确认'} · 展示：{message.facts.displayed ? '本机已发生' : '未发生'} · 回应：{message.facts.acknowledged ? '明确回应' : '未回应'}</p>
      <button type="button" disabled={!message.shown || !!message.facts.acknowledged} onClick={()=>void client?.fact(p.actionId,'acknowledged')}>我先试试</button>
      {onExample && !!p.resourceRefs?.length && <button type="button" onClick={()=>onExample(message)}>{client?.context.mode==='preparation'?'查看获准类似例子':'查看引用资料'}</button>}
    </AgentMessage>
  </div>
}
