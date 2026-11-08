import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { learningApi } from '../bridge/mockAdapter'
import type { ChatMessage, ProjectTask, StoredGenCard } from '../bridge/types'
import { glitch } from '../bridge/genCardDemos'
import { TurnPlayer } from '../bridge/turnPlayer'
import { buildTurnScript } from '../bridge/turnScript'
import { GenCard } from '../components/chat/GenCard'
import { FAILURE_COPY, QUEUE_TIP } from '../components/chat/copy'
import { GenSandboxHost } from '../bridge/genSandbox'
import type { GenHostFactory } from '@xunjie/ui/chat'
import { CODE_TOOLS, CenterToolArea, type CenterToolAreaHandle, type ToolKey } from '../components/workspace/CenterToolArea'
import { CodeRunCluster, CodeWorkspace } from '../components/workspace/CodeWorkspace'
import { useProjectWorkspace } from '../components/workspace/useProjectWorkspace'
import { demoProjects, toolkitOf } from '../bridge/projects'
import { scopeKey, type DraftScope } from '../lib/draftStore'
import { idbDraftRepository } from '../workspace/draftDb'
import { GuideLayer, type GuideStep } from '../components/workspace/GuideLayer'
import { SideDock } from '../components/workspace/SideDock'
import { TaskProgress as TaskProgressPresentation, TaskInfo as TaskInfoPresentation, type TaskProgressProps } from '../components/workspace/TaskPresentation'
import {
  WorkspaceChatPaneView, WorkspaceDockedChat, WorkspaceFloatingChat, WorkspaceHeader, WorkspaceMissingTask,
  WorkspacePinnedCardsColumn, WorkspacePinnedGeneratedCard, WorkspacePinnedLearningCard, WorkspaceTaskIntro,
  WorkspaceToast, WorkspaceToolkitPending,
} from '@xunjie/ui/workspace'
import { CARDS } from '../components/workspace/cards'
import { StatusChip } from '../components/StatusChip'
import { formatDeadline, progressPercent } from '../lib/tasks'

/** 对话页收纳占位行「打开」→ 工作区取出生成卡的交接意图（sessionStorage 传递，进入即消费）。 */
const GEN_HANDOFF_KEY = 'ws-gen-handoff'
const createWorkspaceGenHost: GenHostFactory = options => new GenSandboxHost(options)

/** 数字逻辑样本任务的引导脚本（课程包预置 mock）。 */
const COUNTER_GUIDE: GuideStep[] = [
  {
    at: 'dock',
    text: '欢迎来到「可交互数字计数器」！\n\n任务要求收在左边胶囊的「任务信息」里，写代码时随时点开对照。目标很简单：按一下按键，数码管上的数字加一。',
  },
  {
    at: 'board',
    text: '先认识你的板子。\n\n点几下「计数」按钮——注意数码管，它有时候会一次跳好几个数。这不是你眼花了。',
  },
  { at: 'boardRich', card: 'debounce' },
  { at: 'boardRich', card: 'segments' },
  { at: 'editor', below: true, tool: 'design', card: 'reset' },
  {
    at: 'editor',
    below: true,
    tool: 'design',
    text: '看你的设计（草稿 v4）：key 被直接采样，抖动全被当成了有效按下。\n\n思路：等 key 连续稳定几十个时钟周期，才认定一次按下。改完记得重新「检查并构建」再「烧录到虚拟板」。',
  },
]

/** 其他课程：工具包未接入前的通用引导。 */
const GENERIC_GUIDE: GuideStep[] = [
  {
    at: 'dock',
    text: '欢迎来到任务工作区！\n\n任务信息收在左边胶囊的「任务信息」里。这门课的工具包还在接入中，先对照任务目标动手吧。',
  },
]

/** 程序设计课程的开场引导：核心工具是多文件代码编辑区，草稿与确认保存分开说。 */
const CODE_GUIDE: GuideStep[] = [
  {
    at: 'editor',
    below: true,
    tool: 'design',
    text: '欢迎来到任务工作区！\n\n任务信息收在左边胶囊的「任务信息」里。中间是这门课的代码工具：可以编辑多个文件、切换标签、新建文件。改动先落在本机草稿，确认保存由你自己发起。',
  },
]

