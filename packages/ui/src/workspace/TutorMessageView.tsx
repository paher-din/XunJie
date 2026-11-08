import type { Ref } from 'react'
import { AgentMessage } from '../chat/AgentMessage'
import type { TutorObjectDisplay, TutorHdlBasisDisplay, TutorHistoryEntryDisplay, TutorMessageDisplay } from './tutoringPresentation'
export interface TutorMessageViewProps {
  message: TutorMessageDisplay; preparation: boolean; elementRef?: Ref<HTMLDivElement>
  sourceNotice?: string; hdlSourceNotice?: string | null
  onAcknowledge: () => void; onExample?: () => void
}
function objectDescription(ref:TutorObjectDisplay) {
  if(ref.kind==='code') {
    const range=ref.range as {startLine:number;startColumn:number;endLine:number;endColumn:number}|undefined
    return `${ref.path} · 文件版本 ${ref.documentVersion} · 原快照 ${ref.snapshotId}${range?` · 行列 ${range.startLine}:${range.startColumn}–${range.endLine}:${range.endColumn}`:' · 整个文件'}`
  }
  if(ref.kind==='run')return `原运行 ${ref.runId} · 原快照 ${ref.snapshotId}`
  if(ref.kind==='project')return `原项目活动 ${ref.activityVersionId}`
  return `原资料 ${ref.resourceVersionId} · 段落 ${ref.paragraphId}`
}
export function HdlSource({basis}:{basis:TutorHdlBasisDisplay}) {
  return <div data-testid="tutor-hdl-source"><p>原 HDL 快照：{basis.snapshotId} · Build：{basis.buildId}（{basis.buildStatus}）</p>
    <p>原确认作品版本：{basis.workspaceRevision??'旧记录未提供'} · 快照摘要：{basis.snapshotHash}</p>
    {basis.sessionId&&<p>原 Session：{basis.sessionId} · revision {basis.sessionRevision??'未知'} · sequence {basis.confirmedSequence??'未知'} · 模拟时间 {basis.simTimePs??'未知'} ps</p>}
    {basis.operationId&&<p>原 Operation：{basis.operationId} · 结果摘要：{basis.resultHash??'未提供'}</p>}</div>
}
export function TutorHistoryView({entry,preparation}:{entry:TutorHistoryEntryDisplay;preparation:boolean}) {
  const {action,message,question}=entry,body=message.envelope.body
  return <article data-testid="tutor-history-message" data-action-id={action.actionId}>
    {question&&<div className="chat-message user"><div className="bubble">{question.envelope.question}</div><small>原已接纳问题</small></div>}
    <AgentMessage message={{role:'agent',text:body.content,phase:'settled'}} sourceLabel={preparation?'学习助手 · 合成历史记录':'学习助手 · 获准历史记录'}>
      <details className="tutor-details"><summary>历史来源与帮助说明</summary>
      <p>原 Job：{action.jobId} · 原 Message：{action.messageId}</p>
      {action.basis.objectRef&&<p data-testid="tutor-history-object">原对象：{JSON.stringify(action.basis.objectRef)}（仅核对来源，不定位当前作品）</p>}
      {action.basis.hdl&&<HdlSource basis={action.basis.hdl}/>}
      {question?.envelope.hdlSelection&&!action.basis.hdl&&<p>旧 HDL 记录缺少冻结来源，仅核对历史，不能视为当前板卡或代码建议。</p>}
      <p>原帮助政策：{action.targetVersions.policyVersionId} · 原 epoch：{action.basis.decisionEpoch}</p>
      <p>原状态：{action.disposition}{action.basisRevised?' · 依据后来修订':''}{action.stopReason?` · ${action.stopReason}`:''}</p>
      <p>下一步：{body.expectedStudentAction}</p><p>帮助条件：{body.assistanceContext}</p>
      <p>原回执：{action.receipts.some(r=>r.receiptKind==='displayed')?'曾报告展示':'没有展示回执'} · {action.receipts.some(r=>r.receiptKind==='acknowledged')?'曾明确回应':'没有明确回应回执'}；不证明阅读、理解或采纳。</p>
      {!!body.unresolved.length&&<p>原未解决项：{body.unresolved.join('；')}</p>}
      </details>
    </AgentMessage>
  </article>
}

/** The outer div and direct AgentMessage child are part of the displayed-observation contract. */
export function TutorMessageView({ message, preparation, elementRef, sourceNotice, hdlSourceNotice, onAcknowledge, onExample }: TutorMessageViewProps) {
  const p = message.payload
  return <div ref={elementRef} data-testid="tutor-message" data-action-id={p.actionId}>
    <AgentMessage message={{ role: 'agent', text: p.content!, phase: 'settled' }} sourceLabel={preparation ? '学习助手 · 合成准备内容' : '学习助手 · 获准完整正文'}>
      <p className="tutor-next"><b>下一步：</b>{p.expectedStudentAction ?? '公开结果未提供下一步。'}</p>
      <details className="tutor-details"><summary>回答来源与帮助说明</summary>
      {p.jobId&&p.messageId&&p.basis&&p.targetVersions?<div data-testid="tutor-source">
        <p>原 Job：{p.jobId} · 原 Message：{p.messageId}</p>
        <p>回答来源：{p.basis.objectRef?objectDescription(p.basis.objectRef):'原尝试的项目问题'} · 原政策：{p.targetVersions.policyVersionId}</p>
        {p.basis.objectRef&&<p>{sourceNotice??'只核对原对象，不定位或替换当前作品。'}</p>}
        {p.basis.hdl&&<HdlSource basis={p.basis.hdl}/>}
        {!!hdlSourceNotice&&<p>{hdlSourceNotice}</p>}
      </div>:<p>当前公开结果缺少原始对象关联，不能确定对应的代码或运行。</p>}
      {p.rationale && <p>支持目的：{p.rationale}</p>}
      {p.assistanceContext && <p>帮助条件：{p.assistanceContext}</p>}
      {!!p.unresolved?.length && <p>未解决：{p.unresolved.join('；')}</p>}
      {!!p.resourceRefs?.length && <p>公开资料引用：{p.resourceRefs.join('、')}（正文须另行获准读取）</p>}
      {!!p.evidenceIds?.length && <p>证据引用：{p.evidenceIds.join('、')}（详情未交接）</p>}
      </details>
      {(!message.valid || p.basisRevised) && <p>原客户端已展示的历史；当前依据已变或尚未核验。</p>}
      <p data-testid="tutor-facts">收到：{message.facts.received?.state==='confirmed' ? '已确认' : '待确认'} · 展示：{message.facts.displayed ? '本机已发生' : '未发生'} · 回应：{message.facts.acknowledged ? '明确回应' : '未回应'}</p>
      <button type="button" disabled={!message.shown || !!message.facts.acknowledged} onClick={onAcknowledge}>我先试试</button>
      {onExample && !!p.resourceRefs?.length && <button type="button" onClick={onExample}>{preparation?'查看获准类似例子':'查看引用资料'}</button>}
    </AgentMessage>
  </div>
}

export type HdlSourceProps = Parameters<typeof HdlSource>[0]
export type TutorHistoryViewProps = Parameters<typeof TutorHistoryView>[0]
