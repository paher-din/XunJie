import type { ReactNode, RefObject } from 'react'
import { MessageRail } from '../chat/MessageRail'
import { Icon, IconText } from '../icons'
import { TutorHistoryView } from './TutorMessageView'
import type { TutorExchangeDisplay, TutorHistoryDisplay, TutorObjectDisplay, TutorHdlSelectionDisplay } from './tutoringPresentation'
export interface TutoringPaneViewProps {
  preparation: boolean; expanded: boolean; atBottom: boolean; hasMessages: boolean
  scrollerRef: RefObject<HTMLDivElement | null>; onScroll: () => void
  exchanges: TutorExchangeDisplay[]
  /** Observation adapter returns the formal message view; not an entire conversation slot. */
  renderMessage: (actionId: string) => ReactNode
  running: boolean; waitExceeded: boolean; pending: boolean; busy: boolean; canStop: boolean
  job?: { jobId: string; status?: string; stopRequested: boolean } | null
  history?: TutorHistoryDisplay
  canReadHistory: boolean; notice: string | null
  objectRef?: TutorObjectDisplay; objectLabel?: string; objectError?: string
  hdlSelection?: TutorHdlSelectionDisplay
  unavailable: string | null; draft: string; canSend: boolean
  onToggleExpanded: () => void; onClose: () => void; onJumpLatest: () => void
  onReadHistory: () => void; onRetry: () => void; onRead: () => void; onStop: () => void
  onClearObject?: () => void; onDraft: (text: string) => void; onSend: (replace: boolean) => void
}
/** Complete legacy conversation visuals; request ownership and receipt observation stay with the host. */
export function TutoringPaneView({ preparation, expanded, atBottom, hasMessages, scrollerRef, onScroll, exchanges, renderMessage,
  running, waitExceeded, pending, busy, canStop, job, history, canReadHistory, notice,
  objectRef, objectLabel, objectError, hdlSelection, unavailable, draft, canSend,
  onToggleExpanded, onClose, onJumpLatest, onReadHistory, onRetry, onRead, onStop, onClearObject, onDraft, onSend }: TutoringPaneViewProps) {
  return <div className={`ws-chatpop tutor-chatpop${expanded?' expanded':''}`} data-testid="tutoring-pane" role="region" aria-label="工作区对话">
    <div className="ws-chatpop-head"><IconText name="assistant-mark">学习助手 · 当前尝试</IconText>
      <div className="tutor-window-actions"><button type="button" aria-pressed={expanded} onClick={onToggleExpanded}>{expanded?'还原窗口':'展开阅读'}</button>
      <button type="button" onClick={onClose}><IconText name="close" position="end">收起辅导</IconText></button></div></div>
    <div className="ws-chatpane">
      <div className="ws-chatbind tutor-caption">{preparation ? '合成准备场景 · 不调用模型' : '围绕当前项目提问'}</div>
      <div className="ws-chatbody" ref={scrollerRef} onScroll={onScroll}>
        <MessageRail scrollerRef={scrollerRef} onJump={el=>el.scrollIntoView({ block: 'center' })} />
        {!hasMessages && <p>暂无已取得的教学内容。可以直接问项目问题。</p>}
        {exchanges.map(row=><div className="tutor-exchange" key={row.key}>
          {row.command&&((c)=><div className="chat-message user">
          <div className="bubble">{c.question}</div><small data-testid="tutor-question-status">{c.statusLabel}</small>
          {c.error && <p role="status">{c.failureNotice}</p>}</div>)(row.command)}
          {row.messageIds.map(actionId => renderMessage(actionId))}
        </div>)}
        {running&&<div className="tutor-progress" role="status"><span className="turn-dots"><i/><i/><i/></span>
          <span>{job?.status==='queued'?'问题已接收，正在排队':job?.status==='outcome_unknown'?'正在核对原请求状态':'正在生成并核对回答…'}</span></div>}
        <details className="tutor-details tutor-history-details">
        <summary>查看教学历史与原始记录</summary>
        <section aria-label="已获准教学历史" data-testid="tutor-history">
          <p>已获准教学历史 · 只读原记录，不代表当前建议，也不新增收到、展示或回应回执。</p>
          <button type="button" disabled={!canReadHistory||history?.phase==='loading'} onClick={onReadHistory}>刷新教学历史</button>
          {history?.phase==='loading'&&<p role="status">正在核对历史读取权限…</p>}
          {history?.notice&&<p role="status">{history.notice}</p>}
          {history?.phase==='ready'&&history.data.questions.filter(q=>!history!.data.entries.some(e=>e.question?.messageId===q.messageId)).map(q=>
            <div className="chat-message user" key={q.messageId} data-testid="tutor-history-question"><div className="bubble">{q.envelope.question}</div>
              <small>原已接纳问题 · 尚无可回取回答</small>
              {q.envelope.hdlSelection&&<p>原所选 HDL 快照：{q.envelope.hdlSelection.snapshotId} · Build：{q.envelope.hdlSelection.buildId}</p>}</div>)}
          {history?.phase==='ready'&&!history.data.entries.length&&<p>暂无可回取的已展示或已明确回应内容；缺项保持未知。</p>}
          {history?.phase==='ready'&&history.data.entries.map(entry=><TutorHistoryView key={entry.action.actionId}
            entry={entry} preparation={preparation}/>)}
        </section>
        </details>
      </div>
      {!atBottom&&<button type="button" className="tutor-jump" onClick={onJumpLatest}>回到最新消息 ↓</button>}
      <div className="ws-chatbind" role="status">
        {job && <span data-testid="tutor-job" title={job.jobId}>{job.stopRequested ? `已请求停止 · ${job.status ?? '状态待读'}` : `帮助状态 · ${job.status ?? '已受理，状态待读'}`}</span>}
        {waitExceeded && <p data-testid="tutor-wait-limit">已超过服务端给出的等待截止时间，终态尚未确认；原 Job 状态保持 {job!.status}。可以停止或主动重新读取，不会自动发起新求助。</p>}
        {notice && <p>{notice}</p>}
        {pending && <button type="button" disabled={busy} onClick={onRetry}>核对原辅导请求</button>}
        <button type="button" disabled={busy} onClick={onRead}>重新读取辅导</button>
        {canStop && <button type="button" onClick={onStop}>停止这次帮助</button>}
      </div>
      {objectRef && <div className="ws-chatbind" data-testid="tutor-object">所指对象：{objectLabel ?? JSON.stringify(objectRef)}
        <button type="button" onClick={onClearObject}>改为项目问题</button>{objectError && <p role="status">{objectError}</p>}</div>}
      {hdlSelection&&<div className="ws-chatbind" data-testid="tutor-hdl-selection">所选 HDL：快照 {hdlSelection.snapshotId} · Build {hdlSelection.buildId}
        {hdlSelection.sessionId&&` · Session ${hdlSelection.sessionId}`}{hdlSelection.operationId&&` · Operation ${hdlSelection.operationId}`}
        {!objectRef&&onClearObject&&<button type="button" onClick={onClearObject}>改为项目问题</button>}
        {!objectRef&&objectError&&<p role="status">{objectError}</p>}</div>}
      {unavailable&&<p className="ws-chatbind" role="status" data-testid="tutor-help-limit">{unavailable}</p>}
      <form className="ws-chatinput" onSubmit={e=> { e.preventDefault(); if (!running) onSend(false) }}>
        <textarea aria-label="就这个任务提问" rows={2} autoComplete="off" placeholder="就这个任务提问…" value={draft} onChange={e=>onDraft(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();if(!running)onSend(false)}}}/>
        <button type={running ? 'button' : 'submit'} className={running?'ws-action':'send'} aria-label={running ? '替换并发送' : '发送辅导问题'} title={running?'替换并发送新问题':'发送辅导问题'}
          disabled={!canSend}
          onClick={running ? ()=>onSend(true) : undefined}>{running ? '替换并发送' : <Icon name="arrow-up" size={18}/>}</button>
      </form>
      <div className="tutor-input-hint">Enter 发送 · Shift + Enter 换行</div>
    </div>
  </div>
}