/** 工作区引导会话的模拟回复（绑定当前任务，与全局「Agent 对话」分开）。 */
function guideReply(q: string, taskId: string): ChatMessage {
  if (/毛刺|消抖/.test(q)) {
    // 生成卡完整回合（与全局同一状态机）：步骤块逐步流出，落定挂载交互卡（第 19、20 条）
    return {
      role: 'agent',
      text: '消抖的关键是不认「干净」的按键，而是忽略短时间内反复跳变的部分。我分三步演示，然后给你一张可以反复按的交互卡。\n\n这是绑定当前任务的预设引导回复。',
      steps: [
        '先看原始信号：一次按下被采成几次跳变',
        '再对比消抖：信号稳定后才认定一次按下',
        '最后打开交互卡，自己按几次验证',
      ],
      genCard: {
        cardId: 'glitch',
        title: '毛刺是什么？按键消抖对比',
        taskId,
        claimSim: false,
        srcdoc: glitch({ version: 1 }),
        version: 1,
      },
    }
  }
  if (/复位/.test(q)) {
    return {
      role: 'agent',
      text: '你现在的 rst_n 是异步复位：拉低立即清零，不等时钟边沿。任务书要求的是哪种？可以翻到任务信息栏里确认。\n\n这是预设引导回复。',
    }
  }
  return {
    role: 'agent',
    text: '已收到：「' + q + '」。\n\n这是绑定当前任务的引导会话，正式版本会结合你的设计、装载版本和运行现象来回应。本条为预设内容。',
  }
}

const SEED_MESSAGE: ChatMessage = {
  role: 'agent',
  text: '你的设计 v3 已经装载到虚拟板。\n\n现在的关键问题是：key 直接连到计数使能，按键一次的机械抖动会被当成多次计数。先按几下「计数」按钮观察现象，我们再谈怎么消抖。',
}

/**
 * 任务工作区（已确认方向 D：左侧竖向胶囊导航 + 中心工具区 + 浮动 IP 引导）。
 * - 首次进入：任务信息卡片动效展示后收进左缘胶囊；再次进入直接到工作区，
 *   IP 从上次引导进度继续（进度按任务存在会话存储，接真实 Agent 后由服务端接管）。
 * - 左侧胶囊（SideDock）：任务信息 / 卡片收纳，gooey 液滴弹出；收纳卡可钉住到右缘。
 * - 点击 IP 打开悬浮对话面板，可固定为右侧栏，取消固定恢复悬浮。
 * - 引导会话的回复按 docs/agent-page-design.md 状态机流式渲染（本地 TurnPlayer 回合，
 *   与全局 Agent 对话共用消息组件；不进会话存储，刷新后只剩预置开场消息）。
 */
