import { Icon, IconText } from '../icons'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { learningApi } from '../bridge/mockAdapter'
import type { ProjectTask } from '../bridge/types'
import {
  MODELS,
  MODEL_CHANGE_EVENT,
  MODEL_KEY,
  PromptInput,
  type PromptAttachment,
} from '../components/PromptInput'
import { AgentMessage, type GenCardSlots } from '../components/chat/AgentMessage'
import { MessageRail } from '../components/chat/MessageRail'
import { QUEUE_TIP } from '../components/chat/copy'
import { TaskPicker } from '../components/chat/TaskPicker'
import { useAgentTurn } from '../components/chat/useAgentTurn'
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
  const { conversationId } = useParams()
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
  const prevPendingRef = useRef<string | null>(null)
  const queryClient = useQueryClient()

  const snapshot = useQuery({
    queryKey: ['home'],
    queryFn: () => learningApi.getHomeSnapshot(),
  })
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

  const turn = useAgentTurn(conversationId ?? null)

  const allMessages = conversation.data?.messages ?? []
  // 继续 / 重试时，会话最后一条 agent 消息由 live 原位接管，避免双份一闪而过
  const messages = turn.replacing ? allMessages.slice(0, -1) : allMessages
  const lastAgentIdx = messages.map((m) => m.role).lastIndexOf('agent')
  const tasks = snapshot.data?.tasks ?? []

  // 追问选项（2026-10-10 定稿）：取最近一条落定 agent 消息的 followUps，
  // 浮在输入框上方；生成中原选项保留、可再点（点击走排队），下一轮落定后替换。
  const lastAgent = lastAgentIdx >= 0 ? messages[lastAgentIdx] : undefined
  const followUps =
    lastAgent && (!lastAgent.phase || lastAgent.phase === 'settled')
      ? (lastAgent.followUps ?? [])
      : []

  // 对话流底部为叠层卡片（初始建议 / 追问选项）常驻留白：叠层浮在输入框上方、
  // absolute 不占布局，留白让落定操作条与叠层各占其位（几何见 app.css .chat-inner 一段）。
  // 自发送首条消息起常驻，不随草稿显隐——输入/落定/排队全程底部几何零跳动。
  const padSuggest = !!conversationId || messages.length > 0 || !!turn.pendingUser || turn.active

  // 新消息 / 流式追加 / 乐观上屏时把对话流滚到底部；学生上滑翻历史即释放，不拽动（2026-10-10 定稿）。
  // 自己发出的消息（含排队后发出）上屏瞬间重新吸附——发消息就是看回答的意图。
  useEffect(() => {
    if (turn.pendingUser && prevPendingRef.current === null) stickRef.current = true
    prevPendingRef.current = turn.pendingUser
    const el = wrapRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, turn.live?.text, turn.pendingUser])

  // 切换会话：重新吸附并滚到底
  useEffect(() => {
    stickRef.current = true
    arrivingRef.current = false
    setAtBottom(true)
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
    // Mock 边界：附件不上传，仅把文件名附在消息里呈现
    const suffix = attachments.length
      ? '\n📎 ' + attachments.map((a) => a.name).join('、')
      : ''
    turn.send(trimmed + suffix)
    setInput('')
  }

  /** 换个模型重试：切到另一可选模型（写回选择并通知输入区按钮），然后重发上一回合。 */
  const switchModelAndRetry = () => {
    const current = localStorage.getItem(MODEL_KEY) ?? MODELS[0].id
    const next = MODELS.find((m) => m.id !== current) ?? MODELS[0]
    localStorage.setItem(MODEL_KEY, next.id)
    window.dispatchEvent(new Event(MODEL_CHANGE_EVENT))
    turn.retry()
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
        <div className="chat-viewport">
          <MessageRail scrollerRef={wrapRef} onJump={jumpToMessage} />
          <div className="chat-wrap" ref={wrapRef} onScroll={onChatScroll}>
            <div
              className={
                'chat-inner' + (padSuggest ? ' pad-suggest' : '') + (turn.queued ? ' pad-queue' : '')
              }
            >
              {messages.length > 0 || turn.pendingUser ? (
                <>
                  {messages.map((m, i) =>
                    m.role === 'user' ? (
                      <div key={i} className="chat-message user">
                        <div className="bubble">{m.text}</div>
                      </div>
                    ) : (
                      <AgentMessage
                        key={i}
                        message={m}
                        onResume={i === lastAgentIdx ? turn.resume : undefined}
                        onRetry={i === lastAgentIdx ? turn.retry : undefined}
                        onSwitchModel={i === lastAgentIdx ? switchModelAndRetry : undefined}
                        onQuizAnswer={answerQuiz(i)}
                        genCardSlots={genCardHandlers(i)}
                      >
                        {m.taskId &&
                          (() => {
                            const task = tasks.find((t) => t.id === m.taskId)
                            return task ? <TaskEntryCard task={task} /> : null
                          })()}
                      </AgentMessage>
                    ),
                  )}
                  {turn.pendingUser && (
                    <div className="chat-message user">
                      <div className="bubble">{turn.pendingUser}</div>
                    </div>
                  )}
                  {turn.live && <AgentMessage message={turn.live} />}
                </>
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
                contextTokens={conversation.data?.contextTokens ?? 0}
              />
            </div>
            <div className="chat-disclaimer">本地模拟环境 · 生成内容仅供教学参考</div>
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
