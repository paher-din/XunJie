import { ConversationPane, HomeAssistant, RailHistoryPanel, SidebarBottom, SidebarNavigation, SidebarRail, SidebarToggle, Toast } from '@xunjie/ui/foundation'

export { ConversationPaneSwap as PaneSwap, ConversationSentinel as ConvSentinel } from '@xunjie/ui/foundation'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { learningApi } from '../bridge/agentApi'
import type { ConversationSummary } from '../bridge/types'
import { ProfileCard } from './ProfileCard'
import { ShellFrame, useShellNavigation } from './ShellFrame'
import { useAccount } from '../lib/account'
import { THEME_OPTIONS, setThemePreference, useTheme } from '../lib/theme'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'
import { useModelSettings } from '../lib/modelSettings'
import { getSessionState } from '../workspace/session'
import { logoutSession } from '../workspace/session'
import { displayAccountName } from '../lib/displayNames'
import { HomeNavigationProvider } from '../lib/homeCourseNavigation'

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
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useShellNavigation()
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
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
  const railTriggerRef = useRef<HTMLButtonElement | null>(null)
  const railPanelRef = useRef<HTMLDivElement>(null)
  const closeRailPanel = useCallback(() => {
    const trigger = railTriggerRef.current
    if (trigger?.isConnected && !trigger.closest('[inert]') && trigger.getAttribute('aria-hidden') !== 'true') {
      trigger.focus({ preventScroll: true })
    }
    setRailPanel(null)
  }, [])
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
  const homeHandoff = useRef(false)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const mainRef = useRef<HTMLElement>(null)
  const panelSearchRef = useRef<HTMLInputElement>(null)
  // 轨道与悬浮面板只在侧栏收起且非工作区沉浸态时生效
  const railVisible = sidebarCollapsed && !inWorkspace
  const railPanelVisible = railVisible && onAgent && railPanel !== null

  // Moving focus out of a just-hidden navigation region prevents an invisible Tab stop.
  useLayoutEffect(() => {
    if (document.activeElement?.closest('[inert]')) {
      const target = inWorkspace ? mainRef.current?.querySelector<HTMLElement>('button') : sidebarToggleRef.current
      target?.focus({ preventScroll: true })
    }
  }, [sidebarCollapsed, inWorkspace, onAgent, railPanelVisible])

  // 侧栏要连归档一起取（归档箱与搜索跨两组命中都要用），与 AgentPage 的「首次使用」判定分开一条缓存
  const conversations = useQuery({
    queryKey: ['conversations', 'with-archived'],
    queryFn: () => learningApi.listConversations({ includeArchived: true }),
  })

  // 首页只交接一次提问；回合从 Agent 页发起、展示与恢复，页面渐入不等模型完成。
  useEffect(() => { if (onHome) homeHandoff.current = false }, [onHome])
  const sendFromHome = (text: string) => {
    if (homeHandoff.current) return
    homeHandoff.current = true
    setComposerOpen(false)
    setDraft('')
    navigate('/agent', { state: { homeQuestion: text, homeEpoch: session.epoch } })
  }

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
    // Home owns per-history-entry course positioning once its data is ready.
    if (location.pathname === '/') return
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
        if (railPanelVisible) closeRailPanel()
        setAccountMenu(false)
        closeConvMenu()
        setConvConfirming(null)
        setArchiveOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onHome, closeConvMenu, railPanelVisible, closeRailPanel])

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
    if (!onAgent || inWorkspace) setRailPanel(null)
  }, [onAgent, inWorkspace])
  useEffect(() => {
    if (railPanelVisible) {
      const target = archiveOpen ? railPanelRef.current?.querySelector<HTMLElement>('button') : panelSearchRef.current
      target?.focus({ preventScroll: true })
    }
  }, [railPanelVisible, railPanel, archiveOpen])

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

  /** 收 / 展一栏：换收起态，并让这一栏在动画期（FOLD_MS）保持裁剪。
      展开时行立刻就位、随行高一起长出来；收起时空一行高再卸载（卸载早了没动画可看） */
  const toggleGroupFold = (label: string) => {
    setFoldedGroups((f) => (f.includes(label) ? f.filter((x) => x !== label) : [...f, label]))
    setFoldingGroup(label)
    window.clearTimeout(foldTimer.current)
    foldTimer.current = window.setTimeout(() => setFoldingGroup(null), FOLD_MS)
  }

  /** 归档箱开合：顺手收掉行内管理态与 ⋯ 菜单，开箱时把箱内分页游标拨回第一页 */
  const openArchive = (open: boolean) => {
    closeConvMenu()
    setConvConfirming(null)
    setArchiveOpen(open)
    if (open) setArchShown(CONV_PAGE)
  }

  /** 旧会话数据和写操作留在外壳，历史视图由正式组件库提供。 */
  const convPane = (inputRef: RefObject<HTMLInputElement | null> | undefined, onPick: () => void) => (
    <ConversationPane archived={archivedConvs} archivedVisible={archVisible} archivedHits={archivedHits}
      pinned={pinnedConvs} groups={convGroups} archiveOpen={archiveOpen} query={convSearch} searching={searching}
      activeId={activeConv} menu={convMenu} renamingId={convRenaming} confirmingId={convConfirming}
      foldedGroups={foldedGroups} foldingGroup={foldingGroup} foldableGroups={FOLDABLE_GROUPS}
      remaining={restConvs.length > convShown} moreArchived={archivedConvs.length > archShown}
      foldSignal={convFoldSignal} searchRef={inputRef}
      onNew={() => { navigate('/agent'); onPick() }} onOpen={id => { navigate('/agent/' + id); onPick() }}
      onToggleArchive={openArchive} onSearch={query => { setConvSearch(query); setConvShown(CONV_PAGE) }}
      onClearSearch={() => setConvSearch('')}
      onToggleMenu={(id, anchor) => { if (menuId === id) closeConvMenu(); else openConvMenu(id, anchor) }}
      onTogglePin={(id, pinned) => pinConv.mutate({ conversationId: id, pinned })}
      onStartRename={id => { closeConvMenu(); setConvRenaming(id) }}
      onCommitRename={commitRename} onCancelRename={() => setConvRenaming(null)}
      onArchive={id => { closeConvMenu(); archiveConv.mutate(id) }}
      onAskDelete={id => { closeConvMenu(); setConvConfirming(id) }}
      onConfirmDelete={id => { setConvConfirming(null); deleteConv.mutate(id) }}
      onCancelDelete={() => setConvConfirming(null)} onRestore={id => restoreConv.mutate(id)}
      onToggleGroup={toggleGroupFold} onLoadMore={loadMoreConvs} onLoadMoreArchived={() => setArchShown(n => n + CONV_PAGE)} />
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

  const isCourseAccount = !PREP_BUILD && !!session.session
  const shellAccount = {
    name: isCourseAccount && session.session ? displayAccountName(session.session.userId, session.session.displayName) : account.name,
    avatar: isCourseAccount ? null : account.avatar,
    subtitle: isCourseAccount ? '课程账号 · 学习空间' : '学生 · 本地学习空间',
  }

  return (
    <ShellFrame
      collapsed={sidebarCollapsed}
      immersive={inWorkspace}
      mainRef={mainRef}
      navigation={<SidebarNavigation onHome={onHome} onAgent={onAgent} history={convPane(undefined, () => {})}
        openHome={() => navigate('/')} openAgent={() => navigate('/agent')} />}
      bottom={<SidebarBottom account={shellAccount} accountOpen={accountMenu} collapsed={sidebarCollapsed}
        settingsActive={onSettings} themeOpen={themeMenu} themePreference={themePreference} themeResolved={themeResolved}
        themeTip={themeTip} accountRef={accountRef} themeWrapRef={themeWrapRef} themeButtonRef={themeBtnRef}
        onToggleAccount={() => { setAccountMenu(value => !value); setThemeMenu(false) }}
        onOpenSettings={() => navigate('/settings')}
        onToggleTheme={() => { setThemeMenu(value => !value); setAccountMenu(false) }}
        onThemeChange={setThemePreference} onThemeClose={() => { setThemeMenu(false); themeBtnRef.current?.focus() }}
        accountActions={accountActions} />}
      toggle={<SidebarToggle collapsed={sidebarCollapsed} buttonRef={sidebarToggleRef} onToggle={toggleSidebar} />}
      rail={<SidebarRail onHome={onHome} onAgent={onAgent} panel={railPanel} archivedCount={archivedConvs.length}
        archiveOpen={archiveOpen} account={shellAccount} accountOpen={accountMenu} railVisible={railVisible}
        accountRef={railAccountRef} accountActions={accountActions}
        openHome={() => { navigate('/'); setRailPanel(null) }}
        openAgent={anchor => {
          if (onAgent) {
            if (railPanel) closeRailPanel()
            else { railTriggerRef.current = anchor; setRailPanel('history') }
          } else { navigate('/agent'); setRailPanel(null) }
        }}
        newConversation={() => { navigate('/agent'); setRailPanel(null) }}
        toggleArchive={anchor => {
          const next = !(archiveOpen && railPanel === 'history')
          railTriggerRef.current = anchor
          openArchive(next)
          if (next) setRailPanel('history')
          else closeRailPanel()
        }}
        toggleSearch={anchor => {
          setArchiveOpen(false)
          if (railPanel === 'search') closeRailPanel()
          else { railTriggerRef.current = anchor; setRailPanel('search') }
        }}
        toggleAccount={() => setAccountMenu(value => !value)} />}
      overlays={<>
        <RailHistoryPanel visible={railPanelVisible} panelRef={railPanelRef} onClose={closeRailPanel}>
          {convPane(panelSearchRef, closeRailPanel)}
        </RailHistoryPanel>
        {onHome && <HomeAssistant open={composerOpen} value={draft} onChange={setDraft} onSend={sendFromHome}
          onToggle={() => setComposerOpen(open => !open)} onOpen={() => setComposerOpen(true)} onClose={() => setComposerOpen(false)} />}
        <ProfileCard open={profileOpen} onClose={() => setProfileOpen(false)} onAction={showToast} />
        {conversations.error && <Toast role="alert">会话列表读取失败，请刷新后重试。</Toast>}
        {toast && <Toast>{toast}</Toast>}
      </>}
    >
      <HomeNavigationProvider scope={`${session.epoch}:${session.session?.userId ?? 'prep'}`}>
        <div
          className={'page-enter' + (enterKey ? '' : ' revisit')}
          key={onHome ? 'home' : enterMountKey}
        >
          <Outlet />
        </div>
      </HomeNavigationProvider>
    </ShellFrame>
  )
}
