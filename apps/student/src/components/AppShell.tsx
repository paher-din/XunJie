import { Icon } from '../icons'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { learningApi } from '../bridge/agentApi'
import type { ConversationSummary } from '../bridge/types'
import { AccountMenu } from './AccountMenu'
import { AccountAvatar } from './AccountAvatar'
import { Composer } from './Composer'
import { CompanionButton } from './CompanionButton'
import { ProfileCard } from './ProfileCard'
import { ThemeMenu } from './ThemeMenu'
import { XunjieLogo } from '../brand/XunjieLogo'
import { useAccount } from '../lib/account'
import { THEME_OPTIONS, useTheme } from '../lib/theme'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'
import { useModelSettings } from '../lib/modelSettings'
import { getSessionState } from '../workspace/session'
import { logoutSession } from '../workspace/session'

/** 历史会话按单一时间流分组：今天 / 昨天 / 更早（2026-10-11 由四档收成三档——「近 7 天」并进
    「更早」：最近两档已经由今天、昨天担起来，2 天以前统一算更早，不再切一个 7 天的口子）。 */
function groupByTime(items: ConversationSummary[], now: Date) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const groups: Array<{ label: string; items: ConversationSummary[] }> = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const s of items) {
    const t = new Date(s.updatedAt).getTime()
    if (t >= startOfDay) groups[0].items.push(s)
    else if (startOfDay - t < 86_400_000) groups[1].items.push(s)
    else groups[2].items.push(s)
  }
  return groups.filter((g) => g.items.length > 0)
}

/** 历史会话分页大小：滚动自动加载（2026-10-10 确认，替代「加载更早」按钮）。 */
const CONV_PAGE = 8

/** 可收起的分栏（2026-10-11）：置顶会持续累积、更早装着两天以前的全部存量，两栏给收起键；
    今天 / 昨天是当日工作集，标签维持纯文本。状态只活在本次会话里，刷新即回到全展开。 */
const FOLDABLE_GROUPS = new Set(['置顶', '更早'])

/** ⋯ 菜单退场时长：与 .agent-conv-menu.closing 的动画一致，播完才卸载。 */
const MENU_EXIT_MS = 140

/** 分栏收放时长：与 .agent-group-body 的 grid-template-rows 过渡同拍（展开档 240ms）。
    这段时间行照旧挂着、由 body 裁剪，播完才按收起态卸载——卸载早了收合没得看，
    晚了裁剪窗口拖长，行尾 ⋯ 菜单会被切（两头都要卡在这一个数上）。 */
const FOLD_MS = 240

/** ⋯ 菜单高度（3 项 × 32 + 内边距与描边）：判断向下展开的空间是否够用。 */
const MENU_H = 106

/** 滚动自动加载哨兵：进入视口即加载更早一页。两个挂点（侧栏 / 轨道面板）各自监听。
    signal 变化时也复核——分栏收放会把哨兵抬进视口，那一下没有滚动事件；
    signal 里带上动画收尾的时刻，最终版面要等行高动画播完才成立。 */
function ConvSentinel({ onShow, signal }: { onShow: () => void; signal?: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 用位置判定而非 IntersectionObserver：面板展开动画（overflow 裁剪）期间 IO 可能漏报
    const check = () => {
      const r = el.getBoundingClientRect()
      if (r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) onShow()
    }
    check()
    const t = window.setTimeout(check, 400) // 侧栏展开动画结束后复核一次
    window.addEventListener('scroll', check, true)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('scroll', check, true)
    }
  }, [onShow, signal])
  return (
    <div ref={ref} className="agent-conv-sentinel">
      下拉加载更早…
    </div>
  )
}

/** 归档箱开合时给「已归档」入口行下面这块内容播一次入场（开箱是箱子、收箱是列表与搜索框）。
    入场播完自己摘掉 .swap-in：之后新挂载的行（翻页追加、搜索新命中）只静态出现，不重播 */
function PaneSwap({ className, children }: { className: string; children: ReactNode }) {
  const [fresh, setFresh] = useState(true)
  return (
    <div
      className={fresh ? `${className} swap-in` : className}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setFresh(false)
      }}
    >
      {children}
    </div>
  )
}

/**
 * 应用外壳：侧栏（首页 / Agent 对话 / 设置与帮助一级入口）+ 页面出口，
 * 以及首页专属的动画 IP 与悬浮输入框。
 *
 * 侧栏「Agent 对话」的对话历史（新对话 + 搜索 + 时间流分组，
 * 已确认 2026-10-01，从 Agent 页内部侧栏上移到全局侧栏）展开态跟随路由：
 * 处于 /agent 区时展开，切到首页或其他导航块即收起。
 *
 * 已确认交互（docs/home-design.md）：
 * - IP 位于右下角，点击或 ⌘ / Ctrl + J 唤起挂在它左侧的输入气泡：气泡与入口「有问题，问我」
 *   是同一个盒子，就地长开（几何与动效见 app.css 的 .ask 一段）；
 * - Esc 收起，草稿在内存中保留；Enter 发送后进入独立 Agent 对话页（新对话）。
 * - 默认头像（学生未自定义时）为渐变泡泡：按名字哈希稳定取色（2026-10-01，
 *   形态参考 HeroUI Avatar Sizes 示例）。
 */

