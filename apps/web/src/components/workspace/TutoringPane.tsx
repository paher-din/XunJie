import { TutorMessageView as TutorMessagePresentation, TutoringPaneView } from '@xunjie/ui/workspace'
export { HdlSource, TutorHistoryView } from '@xunjie/ui/workspace'
import { useEffect, useRef, useState } from 'react'
import type { TutoringState, TutoringWorkspace } from '../../workspace/tutoringWorkspace'
import type { TutorMessage } from '../../workspace/tutoringStore'
import type { TutorObject, TutorHdlSelection } from '../../workspace/tutoringContracts'
import { tutoringCommandFailureNotice } from '../../workspace/tutoringNotice'
import { tutorTranscript } from './tutorTranscript'
import { useFollowBottom } from '../chat/useFollowBottom'

/** Reuses WorkspacePage's existing ws-chatpop/ws-chatpane and AgentMessage slots. */
export function TutoringPane({ client, state, open, onClose, objectRef, objectLabel, onClearObject,
  onExample, objectCurrent, objectError, helpAllowed, assignmentActive, sourceStatus, hdlSelection }: { client: TutoringWorkspace | null; state: TutoringState; open: boolean; onClose: () => void
  helpAllowed?:boolean; assignmentActive?:boolean; sourceStatus?:(ref:TutorObject,message?:TutorMessage)=>string;hdlSelection?:TutorHdlSelection
  objectCurrent?: () => boolean; objectError?: string
  objectRef?: TutorObject; objectLabel?: string; onClearObject?: () => void; onExample?: (message: TutorMessage) => void }) {
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [submitting,setSubmitting]=useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true), ours = useRef(-1)
  const currentClient = useRef(client), draftRef = useRef(draft), sending = useRef(false)
  const lastSent = useRef<{client:TutoringWorkspace;jobId:string;text:string}|null>(null)
  currentClient.current = client; draftRef.current = draft
  useFollowBottom({ scroller, stick, ours })
  const ledger = state.ledger
  useEffect(()=>{
    const sent=lastSent.current, job=ledger?.job
    if(!sent||sent.client!==client||job?.jobId!==sent.jobId)return
    if(['failed','timed_out','cancelled','stale'].includes(job.status)&&!draftRef.current)setDraft(sent.text)
    if(['succeeded','failed','timed_out','cancelled','stale'].includes(job.status))lastSent.current=null
  },[client,ledger?.job])
  useEffect(()=> { setDraft(''); stick.current=true; setAtBottom(true) }, [client])
  useEffect(()=> {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if(e.key==='Escape'&&!e.isComposing) { if(expanded)setExpanded(false);else onClose() } }
    window.addEventListener('keydown', onKey)
    return ()=>window.removeEventListener('keydown', onKey)
  }, [open, expanded, onClose])
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
  const canSend=!!client&&!!ledger&&!state.busy&&!submitting&&!pending&&!!draft.trim()&&!objectError&&!unavailable
  const send = async (replace: boolean) => {
    if(!canSend||!client||sending.current)return
    const owner=client, text=draft, previous=new Set(ledger!.commands.map(c=>c.key))
    sending.current=true;setSubmitting(true);stick.current=true;setAtBottom(true)
    try {
      await owner.send(text,objectRef,replace,objectCurrent,hdlSelection)
      const accepted=owner.current.ledger?.commands.some(c=>!previous.has(c.key)&&c.kind==='help'&&c.question===text&&c.state==='confirmed')
      const job=owner.current.ledger?.job
      if(currentClient.current===owner&&accepted&&job) {
        lastSent.current={client:owner,jobId:job.jobId,text}
        if(!['failed','timed_out','cancelled','stale'].includes(job.status)&&draftRef.current===text)setDraft('')
      }
    } finally { sending.current=false;setSubmitting(false) }
  }
  const visibleMessages=attempt?ledger?.messages.filter(m=>m.shown||(m.valid&&state.synchronized&&!ledger.blocked))??[]:[]
  const rows = tutorTranscript(ledger?.commands ?? [], visibleMessages)
  return <TutoringPaneView preparation={client?.context.mode === 'preparation'} expanded={expanded} atBottom={atBottom}
    hasMessages={!!ledger?.messages.length} scrollerRef={scroller} onScroll={() => {
      const el = scroller.current; if (!el || Math.abs(el.scrollTop - ours.current) < 2) return
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; setAtBottom(stick.current)
    }} exchanges={rows.map(row => ({ key: row.key, messageIds: row.messages.map(message => message.payload.actionId),
      command: row.command && { question: row.command.question, error: row.command.error,
        statusLabel: row.command.state === 'confirmed' ? '已受理' : row.command.state === 'pending'
          ? state.sendingKey === row.command.key ? '发送中' : row.command.error ? '结果未知 · 原请求待核对' : '原请求已保存，等待发送' : '服务未接纳',
        failureNotice: row.command.error ? tutoringCommandFailureNotice(row.command) : undefined } }))}
    renderMessage={actionId => {
      const message = visibleMessages.find(item => item.payload.actionId === actionId)!
      return <TutorMessageView key={actionId} message={message} client={client} synchronized={state.synchronized}
        scroller={scroller.current} onExample={onExample} sourceStatus={sourceStatus} />
    }} running={running} waitExceeded={waitExceeded} pending={!!pending} busy={state.busy}
    canStop={!!(job && !job.stopRequested || unknownHelp && !ledger?.blocked)} job={job}
    history={state.history} canReadHistory={!!client} notice={state.notice}
    objectRef={objectRef} objectLabel={objectLabel} objectError={objectError} hdlSelection={hdlSelection}
    unavailable={unavailable} draft={draft} canSend={canSend}
    onToggleExpanded={() => setExpanded(value => !value)} onClose={onClose}
    onJumpLatest={() => { stick.current = true; setAtBottom(true); const el = scroller.current; if (el) { el.scrollTop = el.scrollHeight; ours.current = el.scrollTop } }}
    onReadHistory={() => { void client?.readHistory() }} onRetry={() => { void client?.retry() }}
    onRead={() => { void client?.read(true) }} onStop={() => { void client?.stop() }} onClearObject={onClearObject}
    onDraft={setDraft} onSend={replace => { void send(replace) }} />
}