export default function WorkspacePage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const snapshot = useQuery({ queryKey: ['home'], queryFn: () => learningApi.getHomeSnapshot() })

  const task = snapshot.data?.tasks.find((t) => t.id === taskId) ?? null
  /**
   * 程序设计课程的核心工具是多文件代码编辑：作品集合由课程包 mock 声明，
   * 没有声明的任务（例如数据结构那两门）继续显示「工具包接入中」，不用别门课的工具顶替。
   */
  const projectSeed = task !== null && toolkitOf(task.course) === 'code' ? (demoProjects[task.id] ?? null) : null
  /** 草稿与 model 的隔离命名空间：模式 / 账号 / Attempt 三段（mock 下 Attempt 按任务计）。 */
  const draftScope = useMemo<DraftScope>(
    () => ({ mode: 'demo', account: 'local', attemptKey: `task:${taskId}` }),
    [taskId],
  )
  const project = useProjectWorkspace(projectSeed, idbDraftRepository, draftScope)
  const guide = task?.id === 'counter' ? COUNTER_GUIDE : projectSeed !== null ? CODE_GUIDE : GENERIC_GUIDE

  const seenKey = `ws-seen:${taskId}`
  const stepKey = `ws-guide:${taskId}`
  const cardsKey = `ws-cards:${taskId}`

  const [intro, setIntro] = useState<boolean>(() => !sessionStorage.getItem(seenKey))
  const [flying, setFlying] = useState(false)
  const [stepIdx, setStepIdx] = useState<number>(() => {
    const saved = Number(sessionStorage.getItem(stepKey))
    return Number.isFinite(saved) && saved > 0 ? saved : 0
  })
  const [tool, setTool] = useState<ToolKey>('board')
  // 代码工具包只有「代码」一枚核心工具：外部聚焦请求落在别的工具上时收回代码标签
  useEffect(() => {
    if (projectSeed !== null && tool !== 'design') setTool('design')
  }, [projectSeed, tool])
  const [chatOpen, setChatOpen] = useState(false)
  const [docked, setDocked] = useState(false)
  /** 工作区会话按任务持久化（ws-conv:<taskId>，第 19 条）：先从适配层恢复，改动后覆盖写回。 */
  const [messages, setMessages] = useState<ChatMessage[]>([SEED_MESSAGE])
  const wsHydratedRef = useRef(false)
  const [draft, setDraft] = useState('')
  /** 生成中的 agent 消息快照；busy 表示回合进行中；queued 是排队中的下一条。 */
  const [live, setLive] = useState<ChatMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [milestone, setMilestone] = useState(0)
  const [queued, setQueued] = useState<string | null>(null)
  const playerRef = useRef<TurnPlayer | null>(null)
  /** 被停止回合的播放器，「继续生成」从停下的那一步继续。 */
  const stoppedRef = useRef<TurnPlayer | null>(null)
  const queuedRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  /** 顶栏标签槽：单窗格时 CenterToolArea 把工具标签 portal 到这里（浏览器式顶栏）。 */
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null)
  /** 顶栏运行簇槽：板状态、版本流与操作按钮由 CenterToolArea portal 进来。 */
  const [runSlot, setRunSlot] = useState<HTMLElement | null>(null)

  /** 卡片收纳（Q4）：collected=收进左侧胶囊，pinned=钉住在工作区右缘。 */
  const [cardStore, setCardStore] = useState<{ collected: string[]; pinned: string[] }>(() => {
    try {
      const raw = localStorage.getItem(cardsKey)
      if (raw) return JSON.parse(raw)
    } catch {
      // 损坏的持久化数据回退空
    }
    return { collected: [], pinned: [] }
  })
  const [collecting, setCollecting] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(cardsKey, JSON.stringify(cardStore))
  }, [cardsKey, cardStore])

  /* ── 工作区会话持久化：按任务恢复 / 写回（替换纯内存态，第 19 条） ── */

  useEffect(() => {
    let cancelled = false
    wsHydratedRef.current = false
    void learningApi.getWorkspaceMessages({ taskId: taskId! }).then((stored) => {
      if (cancelled) return
      if (stored.length > 0) setMessages(stored)
      wsHydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [taskId])

  useEffect(() => {
    if (!wsHydratedRef.current || !taskId) return
    void learningApi.persistWorkspaceMessages({ taskId, messages })
  }, [taskId, messages])

  /* ── 生成卡收纳存储：标签页 / 胶囊收纳 / 钉右缘共用（第 19 条） ── */

  const [genCards, setGenCards] = useState<StoredGenCard[]>([])
  /** 当前在布局里打开着的生成卡标签（关闭标签才进收纳列表、角标 +1）。 */
  const [openGenTabs, setOpenGenTabs] = useState<string[]>([])
  /** 钉在右缘的生成卡（live，从收纳快照恢复）。 */
  const [genPinned, setGenPinned] = useState<string[]>([])
  const toolAreaRef = useRef<CenterToolAreaHandle | null>(null)

  const refreshGenCards = () => {
    if (!taskId) return
    void learningApi.listGenCards({ taskId }).then(setGenCards)
  }

  useEffect(() => {
    refreshGenCards()
    // 只在该任务首次进入时消费一次对话页交接意图：取出钉在右缘
    try {
      const raw = sessionStorage.getItem(GEN_HANDOFF_KEY)
      if (!raw) return
      sessionStorage.removeItem(GEN_HANDOFF_KEY)
      const handoff = JSON.parse(raw) as { taskId: string; cardId: string }
      if (handoff.taskId !== taskId) return
      void learningApi.listGenCards({ taskId }).then((cards) => {
        setGenCards(cards)
        if (cards.some((c) => c.cardId === handoff.cardId)) {
          setGenPinned((ids) => (ids.includes(handoff.cardId) ? ids : [...ids, handoff.cardId]))
        }
      })
    } catch {
      // 交接意图损坏时忽略
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  /** 状态续写：记录存在才合并（消息内卡未收纳时不进存储）。 */
  const syncGenState = (cardId: string, snapshot: unknown) => {
    if (!taskId) return
    const current = genCards.find((c) => c.cardId === cardId)
    if (!current) return
    void learningApi.putGenCard({ taskId, card: { ...current, snapshot } })
  }

  /** 打开（或激活）生成卡标签：存储里没有这张卡时（从会话消息重开）先落一条收纳记录，状态不丢。 */
  const openGenTab = (cardId: string, card?: ChatMessage['genCard']) => {
    if (!taskId) return
    if (genCards.some((c) => c.cardId === cardId) || !card) {
      toolAreaRef.current?.openGenTab(cardId)
      return
    }
    void learningApi
      .putGenCard({
        taskId,
        card: { ...card, taskId, collectedAt: new Date().toISOString() },
      })
      .then(() => {
        refreshGenCards()
        toolAreaRef.current?.openGenTab(cardId)
      })
  }

  /** 标签页上「收纳」：取快照冻结入收纳（更新封面），标签关闭 → 胶囊角标 +1。 */
  const collectGenTab = (cardId: string, snapshot: unknown) => {
    const current = genCards.find((c) => c.cardId === cardId)
    if (current) {
      void learningApi.putGenCard({ taskId: taskId!, card: { ...current, snapshot } }).then(refreshGenCards)
    }
    toolAreaRef.current?.closeGenTab(cardId)
    showToast('已收进左侧「卡片收纳」· 沙箱已冻结')
  }

  /** 消息内卡的「收纳」：冻结进胶囊收纳，消息原位退化为占位行。 */
  const collectGenFromChat = (messageIndex: number, snapshot: unknown) => {
    const message = messages[messageIndex]
    const card = message?.genCard
    if (!message || !card || !taskId) return
    void learningApi
      .putGenCard({
        taskId,
        card: { ...card, taskId, snapshot, collectedAt: new Date().toISOString() },
      })
      .then(refreshGenCards)
    const at = new Date().toISOString()
    setMessages((ms) =>
      ms.map((m, i) => (i === messageIndex && m.genCard ? { ...m, genCard: { ...m.genCard, snapshot, collected: { taskId, at } } } : m)),
    )
    showToast('已收进左侧「卡片收纳」')
  }

  const pinGen = (cardId: string) => {
    setGenPinned((ids) => (ids.includes(cardId) ? ids : [...ids, cardId]))
    showToast('已钉在右缘 · 从收纳快照恢复，live 续跑')
  }

  /** 放回收纳：先取回最新快照（封面更新），再冻结。 */
  const unpinGen = (cardId: string, snapshot: unknown) => {
    const current = genCards.find((c) => c.cardId === cardId)
    if (current) {
      void learningApi.putGenCard({ taskId: taskId!, card: { ...current, snapshot } }).then(refreshGenCards)
    }
    setGenPinned((ids) => ids.filter((id) => id !== cardId))
    showToast('已放回收纳 · 沙箱重新冻结，封面已更新为最新状态')
  }

  function collectCard(key: string) {
    if (collecting) return
    setCollecting(key)
    window.setTimeout(() => {
      setCardStore((s) => (s.collected.includes(key) ? s : { ...s, collected: [...s.collected, key] }))
      setCollecting(null)
      showToast('已收进左侧「卡片收纳」')
    }, 520)
  }

  function pinCard(key: string) {
    setCardStore((s) => ({ collected: s.collected.filter((k) => k !== key), pinned: [...s.pinned, key] }))
  }

  function unpinCard(key: string) {
    setCardStore((s) => ({ pinned: s.pinned.filter((k) => k !== key), collected: [...s.collected, key] }))
  }

  const guideActive = !intro && stepIdx < guide.length
  const step = guideActive ? guide[stepIdx] : null

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setChatOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  function showToast(text: string) {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  function startTask() {
    setFlying(true)
    window.setTimeout(() => {
      setIntro(false)
      setFlying(false)
      sessionStorage.setItem(seenKey, '1')
    }, 720)
  }

  function nextStep(current: GuideStep) {
    const next = stepIdx + 1
    setStepIdx(next)
    if (next === guide.length) setMilestone(value => value + 1)
    sessionStorage.setItem(stepKey, String(next))
    const nextStepDef = guide[next]
    if (nextStepDef?.tool) setTool(nextStepDef.tool)
    void current
  }

  function onIpClick() {
    if (docked) {
      showToast('对话已固定在右侧；点「取消固定」后可回到悬浮对话')
      return
    }
    setChatOpen((v) => !v)
  }

  /**
   * 引导会话的本地回合：与全局「Agent 对话」共用同一状态机（TurnPlayer + 确定性剧本），
   * 但不进会话存储——刷新后只剩预置的开场消息。
   */
  function startGuideTurn(text: string, pushUser = true) {
    const reply: ChatMessage = guideReply(text, taskId!)
    const player = new TurnPlayer(buildTurnScript(text, reply), reply, setLive)
    playerRef.current = player
    setBusy(true)
    busyRef.current = true
    if (pushUser) setMessages((ms) => [...ms, { role: 'user', text }])
    void player.start().then((final) => {
      setLive(null)
      setBusy(false)
      busyRef.current = false
      setMessages((ms) => [...ms, final])
      stoppedRef.current = final.phase === 'stopped' ? player : null
      const q = queuedRef.current
      if (q) {
        queuedRef.current = null
        setQueued(null)
        startGuideTurn(q)
      }
    })
  }

  /** 生成中再发送 = 排队（一条），回合终态后自动发出（已确认 2026-10-09）。 */
  function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    if (busyRef.current) {
      queuedRef.current = trimmed
      setQueued(trimmed)
    } else {
      startGuideTurn(trimmed)
    }
    setDraft('')
  }

  function stopTurn() {
    playerRef.current?.stop()
  }

  /** 继续生成：被停止的消息从列表取下，由 live 原位接管，终态再放回。 */
  function resumeTurn() {
    const player = stoppedRef.current
    if (!player || busyRef.current) return
    stoppedRef.current = null
    setMessages((ms) => ms.slice(0, -1))
    setBusy(true)
    busyRef.current = true
    void player.resume(setLive).then((final) => {
      setLive(null)
      setBusy(false)
      busyRef.current = false
      setMessages((ms) => [...ms, final])
      if (final.phase === 'stopped') stoppedRef.current = player
    })
  }

  /** 重新生成 / 重试：替换最后一条 agent 回复，不追加（已确认 2026-10-09）。 */
  function retryTurn() {
    if (busyRef.current) return
    const lastAgentIdx = messages.map((m) => m.role).lastIndexOf('agent')
    if (lastAgentIdx < 0) return
    const question = messages
      .slice(0, lastAgentIdx)
      .reverse()
      .find((m) => m.role === 'user')?.text
    if (!question) return
    stoppedRef.current = null
    setMessages((ms) => ms.slice(0, lastAgentIdx))
    startGuideTurn(question, false)
  }

  if (snapshot.data && !task) {
    return <WorkspaceMissingTask onBack={() => navigate('/')} />
  }
  if (!task) return null

  const pct = progressPercent(task)
  const chatPane = (
    <WorkspaceChatPane
      messages={messages}
      live={live}
      busy={busy}
      queued={queued}
      draft={draft}
      onDraft={setDraft}
      onSend={sendMessage}
      onStop={stopTurn}
      onResume={resumeTurn}
      onRetry={retryTurn}
      taskName={task.name}
      onOpenGenTab={openGenTab}
      onCollectGen={collectGenFromChat}
      onSyncGen={syncGenState}
      onConceptCollect={() => showToast('概念卡已收进左侧「卡片收纳」')}
    />
  )

  return (
    <div className="ws">
      <WorkspaceHeader progress={taskProgressProps(task)} tabsRef={setTabsSlot} runRef={setRunSlot} onBack={() => {
        // 走历史回退以恢复上一个界面；直接打开工作区时回首页。
        if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
        else navigate('/')
      }} />

      <div className="ws-body">
        {task.id === 'counter' ? (
          <CenterToolArea
            ref={toolAreaRef}
            taskId={task.id}
            tool={tool}
            onToolChange={setTool}
            onToast={showToast}
            onDesignLoaded={() => setMilestone(value => value + 1)}
            genCards={genCards}
            onGenTabsChange={setOpenGenTabs}
            onGenCollect={collectGenTab}
            onGenStateSync={syncGenState}
            tabsSlot={tabsSlot}
            runSlot={runSlot}
          />
        ) : projectSeed !== null ? (
          <CenterToolArea
            taskId={task.id}
            tools={CODE_TOOLS}
            tool={tool}
            onToolChange={setTool}
            onToast={showToast}
            genCards={genCards}
            onGenTabsChange={setOpenGenTabs}
            onGenCollect={collectGenTab}
            onGenStateSync={syncGenState}
            tabsSlot={tabsSlot}
            runSlot={runSlot}
            designBody={<CodeWorkspace ws={project} workspaceKey={scopeKey(draftScope)} />}
            runCluster={
              <CodeRunCluster
                ws={project}
                onSave={() => showToast('确认保存还没有接入：现在只有本机草稿（模拟）')}
              />
            }
          />
        ) : (
          <WorkspaceToolkitPending title="这门课的工具包还在接入中。"
            description="先对照左侧「任务信息」里的目标动手；有问题点右下角的学习助手。" />
        )}

        {docked && (
          <WorkspaceDockedChat onUndock={() => setDocked(false)}>{chatPane}</WorkspaceDockedChat>
        )}

        <SideDock
          taskInfo={<TaskInfo task={task} />}
          stash={[
            ...cardStore.collected.flatMap((k) => (CARDS[k] ? [{ key: k, title: CARDS[k].title }] : [])),
            ...genCards
              .filter((c) => !genPinned.includes(c.cardId) && !openGenTabs.includes(c.cardId))
              .map((c) => ({
                key: `gen:${c.cardId}`,
                title: c.title,
                gen: { claimSim: c.claimSim, version: c.version },
              })),
          ]}
          onPin={(key) => (key.startsWith('gen:') ? pinGen(key.slice(4)) : pinCard(key))}
          onOpen={(key) => {
            if (key.startsWith('gen:')) openGenTab(key.slice(4))
          }}
          onToast={showToast}
        />

        {(cardStore.pinned.length > 0 || genPinned.length > 0) && (
          <WorkspacePinnedCardsColumn docked={docked}>
            {cardStore.pinned.map((k) => {
              const def = CARDS[k]
              if (!def) return null
              return (
                <WorkspacePinnedLearningCard key={k} title={def.title} onUnpin={() => unpinCard(k)}>
                  <def.Body />
                </WorkspacePinnedLearningCard>
              )
            })}
            {genPinned.map((id) => {
              const card = genCards.find((c) => c.cardId === id)
              if (!card) return null
              return (
                <WorkspacePinnedGeneratedCard key={id} card={card} createHost={createWorkspaceGenHost}
                  onUnpin={(snapshot) => unpinGen(id, snapshot)} onStateSync={(snapshot) => syncGenState(id, snapshot)} />
              )
            })}
          </WorkspacePinnedCardsColumn>
        )}

        {!intro && (
          <GuideLayer
            step={step}
            stepIndex={stepIdx}
            total={guide.length}
            idle={chatOpen || docked}
            busy={busy}
            milestone={milestone}
            docked={docked}
            collected={cardStore.collected}
            pinned={cardStore.pinned}
            collecting={collecting}
            onNext={nextStep}
            onCollect={collectCard}
            onIpClick={onIpClick}
          />
        )}

        {chatOpen && !docked && (
          <WorkspaceFloatingChat onDock={() => { setDocked(true); setChatOpen(false) }}
            onClose={() => setChatOpen(false)}>{chatPane}</WorkspaceFloatingChat>
        )}

        {intro && (
          <WorkspaceTaskIntro status={task.status} name={task.name} course={task.course}
            deadline={task.deadlineAt ? `截止 ${formatDeadline(task.deadlineAt)}` : '无截止时间'} goal={task.goal}
            percent={pct} done={task.status === '已完成'} currentProgress={task.last}
            actionLabel={task.status === '未开始' ? '开始任务' : '进入任务'} flying={flying} onStart={startTask} />
        )}

        {toast && <WorkspaceToast>{toast}</WorkspaceToast>}
      </div>
    </div>
  )
}

/** 旧版任务数据适配：进度、业务状态和说明文案留在页面。 */
function taskProgressProps(task: ProjectTask): TaskProgressProps {
  const percent = progressPercent(task)
  return { percent, done: task.status === '已完成', status: task.status,
    title: `任务进度：阶段 ${task.stepsDone}/${task.stepsTotal}（${percent}%）· ${task.last}`,
    ariaLabel: `任务进度 ${percent}%` }
}

export function TaskProgress({ task }: { task: ProjectTask }) {
  return <TaskProgressPresentation {...taskProgressProps(task)} />
}

/** 演示工作区显式提供演示说明，不将其作为通用任务信息的默认值。 */
export function TaskInfo({ task }: { task: ProjectTask }) {
  return (
    <TaskInfoPresentation
      name={task.name}
      status={<StatusChip status={task.status} />}
      demoNotice="演示数据 · 任务、构建与板卡结果均为界面模拟，不写入学习记录"
      goal={task.goal}
      percent={progressPercent(task)}
      done={task.status === '已完成'}
      currentProgress={task.last}
      stage={<>{task.stepsDone} / {task.stepsTotal}</>}
      deadline={task.deadlineAt ? formatDeadline(task.deadlineAt) : '无'}
      course={task.course}
    />
  )
}

/** 工作区引导对话面板主体：悬浮与固定右栏共用。消息渲染与全局 Agent 对话共用 AgentMessage。 */
export function WorkspaceChatPane({
  messages,
  live,
  busy,
  queued,
  draft,
  onDraft,
  onSend,
  onStop,
  onResume,
  onRetry,
  taskName,
  onOpenGenTab,
  onCollectGen,
  onSyncGen,
  onConceptCollect,
}: {
  messages: ChatMessage[]
  live: ChatMessage | null
  busy: boolean
  queued: string | null
  draft: string
  onDraft: (v: string) => void
  onSend: (text: string) => void
  onStop: () => void
  onResume: () => void
  onRetry: () => void
  taskName: string
  /** 消息内生成卡「在工具区打开」：开成中心工具区标签页（关掉的标签可从会话里重开，状态不丢）。 */
  onOpenGenTab: (cardId: string, card?: ChatMessage['genCard']) => void
  /** 消息内生成卡「收纳」：收进左侧胶囊卡片体系，消息原位退化为占位行。 */
  onCollectGen: (messageIndex: number, snapshot: unknown) => void
  /** live 期间的交互状态续写。 */
  onSyncGen: (cardId: string, snapshot: unknown) => void
  /** 概念卡「收纳」尾巴（第 12 条分流）：工作区 = 收进左侧胶囊卡片体系。 */
  onConceptCollect: () => void
}) {
  return <WorkspaceChatPaneView messages={messages} live={live} busy={busy} queued={queued} queueText={QUEUE_TIP}
    draft={draft} onDraft={onDraft} onSend={onSend} onStop={onStop} onResume={onResume} onRetry={onRetry}
    taskName={taskName} onOpenGenTab={onOpenGenTab} onCollectGen={onCollectGen} onSyncGen={onSyncGen}
    onConceptCollect={onConceptCollect} renderGeneratedCard={(card, slots) => <GenCard card={card} {...slots} />}
    quizRecordLabel={quiz => `已记入学习画像 · ${quiz.topic}：掌握`} failureCopy={FAILURE_COPY} />
}
