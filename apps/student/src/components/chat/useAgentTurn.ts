import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { learningApi } from '../../bridge/agentApi'
import type { ChatMessage,ChatImage } from '../../bridge/types'
import {ModelConfigurationChangedError} from '../../lib/modelSettings'
type Question={text:string;images?:ChatImage[]}

/** 回合只更新发起时的页面；网络结果未知时保留原问题和已收到正文。 */
export function useAgentTurn(conversationId: string | null) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [live, setLive] = useState<ChatMessage | null>(null)
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [pendingImages,setPendingImages]=useState<ChatImage[]>([])
  const [queued, setQueued] = useState<string | null>(null)
  const [active, setActive] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [settledId, setSettledId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const handoff = useRef<string | null>(null)
  const scope = useRef(conversationId)
  const generation = useRef(0)
  const activeRef = useRef(false)
  const queuedRef = useRef<Question | null>(null)
  const unsentRef = useRef<Question | null>(null)
  const convIdRef = useRef(conversationId)
  if (scope.current !== conversationId) {
    scope.current = conversationId
    if (handoff.current !== conversationId) { generation.current++; activeRef.current = false; queuedRef.current = null;unsentRef.current=null }
  }
  convIdRef.current = conversationId
  useEffect(() => () => { generation.current++; learningApi.stopTurn() }, [])
  useEffect(() => {
    if (handoff.current && handoff.current === conversationId) { handoff.current = null; return }
    learningApi.stopTurn()
    setLive(null); setPendingUser(null);setPendingImages([]); setQueued(null); setActive(false); setReplacing(false); setSettledId(null); setError('')
  }, [conversationId])
  const startRef = useRef<(question: Question) => void>(() => {})
  const run = useCallback((mode: 'send' | 'retry' | 'resume', question?: Question) => {
    if (activeRef.current) return
    const g = generation.current
    const cid = convIdRef.current
    activeRef.current = true; setActive(true); setError('')
    unsentRef.current=null
    setLive({ role: 'agent', text: '', phase: 'waiting' })
    setReplacing(mode !== 'send')
    if (mode === 'send') {setPendingUser(question?.text ?? '');setPendingImages(question?.images??[])}
    else {setPendingUser(null);setPendingImages([])}
    const current = () => generation.current === g
    const onUpdate = (message: ChatMessage) => { if (current()) setLive(message) }
    const request = mode === 'send'
      ? learningApi.sendMessageStream({ conversationId: cid, text: question?.text ?? '',...(question?.images?.length?{images:question.images}:{}), onUpdate })
      : mode === 'retry' ? learningApi.retryLast({ conversationId: cid!, onUpdate })
      : learningApi.resumeTurn({ conversationId: cid!, onUpdate })
    void request.then(async result => {
      if (!current()) return
      const fresh = await learningApi.getConversation(result.conversationId)
      if (!current()) return
      if (!fresh) throw new Error('回合已返回，但会话尚未读取，请重新打开原会话核对。')
      queryClient.setQueryData(['conversation', result.conversationId], fresh)
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setSettledId(result.conversationId); setPendingUser(null);setPendingImages([]); setLive(null); setActive(false); setReplacing(false); activeRef.current = false
      if (!cid) { handoff.current = result.conversationId; convIdRef.current = result.conversationId; navigate('/agent/' + result.conversationId, { replace: true }) }
      const next = queuedRef.current
      queuedRef.current = null; setQueued(null)
      if (next && result.final.phase === 'settled') startRef.current(next)
    }).catch((reason: unknown) => {
      if (!current()) return
      setError(reason instanceof Error ? reason.message : '请求未确认，请重新读取原会话核对。')
      const modelChanged=reason instanceof ModelConfigurationChangedError;
      if(modelChanged&&mode==='send')unsentRef.current=question??null;
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setLive(previous => previous && ['settled', 'stopped', 'failed'].includes(previous.phase ?? '') ? previous : {
        role: 'agent', text: previous?.text ?? '', phase: 'failed', failure: modelChanged?{reason:'model',code:'MODEL_CONFIGURATION_CHANGED'}:{reason:'network'},
      })
      setActive(false); activeRef.current = false; queuedRef.current = null; setQueued(null)
    })
  }, [navigate, queryClient])
  startRef.current = question => run('send', question)
  const send = useCallback((text: string,images?:ChatImage[]) => {
    const question={text,...(images?.length?{images}:{})}
    if (activeRef.current) { queuedRef.current = question; setQueued(text||images?.map(image=>image.name).join('、')||'图片') } else startRef.current(question)
  }, [])
  const stop = useCallback(() => learningApi.stopTurn(), [])
  const retry = useCallback(() => { if(activeRef.current)return;if(unsentRef.current)run('send',unsentRef.current);else if(convIdRef.current)run('retry') }, [run])
  const resume = useCallback(() => { if (convIdRef.current && !activeRef.current) run('resume') }, [run])
  return { live, pendingUser,pendingImages, queued, active, replacing, settledId, error, send, stop, resume, retry }
}