type TutorBodyRect = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>
export const TUTOR_BODY_SELECTOR = ':scope > .chat-message.agent > .turn-body'
/** A displayed fact requires actual body pixels, independent of card length. */
export function tutorBodyVisible(facts: {
  documentVisible:boolean; connected:boolean; hasContent:boolean; styleVisible:boolean; hasClientRect:boolean
  isIntersecting:boolean; intersectionRect:TutorBodyRect; bodyRect:TutorBodyRect; viewportRect:TutorBodyRect; rootRect:TutorBodyRect|null
}) {
  const positive=(r:TutorBodyRect)=>[r.left,r.top,r.right,r.bottom,r.width,r.height].every(Number.isFinite)
    && r.width>0 && r.height>0 && r.right>r.left && r.bottom>r.top
  if(!facts.documentVisible||!facts.connected||!facts.hasContent||!facts.styleVisible||!facts.hasClientRect
    ||!facts.isIntersecting||!positive(facts.intersectionRect)||!positive(facts.bodyRect)||!positive(facts.viewportRect)
    ||facts.rootRect&&!positive(facts.rootRect))return false
  const clips=[facts.bodyRect,facts.viewportRect,...(facts.rootRect?[facts.rootRect]:[])]
  return Math.min(...clips.map(r=>r.right))>Math.max(...clips.map(r=>r.left))
    && Math.min(...clips.map(r=>r.bottom))>Math.max(...clips.map(r=>r.top))
}
export function TutorMessageView({ message, client, synchronized, scroller, onExample, sourceStatus }: {
  message: TutorMessage; client: TutoringWorkspace | null; synchronized: boolean; scroller: HTMLElement | null
  onExample?: (message: TutorMessage) => void; sourceStatus?:(ref:TutorObject,message?:TutorMessage)=>string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(()=> {
    const el = ref.current
    const body=el?.querySelector<HTMLElement>(TUTOR_BODY_SELECTOR)
    if (!body || !synchronized || !message.valid || message.facts.displayed) return
    const root=scroller??body.closest<HTMLElement>('.ws-chatbody')
    const pane=body.closest('.ws-chatpop')
    let entry:IntersectionObserverEntry|undefined
    const report = () => {
      if(!entry)return
      let styleVisible=getComputedStyle(body).visibility==='visible'
      for(let ancestor:HTMLElement|null=body;styleVisible&&ancestor;ancestor=ancestor.parentElement) {
        const style=getComputedStyle(ancestor)
        if(style.display==='none'||Number(style.opacity)===0)styleVisible=false
      }
      if(tutorBodyVisible({documentVisible:document.visibilityState==='visible',connected:body.isConnected,
        hasContent:!!body.textContent?.trim(),styleVisible,hasClientRect:Array.from(body.getClientRects()).some(r=>r.width>0&&r.height>0),
        isIntersecting:entry.isIntersecting,intersectionRect:entry.intersectionRect,bodyRect:body.getBoundingClientRect(),rootRect:root?.getBoundingClientRect()??null,
        viewportRect:{left:0,top:0,right:window.innerWidth,bottom:window.innerHeight,width:window.innerWidth,height:window.innerHeight}}))
        void client?.fact(message.payload.actionId, 'displayed')
    }
    const observer = new IntersectionObserver(entries=> {
      entry=entries.find(e=>e.target===body); report()
    }, { root, threshold: 0 })
    // Edge contact can be isIntersecting with zero area at threshold0. Obtain
    // a fresh body intersection after scrolling/showing instead of using it.
    const refresh=()=>{entry=undefined;observer.unobserve(body);observer.observe(body)}
    observer.observe(body)
    document.addEventListener('visibilitychange',refresh);root?.addEventListener('scroll',refresh)
    window.addEventListener('resize',refresh);pane?.addEventListener('animationend',refresh)
    return ()=> { observer.disconnect(); document.removeEventListener('visibilitychange',refresh);root?.removeEventListener('scroll',refresh)
      window.removeEventListener('resize',refresh);pane?.removeEventListener('animationend',refresh) }
  }, [client, message.payload.actionId, message.valid, !!message.facts.displayed, synchronized, scroller])
  return <TutorMessagePresentation elementRef={ref} message={message} preparation={client?.context.mode === 'preparation'}
    sourceNotice={message.payload.basis?.objectRef ? sourceStatus?.(message.payload.basis.objectRef, message) : undefined}
    hdlSourceNotice={client?.hdlSourceStatus(message)} onAcknowledge={() => { void client?.fact(message.payload.actionId, 'acknowledged') }}
    onExample={onExample ? () => onExample(message) : undefined} />
}
