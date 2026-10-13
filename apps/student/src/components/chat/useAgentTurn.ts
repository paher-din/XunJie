import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { learningApi } from '../../bridge/mockAdapter'
import type { ChatMessage } from '../../bridge/types'

/**
 * Agent 对话页的一条回合（docs/agent-page-design.md 状态机）：
 * - send：乐观上屏学生消息，启动流式回合；生成中再 send 进入排队（一条），
 *   回合终态后自动发出排队内容（已确认 2026-10-09）。
 * - stop / resume / retry：停止（保留半截）、继续生成、重试（替换原消息）。
 * - live 是生成中的 agent 消息快照；replacing 为 true 时（继续 / 重试），
 *   页面应隐藏会话里最后一条 agent 消息，改由 live 渲染（原位更新）。
 */
export function useAgentTurn(conversationId: string | null) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [live, setLive] = useState<ChatMessage | null>(null)
  /** 已上屏但未落进会话查询的学生消息（乐观插入）。 */
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  /** 排队中的下一条。 */
  const [queued, setQueued] = useState<string | null>(null)
  /** 回合进行中（waiting / thinking / streaming）。 */
  const [active, setActive] = useState(false)
  /** 继续 / 重试进行中：会话最后一条 agent 消息由 live 原位接管。 */
  const [replacing, setReplacing] = useState(false)

  const convIdRef = useRef(conversationId)
  convIdRef.current = conversationId
  const queuedRef = useRef<string | null>(null)
  const activeRef = useRef(false)

  const finish = useCallback(
    async (cid: string) => {
      await queryClient.invalidateQueries({ queryKey: ['conversation', cid] })
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setPendingUser(null)
      setLive(null)
      setActive(false)
      setReplacing(false)
      activeRef.current = false
      if (!convIdRef.current) {
        convIdRef.current = cid
        navigate('/agent/' + cid, { replace: true })
      }
      const q = queuedRef.current
      if (q) {
        queuedRef.current = null
        setQueued(null)
        startRef.current(q)
      }
    },
    [queryClient, navigate],
  )

  const fail = useCallback(() => {
    setPendingUser(null)
    setLive(null)
    setActive(false)
    setReplacing(false)
    activeRef.current = false
  }, [])

  const startRef = useRef<(text: string) => void>(() => {})
  startRef.current = (text: string) => {
    setActive(true)
    activeRef.current = true
    setPendingUser(text)
    learningApi
      .sendMessageStream({ conversationId: convIdRef.current, text, onUpdate: setLive })
      .then(({ conversationId: cid }) => finish(cid))
      .catch(fail)
  }

  const send = useCallback((text: string) => {
    if (activeRef.current) {
      queuedRef.current = text
      setQueued(text)
      return
    }
    startRef.current(text)
  }, [])

  const stop = useCallback(() => learningApi.stopTurn(), [])

  const resume = useCallback(() => {
    const cid = convIdRef.current
    if (!cid || activeRef.current) return
    setActive(true)
    activeRef.current = true
    setReplacing(true)
    learningApi
      .resumeTurn({ conversationId: cid, onUpdate: setLive })
      .then(({ conversationId: id }) => finish(id))
      .catch(fail)
  }, [finish, fail])

  const retry = useCallback(() => {
    const cid = convIdRef.current
    if (!cid || activeRef.current) return
    setActive(true)
    activeRef.current = true
    setReplacing(true)
    learningApi
      .retryLast({ conversationId: cid, onUpdate: setLive })
      .then(({ conversationId: id }) => finish(id))
      .catch(fail)
  }, [finish, fail])

  return { live, pendingUser, queued, active, replacing, send, stop, resume, retry }
}