/** 账号条展示名与头像统一走 ../lib/account 响应式 store（设置页可改）。 */
export default function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const account = useAccount()
  const session = useSession()
  useModelSettings()
  // 外观偏好（lib/theme.ts）：按钮图标取**实际生效**的深浅——跟随系统时也要与画面一致，
  // 提示里同时标出偏好与当前值（如「跟随系统（当前深色）」）
  const { preference: themePreference, resolved: themeResolved } = useTheme()
  const themeLabel = THEME_OPTIONS.find((o) => o.value === themePreference)?.label ?? '跟随系统'
  const themeTip =
    themePreference === 'system'
      ? `外观 · 跟随系统（当前${themeResolved === 'dark' ? '深色' : '浅色'}）`
      : `外观 · ${themeLabel}`
  const onHome = location.pathname === '/'
  const onAgent = location.pathname.startsWith('/agent')
  const onSettings = location.pathname.startsWith('/settings')
  const activeConv = onAgent && location.pathname.length > 7 ? location.pathname.slice(7) : null
  // 任务工作区为沉浸模式：全局侧栏收起（已确认 2026-09-30），工作区占满全宽
  const inWorkspace = location.pathname.startsWith('/task')

  const [composerOpen, setComposerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [accountMenu, setAccountMenu] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const accountRef = useRef<HTMLDivElement>(null)
  const railAccountRef = useRef<HTMLDivElement>(null)
  // 外观菜单（浅色 / 深色 / 跟随系统，见 lib/theme.ts）：锚在侧栏月亮按钮上方
  const [themeMenu, setThemeMenu] = useState(false)
  const themeWrapRef = useRef<HTMLDivElement>(null)
  const themeBtnRef = useRef<HTMLButtonElement>(null)
  // 收起态轨道弹出的对话历史面板：null 关闭 / history 由 ✧ 打开 / search 由搜索图标打开并聚焦
  const [railPanel, setRailPanel] = useState<'history' | 'search' | null>(null)
  const [convSearch, setConvSearch] = useState('')
  // 会话行管理（2026-10-10 确认）：⋯ 菜单 → 重命名（行内输入）/ 删除（就地二次确认）；
  // 长历史滚动自动加载，convShown 为当前可见条数
  // 会话行 ⋯ 菜单：点击菜单外任意处收起；up 记录弹出方向，关的时候也按同一方向收回去
  const [convMenu, setConvMenu] = useState<{ id: string | null; up: boolean; closing: boolean }>({
    id: null,
    up: false,
    closing: false,
  })
  const menuId = convMenu.id
  const menuCloseTimer = useRef<number | undefined>(undefined)

  /** 关菜单：先挂 .closing 播收束动画（与 SuggestionStack 同一套做法），播完再卸载。 */
  const closeConvMenu = useCallback(() => {
    setConvMenu((m) => (m.id === null ? m : { ...m, closing: true }))
    window.clearTimeout(menuCloseTimer.current)
    menuCloseTimer.current = window.setTimeout(() => {
      setConvMenu((m) => (m.id === null ? m : { ...m, id: null, closing: false }))
    }, MENU_EXIT_MS)
  }, [])
  const [convRenaming, setConvRenaming] = useState<string | null>(null)
  const [convConfirming, setConvConfirming] = useState<string | null>(null)
  const [convShown, setConvShown] = useState(CONV_PAGE)
  // 归档箱（2026-10-11 定稿）：archiveOpen 管箱体开合，archShown 是箱内自己的分页游标
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archShown, setArchShown] = useState(CONV_PAGE)
  // 分栏收起态（2026-10-11）：FOLDABLE_GROUPS 里的分栏收起来后不渲染行；侧栏与轨道面板共用一份
  const [foldedGroups, setFoldedGroups] = useState<string[]>([])
  // 正在收放的那一栏：动画期间（FOLD_MS）它要保持裁剪——行尾 ⋯ 菜单要能翻出分组，只在动画期让位
  const [foldingGroup, setFoldingGroup] = useState<string | null>(null)
  const foldTimer = useRef<number | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const mainRef = useRef<HTMLElement>(null)
  const panelSearchRef = useRef<HTMLInputElement>(null)
  // 轨道与悬浮面板只在侧栏收起且非工作区沉浸态时生效
  const railVisible = sidebarCollapsed && !inWorkspace

  // 侧栏要连归档一起取（归档箱与搜索跨两组命中都要用），与 AgentPage 的「首次使用」判定分开一条缓存
  const conversations = useQuery({
    queryKey: ['conversations', 'with-archived'],
    queryFn: () => learningApi.listConversations({ includeArchived: true }),
  })

  const sendFromHome = useMutation({
    mutationFn: (text: string) => learningApi.sendMessage({ conversationId: null, text }),
    onError: () => showToast('消息发送未确认，请打开原会话核对。'),
    onSuccess: ({ conversationId }) => {
      if (!PREP_BUILD && getSessionState().epoch !== session.epoch) return
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      setComposerOpen(false)
      setDraft('')
      navigate('/agent/' + conversationId)
    },
  })

  const renameConv = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      learningApi.renameConversation(input),
    onError: () => showToast('会话操作未确认，请重新读取后重试。'),
    onSuccess: () => { if (PREP_BUILD || getSessionState().epoch === session.epoch) void queryClient.invalidateQueries({ queryKey: ['conversations'] }) },
  })

  const deleteConv = useMutation({
    mutationFn: (conversationId: string) => learningApi.deleteConversation({ conversationId }),
    onError: () => showToast('会话操作未确认，请重新读取后重试。'),
    onSuccess: (_data, conversationId) => {
      if (!PREP_BUILD && getSessionState().epoch !== session.epoch) return
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.removeQueries({ queryKey: ['conversation', conversationId] })
      // 删的是正在看的会话：回到空状态新会话
      if (conversationId === activeConv) navigate('/agent')
    },
  })

  const pinConv = useMutation({
    mutationFn: (input: { conversationId: string; pinned: boolean }) =>
      learningApi.pinConversation(input),
    onError: () => showToast('会话操作未确认，请重新读取后重试。'),
    onSuccess: () => { if (PREP_BUILD || getSessionState().epoch === session.epoch) void queryClient.invalidateQueries({ queryKey: ['conversations'] }) },
  })

  const archiveConv = useMutation({
    mutationFn: (conversationId: string) =>
      learningApi.archiveConversation({ conversationId }),
    onError: () => showToast('会话操作未确认，请重新读取后重试。'),
    onSuccess: (_data, conversationId) => {
      if (!PREP_BUILD && getSessionState().epoch !== session.epoch) return
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      // 归档的是正在看的会话：回到空状态新会话（「已归档」的查看入口待定，见 docs/agent-page-design.md）
      if (conversationId === activeConv) navigate('/agent')
      showToast('会话已归档')
    },
  })

  const restoreConv = useMutation({
    mutationFn: (conversationId: string) =>
      learningApi.restoreConversation({ conversationId }),
    onError: () => showToast('会话操作未确认，请重新读取后重试。'),
    onSuccess: () => {
      if (!PREP_BUILD && getSessionState().epoch !== session.epoch) return
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      showToast('已恢复到对话列表')
    },
  })

  // 主卡内部滚动（外壳固定 100vh）：PUSH 进新页面回到顶部；POP（返回键/浏览器后退）恢复离开前的滚动位置。
  // 位置必须在滚动时实时记录——路由切换后再读，scrollTop 已被新内容钳到 0
  const navType = useNavigationType()
  const scrollPos = useRef(new Map<string, number>())
  const prevPath = useRef(location.pathname)
  prevPath.current = location.pathname
  useEffect(() => {
    const main = mainRef.current
    if (!main) return
    const onScroll = () => scrollPos.current.set(prevPath.current, main.scrollTop)
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const main = mainRef.current
    if (navType === 'POP') {
      const y = scrollPos.current.get(location.pathname)
      if (y != null && main) {
        main.scrollTo(0, y)
        // 内容高度可能晚一帧才撑开，补一次
        requestAnimationFrame(() => main.scrollTo(0, y))
      }
      return
    }
    main?.scrollTo(0, 0)
  }, [location.pathname, navType])

  // 页面入场（2026-10-11）：按 location.key 重挂载，使「同一路径再次进入」也播一次；
  // 每个路径只在自己首次进入时播——回退、在已访问页面之间来回都不重播（入场是「新页面出现」的反馈，
  // 不是每次路由动作的装饰）。判定用 key + 已访问集合，不依赖 navType：
  // 「A→B→后退到 A」与「A→B→再点导航到 A」的 navType 都是 POP/PUSH，但后者期望播。
  const enteredRef = useRef(new Set<string>())
  const enterKey = useMemo(() => {
    const first = !enteredRef.current.has(location.pathname)
    enteredRef.current.add(location.pathname)
    return first
  }, [location.key, location.pathname])

  // 重挂载的键要跳过 REPLACE（2026-10-12）：REPLACE 不是「出现了一屏新页面」，
  // 是这一页被补上地址。最典型的是新会话发出首条消息——/agent → /agent/<新id>，
  // 若跟着 location.key 重挂载，首条回复落定的那一刻整页重建、入场重播、消息节点全部重来，
  // 就是「卡片出现时页面抽一下」最响的那一声。
  const enterMountRef = useRef(location.key)
  if (navType !== 'REPLACE') enterMountRef.current = location.key
  const enterMountKey = enterMountRef.current

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        if (onHome) setComposerOpen((open) => !open)
        return
      }
      if (e.key === 'Escape') {
        setComposerOpen(false)
        setRailPanel(null)
        setAccountMenu(false)
        closeConvMenu()
        setConvConfirming(null)
        setArchiveOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onHome, closeConvMenu])

  // 外观菜单：点击菜单外任意处收起；关闭后焦点回到触发按钮（键盘用户可继续操作）
  useEffect(() => {
    if (!themeMenu) return
    function onPointerDown(e: MouseEvent) {
      if (themeWrapRef.current?.contains(e.target as Node)) return
      setThemeMenu(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [themeMenu])

  // 账号菜单：点击菜单外任意处收起（展开态胶囊与收起态轨道头像两处挂点都算「内」）
  useEffect(() => {
    if (!accountMenu) return
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node
      if (accountRef.current?.contains(t) || railAccountRef.current?.contains(t)) return
      setAccountMenu(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [accountMenu])

  // 展开侧栏时收起轨道面板（账号菜单换锚点，一并收起）；经「搜索」打开面板时聚焦搜索框
  useEffect(() => {
    if (!sidebarCollapsed) setRailPanel(null)
    setAccountMenu(false)
    setThemeMenu(false)
  }, [sidebarCollapsed])
  useEffect(() => {
    if (railPanel === 'search') panelSearchRef.current?.focus()
  }, [railPanel])

  function showToast(text: string) {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  const summaries = conversations.data ?? []
  const searching = !!convSearch.trim()
  const convQuery = convSearch.trim().toLowerCase()
  // 搜索跨两组命中（含归档）；不搜索时主列表只看未归档的，归档的留给归档箱
  const filtered = searching
    ? summaries.filter((s) => s.title.toLowerCase().includes(convQuery))
    : summaries.filter((s) => !s.archived)
  const archivedConvs = summaries.filter((s) => s.archived)
  // 搜索命中的归档行：不跟主列表混排，落到时间分组之后的「已归档」标签下
  const archivedHits = searching ? filtered.filter((s) => s.archived) : []
  // 置顶会话常驻顶部「置顶」分栏：不进时间分组、也不被滚动分页截掉（2026-10-11）
  const pinnedConvs = filtered.filter((s) => !s.archived && s.pinned)
  const restConvs = filtered.filter((s) => !s.archived && !s.pinned)
  // 搜索时不受分页限制，直接呈现全部匹配
  const visibleConvs = searching ? restConvs : restConvs.slice(0, convShown)
  const archVisible = archivedConvs.slice(0, archShown)
  const convGroups = groupByTime(visibleConvs, new Date())
  // 滚动哨兵复核的两个时刻：换分栏状态那一下（布局在动）与收放动画收尾那一下（最终版面）
  const convFoldSignal = foldedGroups.join('|') + '@' + (foldingGroup ?? '')

  // 归档箱空了（箱内最后一条被恢复）就自动退回主列表，不留一个空箱子
  useEffect(() => {
    if (archiveOpen && archivedConvs.length === 0) setArchiveOpen(false)
  }, [archiveOpen, archivedConvs.length])

  // 会话行 ⋯ 菜单：点击菜单外任意处收起
  useEffect(() => {
    if (!menuId) return
    function onPointerDown(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('.agent-conv-row')) return
      closeConvMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuId, closeConvMenu])

  // 轨道面板关闭时收掉行内管理态
  useEffect(() => {
    if (!railPanel) {
      closeConvMenu()
      setConvConfirming(null)
    }
  }, [railPanel, closeConvMenu])

  /**
   * 弹出 ⋯ 菜单：按 ⋯ 所在行到滚动容器底边的余量决定朝下还是朝上翻，
   * 免得贴底那几行的菜单被裁掉。
   */
  function openConvMenu(id: string, more: HTMLElement) {
    window.clearTimeout(menuCloseTimer.current)
    const row = more.closest('.agent-conv-row') as HTMLElement | null
    const box = row?.getBoundingClientRect()
    const scroller = row?.closest('.side-nav, .railpanel .agent-groups') as HTMLElement | null
    const limit = scroller?.getBoundingClientRect().bottom ?? window.innerHeight
    setConvMenu({ id, up: !!box && limit - box.bottom < MENU_H + 10, closing: false })
  }

  const loadMoreConvs = useCallback(() => setConvShown((n) => n + CONV_PAGE), [])

  /** 行内重命名提交：空标题或与原标题相同则不请求；Enter 提交后 blur 再到时已退出编辑态，跳过。 */
  const commitRename = (id: string, title: string) => {
    if (convRenaming !== id) return
    setConvRenaming(null)
    const trimmed = title.trim()
    if (trimmed && trimmed !== summaries.find((s) => s.id === id)?.title) {
      renameConv.mutate({ conversationId: id, title: trimmed })
    }
  }

  /** 单条会话行：普通态 / 重命名行内输入 / 删除就地二次确认（2026-10-10 确认的形态） */
  const convRow = (s: ConversationSummary, onPick: () => void) => {
    if (convConfirming === s.id) {
      return (
        <div key={s.id} className="agent-conv-confirm">
          <span>删除这条对话？</span>
          <button
            className="danger"
            onClick={() => {
              setConvConfirming(null)
              deleteConv.mutate(s.id)
            }}
          >
            删除
          </button>
          <button onClick={() => setConvConfirming(null)}>取消</button>
        </div>
      )
    }
    if (convRenaming === s.id) {
      return (
        <div key={s.id} className="agent-conv-row renaming">
          <input
            className="agent-conv-rename"
            defaultValue={s.title}
            aria-label="重命名对话"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(s.id, e.currentTarget.value)
              if (e.key === 'Escape') setConvRenaming(null)
            }}
            onBlur={(e) => commitRename(s.id, e.currentTarget.value)}
          />
        </div>
      )
    }
    const open = menuId === s.id
    return (
      <div
        key={s.id}
        className={
          'agent-conv-row' +
          (s.id === activeConv ? ' active' : '') +
          (open ? ' menu-open' : '')
        }
      >
        <button
          className={s.id === activeConv ? 'agent-conv active' : 'agent-conv'}
          onClick={() => {
            navigate('/agent/' + s.id)
            onPick()
          }}
        >
          {s.title}
        </button>
        <button
          className="agent-conv-more"
          aria-label="更多操作"
          title="更多操作"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            if (open) closeConvMenu()
            else openConvMenu(s.id, e.currentTarget)
          }}
        >
          <Icon name="menu-dots" size={14} />
        </button>
        <button
          className={'agent-conv-pin' + (s.pinned ? ' on' : '')}
          aria-label={s.pinned ? '取消置顶' : '置顶'}
          title={s.pinned ? '取消置顶' : '置顶'}
          aria-pressed={s.pinned}
          onClick={(e) => {
            e.stopPropagation()
            pinConv.mutate({ conversationId: s.id, pinned: !s.pinned })
          }}
        >
          <Icon name="pin" size={14} variant={s.pinned ? 'bold' : 'linear'} />
        </button>
        {/* 行操作菜单：重命名 / 归档 / 删除。只在开着（或正在收束）时挂载，
            挂载即播「自 ⋯ 里长出来」的入场，关为收束回三点后再卸载 */}
        {menuId === s.id && (
          <div
            className={
              'agent-conv-menu' +
              (convMenu.up ? ' up' : '') +
              (convMenu.closing ? ' closing' : '')
            }
            role="menu"
            aria-label="会话操作"
          >
            <button
              role="menuitem"
              onClick={() => {
                closeConvMenu()
                setConvRenaming(s.id)
              }}
            >
              <Icon name="pen" size={14} />
              <span className="cm-label">重命名</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                closeConvMenu()
                archiveConv.mutate(s.id)
              }}
            >
              <Icon name="archive" size={14} />
              <span className="cm-label">归档</span>
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                closeConvMenu()
                setConvConfirming(s.id)
              }}
            >
              <Icon name="trash-bin-trash" size={14} />
              <span className="cm-label">删除</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  /** 收 / 展一栏：换收起态，并让这一栏在动画期（FOLD_MS）保持裁剪。
      展开时行立刻就位、随行高一起长出来；收起时空一行高再卸载（卸载早了没动画可看） */
  const toggleGroupFold = (label: string) => {
    setFoldedGroups((f) => (f.includes(label) ? f.filter((x) => x !== label) : [...f, label]))
    setFoldingGroup(label)
    window.clearTimeout(foldTimer.current)
    foldTimer.current = window.setTimeout(() => setFoldingGroup(null), FOLD_MS)
  }

  /** 会话分栏（2026-10-11）：可收起的（置顶 / 更早）标签行是按钮，收起后补一行数；
      行装在 .agent-group-body 里收放（grid 行高动画，见 app.css），收起态不渲染——不占版面，
      也不留在 Tab 序与无障碍树里（收合途中先 inert，动画播完才卸载） */
  const convGroup = (label: string, items: ConversationSummary[], onPick: () => void) => {
    const foldable = FOLDABLE_GROUPS.has(label)
    const folded = foldable && foldedGroups.includes(label)
    const folding = foldingGroup === label
    return (
      <div key={label} className="agent-group">
        {foldable ? (
          <button
            className={'agent-group-label foldable' + (folded ? ' folded' : '')}
            aria-expanded={!folded}
            onClick={() => toggleGroupFold(label)}
          >
            {label}
            {folded && <span className="count">{items.length}</span>}
            <Icon className="gl-chev" name="alt-arrow-down" size={12} />
          </button>
        ) : (
          <div className="agent-group-label">{label}</div>
        )}
        {/* 收起途中（folded 且还在动画里）行留在 DOM 里让 body 裁着收，动画一停就卸载 */}
        <div
          className={'agent-group-body' + (folded ? ' folded' : '') + (folding ? ' folding' : '')}
        >
          <div className="agent-group-inner" inert={folded ? true : undefined}>
            {(!folded || folding) && items.map((s) => convRow(s, onPick))}
          </div>
        </div>
      </div>
    )
  }

  /** 归档箱开合：顺手收掉行内管理态与 ⋯ 菜单，开箱时把箱内分页游标拨回第一页 */
  const openArchive = (open: boolean) => {
    closeConvMenu()
    setConvConfirming(null)
    setArchiveOpen(open)
    if (open) setArchShown(CONV_PAGE)
  }

  /** 归档行（2026-10-11 定稿）：标题是 span 不是按钮——先恢复再继续聊，不在归档态里发言；
      箱内与搜索命中共用这一行，尾部「恢复」常显（这行没有别的动作可挂） */
  const archivedRow = (s: ConversationSummary) => (
    <div key={s.id} className="agent-conv-row archived">
      <span className="agent-conv" title={s.title}>
        {s.title}
      </span>
      <button
        className="agent-conv-restore"
        onClick={() => restoreConv.mutate(s.id)}
        aria-label={`恢复「${s.title}」`}
      >
        恢复
      </button>
    </div>
  )

  /** 对话历史内容：侧栏展开区与收起态轨道悬浮面板共用；onPick 用于面板内导航后收起面板 */
  const convPane = (inputRef: RefObject<HTMLInputElement | null> | undefined, onPick: () => void) => (
    <>
      <button
        className="agent-newchat"
        onClick={() => {
          navigate('/agent')
          onPick()
        }}
      >
        <span className="navicon">
          <Icon name="pen-new-square" size={14} />
        </span>
        新对话
      </button>
      {/* 归档入口：挨着新对话放，开箱 / 收箱时这一行不动（消失在它下面的只是搜索框），
          有归档才露面；箱内变成返回（左箭头 + 点亮） */}
      {(archivedConvs.length > 0 || archiveOpen) && (
        <button
          className={'agent-archive-entry' + (archiveOpen ? ' on' : '')}
          onClick={() => openArchive(!archiveOpen)}
          aria-expanded={archiveOpen}
          aria-label={archiveOpen ? '返回对话列表' : `已归档 ${archivedConvs.length} 个对话`}
        >
          <Icon name={archiveOpen ? 'alt-arrow-left' : 'archive'} size={14} />
          已归档
          <span className="count">{archivedConvs.length}</span>
        </button>
      )}
      {archiveOpen ? (
        <PaneSwap className="agent-groups">
          {/* 归档行得裹一层 .agent-group 才拿到普通行距（2px）：直接挂在 .agent-groups 下会吃分栏间距（16px），
              看着一行一组 */}
          <div className="agent-group">
            {archVisible.map(archivedRow)}
          </div>
          {archivedConvs.length > archShown && (
            <ConvSentinel onShow={() => setArchShown((n) => n + CONV_PAGE)} />
          )}
        </PaneSwap>
      ) : (
        <>
          <div className="agent-search">
            <Icon name="minimalistic-magnifier" size={14} />
            <input
              ref={inputRef}
              aria-label="搜索对话"
              placeholder="搜索对话…"
              value={convSearch}
              onChange={(e) => {
                setConvSearch(e.target.value)
                setConvShown(CONV_PAGE)
              }}
            />
          </div>
          <PaneSwap className="agent-groups">
            {pinnedConvs.length > 0 || convGroups.length > 0 || archivedHits.length > 0 ? (
              <>
                {pinnedConvs.length > 0 && convGroup('置顶', pinnedConvs, onPick)}
                {convGroups.map((g) => convGroup(g.label, g.items, onPick))}
                {/* 搜索命中的归档：落在时间分组之后的「已归档」标签下，与主列表行同形但标灰 */}
                {archivedHits.length > 0 && (
                  <div className="agent-group">
                    <div className="agent-group-label">已归档</div>
                    {archivedHits.map(archivedRow)}
                  </div>
                )}
              </>
            ) : searching ? (
              <div className="agent-side-empty">
                没有匹配「{convSearch.trim()}」的对话
                <button className="agent-side-clear" onClick={() => setConvSearch('')}>
                  清除搜索
                </button>
              </div>
            ) : (
              <div className="agent-side-empty">开始提问后，对话会留在这里</div>
            )}
            {!searching && restConvs.length > convShown && (
              <ConvSentinel onShow={loadMoreConvs} signal={convFoldSignal} />
            )}
          </PaneSwap>
        </>
      )}
    </>
  )

  /** 账号菜单两处挂点（展开态胶囊 / 收起态轨道头像）共用同一组动作 */
  const accountActions = {
    onProfile: () => {
      setAccountMenu(false)
      setProfileOpen(true)
    },
    onSettings: () => {
      setAccountMenu(false)
      navigate('/settings')
    },
    onLogout: () => {
      setAccountMenu(false)
      if (PREP_BUILD) showToast('准备场景请从工作区退出合成会话')
      else void logoutSession()
    },
  }

  return (
    <div
      className={
        'shell' + (inWorkspace ? ' immersive' : '') + (sidebarCollapsed ? ' collapsed' : '')
      }
    >
      <aside className="sidebar">
        <div className="brand xunjie-brand">
          <XunjieLogo format="horizontal" label="循阶" />
        </div>
        <nav className="side-nav">
          <button className={onHome ? 'sidebtn active' : 'sidebtn'} onClick={() => navigate('/')}>
            <span className="navicon"><Icon name="home-2" size={20} variant={onHome ? 'bold' : 'linear'} /></span>首页
          </button>
          <div className="sideitem">
            <button
              className={onAgent ? 'sidebtn active' : 'sidebtn'}
              onClick={() => navigate('/agent')}
              aria-expanded={onAgent}
            >
              <span className="navicon"><Icon name="chat-round-dots" size={20} variant={onAgent ? 'bold' : 'linear'} /></span>Agent 对话
            </button>
          </div>
          <div className={onAgent ? 'agent-sub open' : 'agent-sub'}>
            <div className="agent-sub-inner">{convPane(undefined, () => {})}</div>
          </div>
        </nav>
        <div className="side-bottom">
          <div className="account-wrap" ref={accountRef}>
            <button
              className={'account-pill' + (accountMenu ? ' open' : '')}
              title={!PREP_BUILD && session.session ? '课程账号 · 学习空间' : '学生 · 本地学习空间'}
              aria-haspopup="menu"
              aria-expanded={accountMenu}
              onClick={() => {
                setAccountMenu((o) => !o)
                setThemeMenu(false) // 两枚菜单不同时开着
              }}
            >
              <AccountAvatar />
              <span className="account-name">{!PREP_BUILD && session.session ? session.session.userId : account.name}</span>
              <Icon name="sort-vertical" size={14} className="account-chev" />
            </button>
            <AccountMenu
              open={accountMenu && !sidebarCollapsed}
              anchor="pill"
              {...accountActions}
            />
          </div>
          <button
            className={'side-icon' + (onSettings ? ' active' : '')}
            data-tip="设置与帮助"
            aria-label="设置与帮助"
            onClick={() => navigate('/settings')}
          >
            <Icon name="settings" size={16} />
          </button>
          <div className="theme-wrap" ref={themeWrapRef}>
            <button
              ref={themeBtnRef}
              className={'side-icon' + (themeMenu ? ' active' : '')}
              data-tip={themeTip}
              aria-label={themeTip}
              aria-haspopup="menu"
              aria-expanded={themeMenu}
              onClick={() => {
                setThemeMenu((o) => !o)
                setAccountMenu(false)
              }}
            >
              <Icon name={themeResolved === 'light' ? 'sun' : 'moon'} size={16} variant="linear" tone="neutral" />
            </button>
            <ThemeMenu
              open={themeMenu}
              onClose={() => {
                setThemeMenu(false)
                themeBtnRef.current?.focus()
              }}
            />
          </div>
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        <div
          className={'page-enter' + (enterKey ? '' : ' revisit')}
          key={enterMountKey}
        >
          <Outlet />
        </div>
      </main>
      {!inWorkspace && (
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((c) => !c)}
          aria-label="切换边栏"
          aria-expanded={!sidebarCollapsed}
          title="切换边栏"
        >
          <Icon name="panel-left-close" size={18} />
        </button>
      )}
      {/* 收起态左侧轨道：图标与展开态各行同坐标（2026-10-11 加「已归档」，位置跟着展开区走），
          淡入与侧栏淡出同位对接 */}
      <div className={'rail' + (railVisible ? ' on' : '')}>
        <button
          className={'railbtn r-home' + (onHome ? ' active' : '')}
          onClick={() => {
            navigate('/')
            setRailPanel(null)
          }}
          title="首页"
          aria-label="首页"
        >
          <Icon name="home-2" size={20} variant={onHome ? 'bold' : 'linear'} />
        </button>
        <button
          className={'railbtn r-agent' + (onAgent ? ' active' : '')}
          onClick={() => {
            if (onAgent) setRailPanel((p) => (p ? null : 'history'))
            else {
              // 非 Agent 页点 ✧ 直接开新会话（2026-10-01 用户确认）
              navigate('/agent')
              setRailPanel(null)
            }
          }}
          title="Agent 对话"
          aria-label="Agent 对话"
          aria-expanded={onAgent ? railPanel !== null : undefined}
        >
          <Icon name="chat-round-dots" size={20} variant={onAgent ? 'bold' : 'linear'} />
        </button>
        <button
          className={'railbtn r-new' + (onAgent ? '' : ' off')}
          onClick={() => {
            navigate('/agent')
            setRailPanel(null)
          }}
          title="新对话"
          aria-label="新对话"
          aria-hidden={onAgent ? undefined : true}
          tabIndex={onAgent ? undefined : -1}
        >
          <Icon name="pen-new-square" size={14} />
        </button>
        {/* 开搜索前先收归档箱：搜索框在箱内是让位的，不收掉这一点完没处聚焦 */}
        <button
          className={
            'railbtn r-archive' +
            (onAgent && archivedConvs.length > 0 ? '' : ' off') +
            (archiveOpen && railPanel === 'history' ? ' active' : '')
          }
          onClick={() => {
            // 与展开态入口行同一档：箱子开着就收（连面板一起收），收起就开箱并顶出面板
            const next = !(archiveOpen && railPanel === 'history')
            openArchive(next)
            setRailPanel(next ? 'history' : null)
          }}
          title="已归档"
          aria-label="已归档"
          aria-expanded={onAgent && archiveOpen && railPanel === 'history'}
          aria-hidden={onAgent && archivedConvs.length > 0 ? undefined : true}
          tabIndex={onAgent && archivedConvs.length > 0 ? undefined : -1}
        >
          <Icon name="archive" size={14} />
        </button>
        <button
          className={'railbtn r-search' + (onAgent ? '' : ' off')}
          onClick={() => {
            setArchiveOpen(false)
            setRailPanel((p) => (p === 'search' ? null : 'search'))
          }}
          title="搜索对话"
          aria-label="搜索对话"
          aria-hidden={onAgent ? undefined : true}
          tabIndex={onAgent ? undefined : -1}
        >
          <Icon name="minimalistic-magnifier" size={14} />
        </button>
        {/* 轨道底部的账户头像（2026-10-10）：与展开态账号胶囊的头像同坐标，点击弹出账号菜单 */}
        <div className="rail-account" ref={railAccountRef}>
          <button
            className={'railbtn r-account' + (accountMenu ? ' open' : '')}
            onClick={() => setAccountMenu((o) => !o)}
            title="账户"
            aria-label="账户菜单"
            aria-haspopup="menu"
            aria-expanded={accountMenu && railVisible}
          >
            <AccountAvatar />
          </button>
          <AccountMenu open={accountMenu && railVisible} anchor="rail" {...accountActions} />
        </div>
      </div>
      {railVisible && railPanel && <div className="railshade" onClick={() => setRailPanel(null)} />}
      <div className={'railpanel' + (railVisible && railPanel ? ' on' : '')}>
        {convPane(panelSearchRef, () => setRailPanel(null))}
      </div>
      {onHome && (
        <>
          <CompanionButton
            className="mascot"
            attention={composerOpen}
            working={sendFromHome.isPending}
            ambient
            onClick={() => setComposerOpen((open) => !open)}
            aria-label="唤起 Agent 输入框"
            aria-expanded={composerOpen}
            title="唤起 Agent · ⌘ / Ctrl + J"
          />
          {/* 入口气泡与输入气泡是同一个盒子：点它或点 IP 都原地长开（几何见 app.css .ask 一段） */}
          <Composer
            open={composerOpen}
            value={draft}
            onChange={setDraft}
            onSend={(text) => sendFromHome.mutate(text)}
            onOpen={() => setComposerOpen(true)}
            onClose={() => setComposerOpen(false)}
          />
        </>
      )}
      <ProfileCard open={profileOpen} onClose={() => setProfileOpen(false)} onAction={showToast} />
      {conversations.error && <div className="toast" role="alert">会话列表读取失败，请刷新后重试。</div>}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
