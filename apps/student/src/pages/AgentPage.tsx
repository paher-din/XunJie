import { Icon, IconText } from '../icons'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PREP_BUILD } from '../workspace/mode'
import { getSessionState } from '../workspace/session'
import { getModelSettings, personalModelOptions, saveModelSettings, useModelSettings } from '../lib/modelSettings'
import { learningApi } from '../bridge/agentApi'
import type { ChatMessage, ProjectTask } from '../bridge/types'
import {
  MODELS,
  MODEL_CHANGE_EVENT,
  MODEL_KEY,
  PromptInput,
  type PromptAttachment,
} from '../components/PromptInput'
import { AgentMessage, type GenCardSlots } from '../components/chat/AgentMessage'
import { MessageRail } from '../components/chat/MessageRail'
import { UserMessage } from '../components/chat/UserMessage'
import { QUEUE_TIP } from '../components/chat/copy'
import { TaskPicker } from '../components/chat/TaskPicker'
import { TurnAriaStatus } from '../components/chat/TurnAriaStatus'
import { useAgentTurn } from '../components/chat/useAgentTurn'
import { useFollowBottom } from '../components/chat/useFollowBottom'
import { SuggestionStack } from '../components/SuggestionStack'
import { MascotSvg } from '../components/Mascot'
import { ProgressBar } from '../components/ProgressBar'
import { StatusChip } from '../components/StatusChip'
import { formatDeadline, progressPercent } from '../lib/tasks'

/** 收纳占位行「打开」→ 工作区交接意图的 sessionStorage 键（WorkspacePage 进入即消费）。 */
const GEN_HANDOFF_KEY = 'ws-gen-handoff'

/** 离底释放阈值（px）：上滑超出即释放跟随，Dock 换挡到「回到底部」。 */
const RELEASE_PX = 80
/** 回底吸附阈值（px）：回到这个距离内才重新吸附。两挡之差是回差，避免在边界上反复换挡。 */
const ATTACH_PX = 40

/** 程序化滚动的行为档：减少动效时直接落位（⑦ 全局规则的 JS 侧对应）。 */
const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

/**
 * Agent 对话页（已确认：docs/home-design.md「全局 Agent 对话页」）：
 * 历史会话 / 搜索 / 新对话在全局侧栏「Agent 对话」展开区（2026-10-01 上移）；
 * 本页主体为纯对话流，任务入口以消息内任务卡呈现。
 * 回合按 docs/agent-page-design.md 状态机流式渲染（useAgentTurn + sendMessageStream）；
 * 当前回复为本地模拟内容，接真实 Agent 时只替换 bridge 适配器。
 *
 * 空状态（2026-10-10 确认）：首次使用（没有任何历史会话）与「新会话」文案不同；
 * 推荐问题按学生画像与当前任务生成（suggestQuestions），以 SuggestionStack 叠层卡片
 * 浮在输入框上方，点击只填草稿不发送。
 *
 * 输入框上方那一格是换挡位（2026-10-11 定稿）：停在对话流底部时浮建议 / 追问叠层，
 * 上滑翻历史时换成居中的「回到底部」圆钮——翻历史时不给阅读添遮挡，贴底时几秒可达。
 */
export default function AgentPage() {
  const routeConversationId = useParams().conversationId
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  /** 是否吸附在对话流底部：学生上滑即释放，回到底部附近重新吸附。 */
  const stickRef = useRef(true)
  /** 吸附态，也是输入框上方 Dock 的挡位：贴底浮建议叠层，离底浮「回到底部」圆钮。 */
  const [atBottom, setAtBottom] = useState(true)
  /** 平滑回底途中：途径的中间位置不算「离底」，落定或被学生接手后再评估。 */
  const arrivingRef = useRef(false)
  /** 上一次滚动位置换算的离底距离：平滑回底途中反向变大即视为学生接手。 */
  const distanceRef = useRef(0)
  /** 贴底跟随自己写入的 scrollTop：onScroll 用它把「我们搬的位置」与「学生上滑」分开。 */
  const oursScrollRef = useRef(-1)
  /** 上一次看到的会话 id：用来分辨「切换会话」与「新会话刚落定才有 id」。 */
  const prevCidRef = useRef<string | null | undefined>(undefined)
  const queryClient = useQueryClient()
  const models = useModelSettings()
  const [operationError, setOperationError] = useState('')
  const operation = useRef(0)
  useEffect(() => { operation.current++; setOperationError(''); setInput(''); return () => { operation.current++ } }, [routeConversationId])

  const snapshot = useQuery({
    queryKey: ['agent-task-options'],
    queryFn: () => learningApi.listTasks(),
  })
  const turn = useAgentTurn(routeConversationId ?? null)
  /**
   * 本页对哪条会话说话：路由参数，或刚落定那一帧回合报的 id。
   * 新会话首条回复落定时 navigate(replace) 比同批的状态更新晚一帧才落到 useParams，
   * 只认路由参数的话会话查询会是空的——整条对话退回空状态再重建（重挂载 + 入场重播 + 位移），
   * 实测 60ms 空窗。回合的 settledId 把这一帧接上，路由参数一变即作废。
   */
  const conversationId = routeConversationId ?? turn.settledId
  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => learningApi.getConversation(conversationId!),
    enabled: !!conversationId,
  })
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => learningApi.listConversations(),
  })
  const suggestions = useQuery({
    queryKey: ['suggestions'],
    queryFn: () => learningApi.suggestQuestions(),
    staleTime: Infinity,
  })

  const allMessages = conversation.data?.messages ?? []
  // 继续 / 重试时，会话最后一条 agent 消息由 live 原位接管，避免双份一闪而过。
  // 只切 agent 消息：刚改写过问题时会话末尾是学生消息，它得留在屏上。
  const replacingAgent =
    turn.replacing && allMessages[allMessages.length - 1]?.role === 'agent'
  const messages = replacingAgent ? allMessages.slice(0, -1) : allMessages
  const tasks = snapshot.data ?? []

  /**
   * 一条平铺到底的渲染行：会话历史 + 乐观上屏的学生消息 + 生成中的 live。
   * key 取它们落进历史之后的下标，于是落定交接时 React 复用同一批 DOM 节点，
   * 只是换 props——不重挂载就不重播 .chat-message 的入场（那一下就是「抽」），
   * 卡片与操作条也不必等第二次渲染才出现。stored = 在历史里的下标，
   * -1 表示这条还没进会话存储（按消息定位的本地动作槽不给）。
   */
  const rows: { key: string; msg: ChatMessage; stored: number }[] = [
    ...messages.map((msg, i) => ({ key: 'm' + i, msg, stored: i })),
    ...(turn.pendingUser
      ? [
          {
            key: 'm' + messages.length,
            msg: { role: 'user' as const, text: turn.pendingUser },
            stored: -1,
          },
        ]
      : []),
    ...(turn.live
      ? [
          {
            key: 'm' + (messages.length + (turn.pendingUser ? 1 : 0)),
            msg: turn.live,
            stored: -1,
          },
        ]
      : []),
  ]
  // 最后一条 agent 消息才挂继续 / 重新生成 / 换模型；算在渲染行上，
  // 所以 live 一落定就有操作条，交接后不会再多出一枚键
  const lastAgentRow = rows.reduce((acc, r, i) => (r.msg.role === 'agent' ? i : acc), -1)

  // 追问选项（2026-10-10 定稿）：取最近一条落定 agent 消息的 followUps，
  // 浮在输入框上方；生成中原选项保留、可再点（点击走排队），下一轮落定后替换。
  const lastAgent = lastAgentRow >= 0 ? rows[lastAgentRow].msg : undefined
  const followUps =
    lastAgent && (!lastAgent.phase || lastAgent.phase === 'settled')
      ? (lastAgent.followUps ?? [])
      : []

  // 对话流底部为叠层卡片（初始建议 / 追问选项）常驻留白：叠层浮在输入框上方、
  // absolute 不占布局，留白让落定操作条与叠层各占其位（几何见 app.css .chat-inner 一段）。
  // 自发送首条消息起常驻，不随草稿显隐——输入/落定/排队全程底部几何零跳动。
  const padSuggest = !!conversationId || messages.length > 0 || !!turn.pendingUser || turn.active

  // 新回合开始那一帧重新吸附并瞬时贴底：发消息、重新生成、继续生成、改写后重发都算「我要看这条回答」，
  // 「我发出去了」的反馈不等动画（第 18 条）。不重新吸附会漏掉改写这条——编辑框打开时浏览器把那条
  // 滚进视野（focus 的自然行为）即释放跟随，不吸附的话新正文会在视口外悄悄流完（实测离底 592）。
  // 正文逐字与落定撑出的卡片高度都交给 useFollowBottom 的滑行：瞬时贴底会把每行长高读成一次位移。
  useEffect(() => {
    if (!turn.active && !turn.pendingUser) return
    stickRef.current = true
    // 当帧换挡：贴底位是 Dock 的挡位来源，位置没真的移动时不会来 scroll 事件替我们改
    setAtBottom(true)
    const el = wrapRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turn.active, turn.pendingUser])
  useFollowBottom({ scroller: wrapRef, stick: stickRef, ours: oursScrollRef })

  // 切换会话：重新吸附并瞬时落到底（历史很长，滑下去是「飞」不是「跟」）。
  // 新会话的 id 是落定那一帧才出现的（navigate 比状态更新晚一帧，见 useAgentTurn.settledId）——
  // 那不是切换会话，位置本来就该交给上面的滑行，这里重贴会把滑行拦腰切成一次瞬移（实测 525px）。
  useEffect(() => {
    const prev = prevCidRef.current
    prevCidRef.current = conversationId
    stickRef.current = true
    setAtBottom(true)
    if (!prev && conversationId && turn.settledId === conversationId) return
    const el = wrapRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversationId])

  /** 滚动释放 / 吸附判定（两段阈值见 RELEASE_PX / ATTACH_PX）；离底即换挡到「回到底部」。 */
  const onChatScroll = () => {
    const el = wrapRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const previous = distanceRef.current
    distanceRef.current = distance
    // 贴底跟每一格的位移都记在案：跟随只会把位置往下搬，所以来的事件位置不比它写下的更低，
    // 就是它自己搬的那一格；更低才是学生上滑（滑行途中的离底可以上百 px，按位置判会误杀跟随）
    const ours = oursScrollRef.current
    if (ours >= 0 && el.scrollTop > ours - 1.5) return
    // 平滑回底途中：位置仍在收近（或已到底）就继续等；一旦反向变大 = 学生接手，按新位置判定
    if (arrivingRef.current) {
      if (distance > 4 && distance <= previous + 2) return
      arrivingRef.current = false
    }
    const stick = stickRef.current ? distance < RELEASE_PX : distance < ATTACH_PX
    stickRef.current = stick
    setAtBottom(stick)
  }

  /** 回到底部：当帧换挡（圆钮交班给叠层、动作即反馈），再平滑滚下并恢复吸附。 */
  const backToBottom = () => {
    stickRef.current = true
    arrivingRef.current = true
    oursScrollRef.current = -1
    setAtBottom(true)
    wrapRef.current?.scrollTo({ top: wrapRef.current.scrollHeight, behavior: scrollBehavior() })
  }

  /** 导轨跳转（2026-10-11）：末条 = 回到底部重新吸附；中间条 = 居中该条并释放跟随。 */
  const jumpToMessage = (el: HTMLElement, last: boolean) => {
    if (last) {
      backToBottom()
      return
    }
    const wrap = wrapRef.current
    if (!wrap) return
    stickRef.current = false
    arrivingRef.current = false
    setAtBottom(false)
    const wrapRect = wrap.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    wrap.scrollTo({
      top: wrap.scrollTop + rect.top - wrapRect.top - (wrap.clientHeight - rect.height) / 2,
      behavior: scrollBehavior(),
    })
  }

  // 叠层留白出现 / 排队提示抬高叠层时，本来就在底部附近则跟到底一次（操作条不被盖住）；
  // 在上方翻历史时不拽动
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight
  }, [padSuggest, turn.queued])

  const doSend = (text: string, attachments: PromptAttachment[] = []) => {
    const trimmed = text.trim()
    if (!trimmed && attachments.length === 0) return
    if (!PREP_BUILD && attachments.length) { setOperationError('独立聊天暂不支持附件，请移除附件后发送。'); return }
    if (!PREP_BUILD && (models.saving || models.loading)) { setOperationError('等待模型配置保存确认后再发送。'); return }
    // 准备演示附件只显示文件名。
    const suffix = attachments.length
      ? '\n📎 ' + attachments.map((a) => a.name).join('、')
      : ''
    turn.send(trimmed + suffix)
    setInput('')
  }

  /** 换个模型重试：切到另一可选模型（写回选择并通知输入区按钮），然后重发上一回合。 */
  const switchModelAndRetry = () => {
    if (PREP_BUILD) {
      const current = localStorage.getItem(MODEL_KEY) ?? MODELS[0].id
      const next = MODELS.find(m => m.id !== current) ?? MODELS[0]
      localStorage.setItem(MODEL_KEY, next.id); window.dispatchEvent(new Event(MODEL_CHANGE_EVENT)); turn.retry()
      return
    }
    const options = personalModelOptions(getModelSettings().data)
    const next = options.find(m => m.id !== models.data?.defaultModelId)
    if (!next) { setOperationError('请先在模型设置中添加另一个可用模型。'); return }
    const epoch = getSessionState().epoch, op = operation.current
    void saveModelSettings({ defaultModelId: next.id }).then(() => { if (op === operation.current && epoch === getSessionState().epoch) turn.retry() }).catch(() => { if (op === operation.current && epoch === getSessionState().epoch) setOperationError('模型切换未确认，请重新读取配置。') })
  }

  /**
   * 改写一条学生消息（消息级操作「编辑我的消息」，已确认 2026-10-11 第 24 条）：
   * 适配层原位替换并截掉其后内容，会话查询落定后走 retry——此时会话末尾就是这条
   * 新问题，retry 直接给它补一条回答（与第 9 条重试同一条语义）。
   */
  const editUserMessage = async (messageIndex: number, text: string) => {
    if (!conversationId || turn.active) return
    const epoch = getSessionState().epoch, op = operation.current
    const current = () => op === operation.current && epoch === getSessionState().epoch
    try {
      const original = allMessages[messageIndex]
      if (!original || original.role !== 'user') throw new Error('原消息不可用')
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([original.role, original.text, original.at ?? null])))
      const expectedMessageHash = [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')
      if (!current()) return
      await learningApi.editUserMessage({ conversationId, messageIndex, text, expectedMessageHash })
      if (!current()) return
      const fresh = await learningApi.getConversation(conversationId)
      if (!current()) return
      queryClient.setQueryData(['conversation', conversationId], fresh)
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      turn.retry()
    } catch { if (current()) setOperationError('消息编辑未确认，请重新读取原会话。') }
  }

  /** 建议卡只填草稿、不发送；焦点交给输入框，接着改或直接回车都顺手。 */
  const fillSuggestion = (text: string) => {
    setInput(text)
    anchorRef.current?.querySelector<HTMLTextAreaElement>('.prompt-input textarea')?.focus()
  }

  /** 追问选项点击即发送（引导闭环）；生成中点击由 useAgentTurn 进入排队。 */
  const askFollowUp = (text: string) => turn.send(text)

  /** 小测卡作答：写回消息的 quiz.result 并让会话查询重取，历史里保留已答状态。 */
  const answerQuiz = (messageIndex: number) => (selected: string) => {
    if (!conversationId) return
    void learningApi
      .submitQuizAnswer({ conversationId, messageIndex, selected })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }))
  }

  /* 生成交互卡（已确认 2026-10-11 第 19 条）：收纳分流 + 占位行打开 + 生成失败重试。 */

  const [picking, setPicking] = useState<{ messageIndex: number; snapshot: unknown } | null>(null)

  const taskNameOf = (taskId: string | null | undefined) =>
    taskId ? tasks.find((t) => t.id === taskId)?.name : undefined

  const doCollectGen = (messageIndex: number, taskId: string, snapshot: unknown) => {
    if (!conversationId) return
    void learningApi
      .collectGenCard({ conversationId, messageIndex, taskId, snapshot })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }))
  }

  /** 占位行「打开」：导航到任务工作区并取出该卡钉在右缘（交接意图经 sessionStorage 传递）。 */
  const openCollected = (taskId: string, cardId: string) => {
    sessionStorage.setItem(GEN_HANDOFF_KEY, JSON.stringify({ taskId, cardId }))
    navigate(`/task/${taskId}`)
  }

  const genCardHandlers = (messageIndex: number): GenCardSlots | undefined => {
    const card = messages[messageIndex]?.genCard
    if (!card) return undefined
    return {
      taskName: card.collected ? taskNameOf(card.collected.taskId) : taskNameOf(card.taskId),
      onCollect: (snapshot) => {
        if (card.taskId) doCollectGen(messageIndex, card.taskId, snapshot)
        else setPicking({ messageIndex, snapshot })
      },
      onRetry: () => {
        if (!conversationId) return
        void learningApi
          .retryGenCard({ conversationId, messageIndex })
          .then(() => queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] }))
      },
      onOpen: card.collected ? () => openCollected(card.collected!.taskId, card.cardId) : undefined,
    }
  }

  return (
    <div className="agent-layout">
      <div className="agent-main">
        {(operationError || turn.error || conversation.error || conversations.error || models.error) && <p role="alert">{operationError || turn.error || (conversation.error || conversations.error ? '会话读取失败，请重新打开或刷新后重试。' : models.error)}</p>}
        <div className="chat-viewport">
          <MessageRail scrollerRef={wrapRef} onJump={jumpToMessage} />
          {/* 只报「开始 / 结束」两件事：逐字上屏的内容不进读屏队列（见组件注释） */}
          <TurnAriaStatus phase={lastAgent ? lastAgent.phase ?? 'settled' : undefined} />
          <div className="chat-wrap" ref={wrapRef} onScroll={onChatScroll}>
            <div
              className={
                'chat-inner' + (padSuggest ? ' pad-suggest' : '') + (turn.queued ? ' pad-queue' : '')
              }
              role="log"
              aria-live="off"
              aria-busy={turn.active}
              aria-label="对话记录"
            >
              {rows.length > 0 ? (
                rows.map(({ key, msg, stored }, i) =>
                  msg.role === 'user' ? (
                    <UserMessage
                      key={key}
                      text={msg.text}
                      at={msg.at}
                      busy={turn.active}
                      onEdit={
                        stored >= 0 ? (next) => void editUserMessage(stored, next) : undefined
                      }
                    />
                  ) : (
                    <AgentMessage
                      key={key}
                      message={msg}
                      onResume={i === lastAgentRow && !!conversationId ? turn.resume : undefined}
                      onRetry={i === lastAgentRow && !!conversationId ? turn.retry : undefined}
                      onSwitchModel={i === lastAgentRow && !!conversationId ? switchModelAndRetry : undefined}
                      onQuizAnswer={PREP_BUILD && stored >= 0 ? answerQuiz(stored) : undefined}
                      genCardSlots={PREP_BUILD && stored >= 0 ? genCardHandlers(stored) : undefined}
                    >
                      {msg.taskId
                        ? (() => {
                            const task = tasks.find((t) => t.id === msg.taskId)
                            return task ? <TaskEntryCard task={task} /> : null
                          })()
                        : null}
                    </AgentMessage>
                  ),
                )
              ) : (
                <div className="chat-empty">
                  <div style={{ width: 52, margin: 'auto' }}>
                    <MascotSvg />
                  </div>
                  {/* 首次使用（无任何历史会话）：简明定位；已有会话则直入主题，不赘述默认常识 */}
                  {conversations.data && conversations.data.length === 0 ? (
                    <>
                      <h1>你好，我是循阶教学助手</h1>
                      <p style={{ color: 'var(--muted)' }}>
                        为你解答课程难点、梳理实验思路，提供针对性项目引导。
                      </p>
                    </>
                  ) : (
                    <h1>今天想探讨什么？</h1>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="chat-composer">
          <div className="chat-composer-inner">
            {/* away = 离底挡：输入框上方那一格从建议叠层换成「回到底部」圆钮（两者互斥，见 app.css） */}
            <div className={'composer-anchor' + (atBottom ? '' : ' away')} ref={anchorRef}>
              {/* 初始建议问题：按画像与当前任务生成；新会话、无回合进行、草稿为空、且停在对话流底部时浮在输入框上方 */}
              <SuggestionStack
                items={suggestions.data ?? []}
                onPick={fillSuggestion}
                show={
                  atBottom && !conversationId && !turn.active && !turn.pendingUser && input.trim() === ''
                }
              />
              {/* 追问选项：落定后出现（与操作条同刻），同上条件；点击直接发送，生成中点击排队 */}
              <SuggestionStack
                items={followUps}
                onPick={askFollowUp}
                label="延伸探讨"
                show={atBottom && !!conversationId && followUps.length > 0 && input.trim() === ''}
              />
              {turn.queued && <div className="queue-tip">{QUEUE_TIP}</div>}
              {/* 与叠层同一格、同一基准（composer-anchor 上沿往 8px）：排队提示占位时两者一起上抬，换挡不串位 */}
              <button className="back-bottom" onClick={backToBottom} aria-label="回到底部">
                <Icon name="arrow-down" size={15} />
              </button>
              <PromptInput
                value={input}
                onChange={setInput}
                onSend={doSend}
                autoFocus
                busy={turn.active}
                onStop={turn.stop}
                contextTokens={conversation.data?.contextTokens}
                showContextRing={PREP_BUILD}
              />
            </div>
            <div className="chat-disclaimer">{PREP_BUILD ? '本地模拟环境 · 生成内容仅供教学参考' : '独立对话 · 使用个人模型配置，不自动读取课程私有材料'}{!PREP_BUILD && conversation.data?.contextTokens !== undefined && <span> · 实际用量 {conversation.data.contextTokens} tokens</span>}</div>
          </div>
        </div>
      </div>
      {/* 生成卡无归属：收纳先弹任务选择器，选定才完成归属（第 19 条） */}
      {picking && (
        <TaskPicker
          tasks={tasks}
          onPick={(taskId) => {
            const p = picking
            setPicking(null)
            if (p) doCollectGen(p.messageIndex, taskId, p.snapshot)
          }}
          onCancel={() => setPicking(null)}
        />
      )}
    </div>
  )
}

/** 消息内任务卡：名称、进度、阶段、截止时间 + 进入入口；卡片留在对话记录中。 */
function TaskEntryCard({ task }: { task: ProjectTask }) {
  const navigate = useNavigate()
  const percent = progressPercent(task)
  return (
    <div className="msg-task-card">
      <div className="msg-task-top">
        <StatusChip status={task.status} />
        <span className="msg-task-course">{task.course}</span>
      </div>
      <h4>{task.name}</h4>
      <div className="msg-task-meta">
        <span>{percent}%</span>
        <span>
          阶段 {task.stepsDone}/{task.stepsTotal}
        </span>
        <span>{task.deadlineAt ? '截止 ' + formatDeadline(task.deadlineAt) : '无截止时间'}</span>
      </div>
      <ProgressBar percent={percent} done={task.status === '已完成'} />
      {/* 丝滑展开动效待后续迭代（docs/home-design.md）。 */}
      <button className="primary msg-task-enter" onClick={() => navigate('/task/' + task.id)}>
        <IconText name="arrow-right" position="end">进入任务</IconText>
      </button>
    </div>
  )
}
