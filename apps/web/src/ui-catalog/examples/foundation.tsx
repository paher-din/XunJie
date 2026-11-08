import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AccountAvatar, AccountMenu, ArchivedConversationRow, Button, Composer, ContextRing,
  ConversationGroup, ConversationPane, ConversationPaneSwap, ConversationRow, ConversationSentinel,
  FluidHighlight, HomeAssistant, ProfileCard, ProgressBar, RailHistoryPanel, SessionLogin, ShellFrame,
  SidebarBottom, SidebarNavigation, SidebarRail, SidebarToggle, StatusChip, SuggestionStack, ThemeMenu, Toast,
  type ConversationItem, type EntryRole, type ThemePreference,
} from '@xunjie/ui/foundation'
import { Icon, IconText } from '@xunjie/ui/icons'
import avatarImage from '@xunjie/ui/assets/brand/xunjie-logo/favicon-32.png'
import type { CatalogEntry } from '../types'

function ButtonVariants() {
  const [count, setCount] = useState(0)
  return <div className="demo-stack"><div className="demo-row">
    <Button type="button" onClick={() => setCount(count + 1)}>主要操作</Button>
    <Button type="button" variant="outline" onClick={() => setCount(count + 1)}>次要操作</Button>
  </div><output>已点击 {count} 次</output></div>
}
function DisabledButtons() {
  return <div className="demo-row"><Button type="button" disabled>主要操作</Button><Button type="button" variant="outline" disabled>次要操作</Button></div>
}
function Avatars() {
  return <div className="demo-row demo-avatar-row">{['林同学', '陈同学', '李同学', '王同学'].map(name => <div key={name}><AccountAvatar name={name} /><span>{name}</span></div>)}</div>
}
function AvatarImage() {
  return <div className="demo-row"><AccountAvatar name="示例" avatar={avatarImage} /><span>使用本地资源的示例头像</span></div>
}
function AccountMenuDemo({ anchor }: { anchor: 'pill' | 'rail' }) {
  const [open, setOpen] = useState(true)
  const [action, setAction] = useState('')
  const choose = (label: string) => { setAction(label); setOpen(false) }
  return <div className="demo-account">
    <div className="demo-account-anchor">
      <AccountMenu open={open} anchor={anchor} name="林同学" subtitle="示例学习空间"
        avatar={<AccountAvatar name="林同学" />} onProfile={() => choose('个人资料')}
        onSettings={() => choose('设置')} onLogout={() => choose('退出登录')} />
      <Button type="button" variant="outline" onClick={() => setOpen(!open)}>{open ? '关闭菜单' : '打开菜单'}</Button>
    </div>
    <output>{action && `已选择：${action}`}</output>
  </div>
}
function AccountPill() { return <AccountMenuDemo anchor="pill" /> }
function AccountRail() { return <AccountMenuDemo anchor="rail" /> }
function ThemeMenuDemo({ initialPreference }: { initialPreference: ThemePreference }) {
  const [open, setOpen] = useState(true)
  const [preference, setPreference] = useState(initialPreference)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => { setOpen(false); trigger.current?.focus() }, [])
  useEffect(() => {
    const root = document.documentElement
    const before = root.dataset.theme
    const colorScheme = root.style.colorScheme
    return () => {
      if (before === undefined) delete root.dataset.theme
      else root.dataset.theme = before
      root.style.colorScheme = colorScheme
    }
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }
    apply()
    if (preference === 'system') media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference])
  return <div className="demo-account"><div className="demo-theme-anchor">
    <ThemeMenu open={open} preference={preference} onChange={setPreference} onClose={close} />
    <Button ref={trigger} type="button" variant="outline" onClick={() => setOpen(value => !value)}>{open ? '关闭外观菜单' : '打开外观菜单'}</Button>
  </div><output>当前示例偏好：{preference}</output></div>
}
function ThemeLight() { return <ThemeMenuDemo initialPreference="light" /> }
function ThemeDark() { return <ThemeMenuDemo initialPreference="dark" /> }
function ThemeSystem() { return <ThemeMenuDemo initialPreference="system" /> }
function ProfileDemo({ empty = false }: { empty?: boolean }) {
  const [open, setOpen] = useState(true)
  const [action, setAction] = useState('')
  const choose = (value: string) => { setAction(value); setOpen(false) }
  return <div className="demo-stack"><Button type="button" variant="outline" onClick={() => setOpen(true)}>打开示例资料</Button>
    <output>{action && `已触发示例操作：${action}`}</output>
    <ProfileCard open={open} name="示例同学" avatar={<AccountAvatar name="示例同学" />} roleLabel="学生" term="示例学期"
      roleDetails={['示例院系', '示例专业']} identity={[[ '学号', '示例编号' ], [ '院系', '示例院系' ]]}
      accountFacts={[[ '学习空间', '示例空间' ], [ '加入日期', '示例日期' ]]} accountLabel="示例账户"
      portrait={{ updatedAt: '2026-01-01', tags: empty ? [] : ['示例标签', '项目学习'],
        strengths: empty ? [] : ['示例优势'], growths: empty ? [] : ['示例成长方向'], prefs: empty ? [] : ['先演示后实践', '喜欢类比解释'] }}
      records={empty ? [] : [
        { n: '2', unit: '件', label: ['示例项目', '作品'], icon: 'folder-with-files' },
        { n: '1', unit: '条', label: ['示例', '反馈'], icon: 'chat-square-line' },
      ]} onClose={() => setOpen(false)} onLogout={() => choose('退出登录')}
      onAccountSettings={() => choose('账号设置')} onEditProfile={() => choose('编辑资料')} />
  </div>
}
function ProfilePopulated() { return <ProfileDemo /> }
function ProfileEmpty() { return <ProfileDemo empty /> }
function LoginDemo({ initialRole = 'student', initialBusy = false, initialLogoutFailed = false, initialNotice = '' }: {
  initialRole?: EntryRole; initialBusy?: boolean; initialLogoutFailed?: boolean; initialNotice?: string
}) {
  const [role, setRole] = useState<EntryRole>(initialRole)
  const [loginName, setLoginName] = useState(initialRole === 'student' ? 'sample-student' : 'sample-teacher')
  const [password, setPassword] = useState('example-only')
  const [busy, setBusy] = useState(initialBusy)
  const [logoutFailed, setLogoutFailed] = useState(initialLogoutFailed)
  const [notice, setNotice] = useState(initialNotice)
  return <div className="demo-login"><div className="demo-login-controls"><Button type="button" variant="outline" onClick={() => setBusy(value => !value)}>{busy ? '结束示例等待' : '显示示例等待'}</Button></div>
    <SessionLogin entryRole={role} loginName={loginName} password={password} busy={busy} logoutFailed={logoutFailed} notice={notice}
      onRoleChange={setRole} onLoginNameChange={setLoginName} onPasswordChange={setPassword}
      onSubmit={() => setNotice('已触发示例登录；没有连接服务。')}
      onRetryLogout={() => { setLogoutFailed(false); setNotice('已触发示例重试；没有连接服务。') }}
      onRestoreSession={() => setNotice('已触发示例会话读取；没有连接服务。')} />
  </div>
}
function LoginStudent() { return <LoginDemo /> }
function LoginTeacher() { return <LoginDemo initialRole="teacher" /> }
function LoginBusy() { return <LoginDemo initialBusy /> }
function LoginNotice() { return <LoginDemo initialNotice="示例提示：请检查账号和密码。" /> }
function LoginLogoutFailed() { return <LoginDemo initialLogoutFailed initialNotice="示例提示：退出未完成。" /> }

type ConversationMode = 'normal' | 'renaming' | 'confirming'
function ConversationDemo({ initialMode = 'normal', initiallyOpen = false, initiallyPinned = false, initiallyActive = false, menuUp = false }: {
  initialMode?: ConversationMode; initiallyOpen?: boolean; initiallyPinned?: boolean; initiallyActive?: boolean; menuUp?: boolean
}) {
  const [title, setTitle] = useState('如何设计计数器？')
  const [mode, setMode] = useState<ConversationMode>(initialMode)
  const [menuOpen, setMenuOpen] = useState(initiallyOpen)
  const [pinned, setPinned] = useState(initiallyPinned)
  const [active, setActive] = useState(initiallyActive)
  const [message, setMessage] = useState('')
  return <div className="demo-conversation"><ConversationRow title={title} active={active} pinned={pinned} mode={mode} menuOpen={menuOpen} menuUp={menuUp}
    onOpen={() => { setActive(true); setMessage('已打开示例会话') }}
    onToggleMenu={() => setMenuOpen(value => !value)} onTogglePin={() => setPinned(value => !value)}
    onStartRename={() => { setMenuOpen(false); setMode('renaming') }}
    onCommitRename={next => { if (next.trim()) setTitle(next.trim()); setMode('normal') }}
    onCancelRename={() => setMode('normal')} onArchive={() => { setMenuOpen(false); setMessage('已触发示例归档') }}
    onAskDelete={() => { setMenuOpen(false); setMode('confirming') }}
    onConfirmDelete={() => { setMode('normal'); setMessage('已触发示例删除') }} onCancelDelete={() => setMode('normal')} />
    <output>{message}</output></div>
}
function ConversationNormal() { return <ConversationDemo /> }
function ConversationActive() { return <ConversationDemo initiallyPinned initiallyActive /> }
function ConversationMenu() { return <ConversationDemo initiallyOpen /> }
function ConversationMenuUp() { return <ConversationDemo initiallyOpen menuUp /> }
function ConversationRenaming() { return <ConversationDemo initialMode="renaming" /> }
function ConversationConfirming() { return <ConversationDemo initialMode="confirming" /> }
interface DemoConversation extends ConversationItem { archived: boolean; group: '今天' | '近 7 天' }
function ConversationPaneDemo({ empty = false, initiallyArchived = false }: { empty?: boolean; initiallyArchived?: boolean }) {
  const [items, setItems] = useState<DemoConversation[]>(() => empty ? [] : [
    { id: 'example-1', title: '如何设计计数器？', pinned: true, archived: false, group: '今天' },
    { id: 'example-2', title: '状态机有哪些状态？', pinned: false, archived: false, group: '今天' },
    { id: 'example-3', title: '项目如何开始？', pinned: false, archived: false, group: '近 7 天' },
    { id: 'example-4', title: '已归档的示例会话', pinned: false, archived: true, group: '近 7 天' },
  ])
  const [archiveOpen, setArchiveOpen] = useState(initiallyArchived)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuUp, setMenuUp] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [foldedGroups, setFoldedGroups] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const nextId = useRef(0)
  const searching = query.trim().length > 0
  const match = (item: DemoConversation) => item.title.toLowerCase().includes(query.trim().toLowerCase())
  const archived = items.filter(item => item.archived)
  const live = items.filter(item => !item.archived && match(item))
  const pinned = live.filter(item => item.pinned)
  const groups = (['今天', '近 7 天'] as const).map(label => ({ label, items: live.filter(item => !item.pinned && item.group === label) })).filter(group => group.items.length > 0)
  const updateItem = (id: string, update: Partial<DemoConversation>) => setItems(current => current.map(item => item.id === id ? { ...item, ...update } : item))
  const closeMenu = () => setMenuId(null)
  return <div className="demo-pane-wrap"><div className="demo-pane"><ConversationPane
    archived={archived} archivedVisible={archived} archivedHits={searching ? archived.filter(match) : []} pinned={pinned} groups={groups}
    archiveOpen={archiveOpen} query={query} searching={searching} activeId={activeId}
    menu={{ id: menuId, up: menuUp, closing: false }} renamingId={renamingId} confirmingId={confirmingId}
    foldedGroups={foldedGroups} foldingGroup={null} foldableGroups={new Set(['置顶', '近 7 天'])}
    remaining={false} moreArchived={false}
    onNew={() => { const id = `local-${++nextId.current}`; setItems(current => [{ id, title: '新示例对话', pinned: false, archived: false, group: '今天' }, ...current]); setArchiveOpen(false); setQuery(''); setActiveId(id) }}
    onOpen={id => { setActiveId(id); setMessage('已打开示例会话') }}
    onToggleArchive={open => { setArchiveOpen(open); closeMenu(); setRenamingId(null); setConfirmingId(null) }}
    onSearch={setQuery} onClearSearch={() => setQuery('')}
    onToggleMenu={(id, anchor) => { setMenuId(current => current === id ? null : id); setMenuUp(anchor.getBoundingClientRect().bottom + 130 > window.innerHeight) }}
    onTogglePin={(id, pinnedValue) => updateItem(id, { pinned: pinnedValue })}
    onStartRename={id => { closeMenu(); setRenamingId(id) }}
    onCommitRename={(id, title) => { if (title.trim()) updateItem(id, { title: title.trim() }); setRenamingId(null) }}
    onCancelRename={() => setRenamingId(null)} onArchive={id => { closeMenu(); updateItem(id, { archived: true }) }}
    onAskDelete={id => { closeMenu(); setConfirmingId(id) }}
    onConfirmDelete={id => { setItems(current => current.filter(item => item.id !== id)); setConfirmingId(null) }}
    onCancelDelete={() => setConfirmingId(null)} onRestore={id => updateItem(id, { archived: false })}
    onToggleGroup={label => setFoldedGroups(current => current.includes(label) ? current.filter(item => item !== label) : [...current, label])}
    onLoadMore={() => setMessage('示例没有更多会话')} onLoadMoreArchived={() => setMessage('示例没有更多归档')} />
  </div><output>{message}</output></div>
}
function PanePopulated() { return <ConversationPaneDemo /> }
function PaneEmpty() { return <ConversationPaneDemo empty /> }
function PaneArchived() { return <ConversationPaneDemo initiallyArchived /> }
function ArchivedRow() {
  const [restored, setRestored] = useState(false)
  return <div className="demo-conversation"><ArchivedConversationRow title="已经归档的示例会话" onRestore={() => setRestored(true)} /><output>{restored && '已触发示例恢复'}</output></div>
}
function GroupDemo({ initialFolded }: { initialFolded: boolean }) {
  const [folded, setFolded] = useState(initialFolded)
  const [restored, setRestored] = useState('')
  return <div className="demo-conversation agent-groups"><ConversationGroup label="最近" count={2} foldable folded={folded} folding={false} onToggle={() => setFolded(!folded)}>
    <ArchivedConversationRow title="示例会话一" onRestore={() => setRestored('示例会话一')} /><ArchivedConversationRow title="示例会话二" onRestore={() => setRestored('示例会话二')} />
  </ConversationGroup><output>{restored && `已触发恢复：${restored}`}</output></div>
}
function GroupExpanded() { return <GroupDemo initialFolded={false} /> }
function GroupFolded() { return <GroupDemo initialFolded /> }
function SentinelDemo() {
  const [seen, setSeen] = useState(false)
  const onShow = useCallback(() => setSeen(true), [])
  return <div className="demo-conversation"><ConversationSentinel onShow={onShow} /><output>{seen ? '已触发可见回调' : '等待进入视口'}</output></div>
}
function PaneSwapDemo() {
  const [revision, setRevision] = useState(0)
  return <div className="demo-stack"><Button type="button" variant="outline" onClick={() => setRevision(value => value + 1)}>重新挂载</Button>
    <ConversationPaneSwap key={revision} className="agent-groups demo-swap">示例内容入场</ConversationPaneSwap></div>
}
function ComposerDemo({ initiallyOpen, initialValue = '' }: { initiallyOpen: boolean; initialValue?: string }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [value, setValue] = useState(initialValue)
  const [sent, setSent] = useState('')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setOpen(current => !current)
      } else if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return <div className="demo-stage-top"><Button type="button" variant="outline" onClick={() => setOpen(!open)}>{open ? '收起' : '打开'}输入框</Button>
    <output>{sent && `示例发送：${sent}`}</output>
    <Composer open={open} value={value} onChange={setValue} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}
      onSend={text => { setSent(text); setValue('') }} />
  </div>
}
function ComposerClosed() { return <ComposerDemo initiallyOpen={false} /> }
function ComposerOpen() { return <ComposerDemo initiallyOpen /> }
function ComposerTyped() { return <ComposerDemo initiallyOpen initialValue="计数器如何工作？" /> }
function ContextLevels() {
  return <div className="demo-row demo-context">{[0, 120000, 300000].map(tokens => <div key={tokens}><ContextRing tokens={tokens} limit={300000} /><span>{tokens / 10000} 万 / 30 万</span></div>)}</div>
}
function FluidDemo() {
  const [active, setActive] = useState<number | null>(null)
  const rects = [0, 1, 2].map(index => ({ left: index * 132, top: 0, width: 124, height: 66 }))
  return <div className="demo-fluid" onMouseLeave={() => setActive(null)}><FluidHighlight className="card-grid-highlight" activeIndex={active} rects={rects} />
    {['观察', '思考', '实践'].map((label, index) => <button key={label} type="button" onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>{label}</button>)}</div>
}
function ProgressLevels() {
  return <div className="demo-progress">{[0, 36, 100].map(percent => <div key={percent}><span>{percent}%</span><ProgressBar percent={percent} done={percent === 100} /></div>)}</div>
}
function StatusLevels() {
  return <div className="demo-row"><StatusChip status="未开始" /><StatusChip status="已分配" /><StatusChip status="进行中" /><StatusChip status="已完成" /><StatusChip status="任务已暂停" /></div>
}
function ShellDemo({ initialCollapsed = false, initialImmersive = false }: { initialCollapsed?: boolean; initialImmersive?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [immersive, setImmersive] = useState(initialImmersive)
  return <ShellFrame collapsed={collapsed} immersive={immersive}
    navigation={<div className="demo-shell-navigation"><IconText name="home-2">首页</IconText><IconText name="chat-round-dots">对话</IconText></div>}
    bottom={<div className="demo-shell-footer">示例学习空间</div>}
    rail={<button type="button" className="railbtn r-home" aria-label="首页"><Icon name="home-2" size={18} /></button>}
    toggle={<button type="button" className="sidebar-toggle" aria-label="切换导航" onClick={() => setCollapsed(!collapsed)}><Icon name="panel-left-close" size={18} /></button>}>
    <div className="demo-shell-content"><h1>学习空间</h1><p>外壳内容由使用方提供。</p><Button type="button" variant="outline" onClick={() => setImmersive(!immersive)}>{immersive ? '退出沉浸模式' : '沉浸模式'}</Button></div>
  </ShellFrame>
}
function ShellExpanded() { return <ShellDemo /> }
function ShellCollapsed() { return <ShellDemo initialCollapsed /> }
function ShellImmersive() { return <ShellDemo initialImmersive /> }
function SidebarNavigationDemo({ initialAgent }: { initialAgent: boolean }) {
  const [onAgent, setOnAgent] = useState(initialAgent)
  const [message, setMessage] = useState('')
  return <div className="demo-sidebar-navigation"><SidebarNavigation onHome={!onAgent} onAgent={onAgent}
    openHome={() => setOnAgent(false)} openAgent={() => setOnAgent(true)}
    history={<><button type="button" className="agent-newchat" onClick={() => setMessage('已打开示例新对话')}>新对话</button><span className="agent-conv">示例会话</span></>} />
    <output>{message}</output></div>
}
function NavigationHome() { return <SidebarNavigationDemo initialAgent={false} /> }
function NavigationAgent() { return <SidebarNavigationDemo initialAgent /> }

const demoAccount = { name: '示例同学', subtitle: '示例学习空间' }
function SidebarBottomDemo({ initialAccountOpen = false, initialThemeOpen = false }: { initialAccountOpen?: boolean; initialThemeOpen?: boolean }) {
  const [accountOpen, setAccountOpen] = useState(initialAccountOpen)
  const [themeOpen, setThemeOpen] = useState(initialThemeOpen)
  const [preference, setPreference] = useState<ThemePreference>('light')
  const [message, setMessage] = useState('')
  const action = (text: string) => { setMessage(text); setAccountOpen(false) }
  return <div className="demo-sidebar-bottom"><SidebarBottom account={demoAccount} accountOpen={accountOpen} collapsed={false}
    settingsActive={false} themeOpen={themeOpen} themePreference={preference} themeResolved={preference === 'dark' ? 'dark' : 'light'} themeTip="外观"
    onToggleAccount={() => { setAccountOpen(value => !value); setThemeOpen(false) }} onOpenSettings={() => action('设置与帮助')}
    onToggleTheme={() => { setThemeOpen(value => !value); setAccountOpen(false) }}
    onThemeChange={value => { setPreference(value); setMessage(`外观：${value}`) }} onThemeClose={() => setThemeOpen(false)}
    accountActions={{ onProfile: () => action('个人资料'), onSettings: () => action('设置'), onLogout: () => action('退出登录') }} />
    <output>{message && `已触发示例操作：${message}`}</output></div>
}
function BottomDefault() { return <SidebarBottomDemo /> }
function BottomAccount() { return <SidebarBottomDemo initialAccountOpen /> }
function BottomTheme() { return <SidebarBottomDemo initialThemeOpen /> }

function SidebarToggleDemo({ initiallyCollapsed }: { initiallyCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed)
  return <ShellFrame collapsed={collapsed} immersive={false} navigation={<div className="demo-shell-navigation">示例导航</div>}
    bottom={null} rail={<span className="railbtn r-home"><Icon name="home-2" size={18} /></span>}
    toggle={<SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} />}>
    <div className="demo-shell-content"><h1>学习空间</h1><p>当前侧栏：{collapsed ? '收起' : '展开'}</p></div>
  </ShellFrame>
}
function ToggleExpanded() { return <SidebarToggleDemo initiallyCollapsed={false} /> }
function ToggleCollapsed() { return <SidebarToggleDemo initiallyCollapsed /> }

function SidebarRailDemo({ initialAgent = false, initialAccountOpen = false }: { initialAgent?: boolean; initialAccountOpen?: boolean }) {
  const [collapsed, setCollapsed] = useState(true)
  const [onAgent, setOnAgent] = useState(initialAgent)
  const [panel, setPanel] = useState<'history' | 'search' | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(initialAccountOpen)
  const [message, setMessage] = useState('')
  const action = (text: string) => { setMessage(text); setAccountOpen(false) }
  return <ShellFrame collapsed={collapsed} immersive={false} navigation={<div className="demo-shell-navigation">示例导航</div>} bottom={null}
    toggle={<SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed(value => !value)} />}
    rail={<SidebarRail onHome={!onAgent} onAgent={onAgent} panel={panel} archivedCount={1} archiveOpen={archiveOpen}
      account={demoAccount} accountOpen={accountOpen} railVisible={collapsed}
      accountActions={{ onProfile: () => action('个人资料'), onSettings: () => action('设置'), onLogout: () => action('退出登录') }}
      openHome={() => { setOnAgent(false); setPanel(null) }} openAgent={() => { setOnAgent(true); setPanel('history') }}
      newConversation={() => { setMessage('新对话'); setPanel(null) }}
      toggleArchive={() => { setArchiveOpen(value => !value); setPanel('history') }}
      toggleSearch={() => setPanel(current => current === 'search' ? null : 'search')}
      toggleAccount={() => { setAccountOpen(value => !value); setPanel(null) }} />}
    overlays={<RailHistoryPanel visible={panel !== null} onClose={() => setPanel(null)}><div className="demo-panel-content">
      <strong>{panel === 'search' ? '搜索示例会话' : archiveOpen ? '已归档' : '示例会话'}</strong>
      {panel === 'search' && <input aria-label="搜索示例会话" placeholder="搜索对话…" />}
      <button type="button" className="agent-conv" onClick={() => { setMessage('示例会话'); setPanel(null) }}>如何设计计数器？</button>
      <Button type="button" variant="outline" onClick={() => setPanel(null)}>关闭面板</Button>
    </div></RailHistoryPanel>}>
    <div className="demo-shell-content"><h1>学习空间</h1><p>{message ? `已触发示例操作：${message}` : '使用左侧轨道操作示例。'}</p></div>
  </ShellFrame>
}
function RailHome() { return <SidebarRailDemo /> }
function RailAgent() { return <SidebarRailDemo initialAgent /> }
function RailAccount() { return <SidebarRailDemo initialAgent initialAccountOpen /> }

function RailPanelDemo({ initiallyVisible }: { initiallyVisible: boolean }) {
  const [visible, setVisible] = useState(initiallyVisible)
  const [message, setMessage] = useState('')
  return <div className="demo-stage-top"><Button type="button" variant="outline" onClick={() => setVisible(true)}>打开历史面板</Button><output>{message}</output>
    <RailHistoryPanel visible={visible} onClose={() => setVisible(false)}><div className="demo-panel-content"><strong>示例会话</strong>
      <button type="button" className="agent-conv" onClick={() => { setMessage('已选择示例会话'); setVisible(false) }}>如何设计计数器？</button>
      <Button type="button" variant="outline" onClick={() => setVisible(false)}>关闭面板</Button></div></RailHistoryPanel></div>
}
function PanelOpen() { return <RailPanelDemo initiallyVisible /> }
function PanelClosed() { return <RailPanelDemo initiallyVisible={false} /> }

function HomeAssistantDemo({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [value, setValue] = useState('')
  const [sent, setSent] = useState('')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') { event.preventDefault(); setOpen(current => !current) }
      else if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return <div className="demo-stage-top"><output>{sent && `示例发送：${sent}`}</output>
    <HomeAssistant open={open} value={value} onChange={setValue} onSend={text => { setSent(text); setValue('') }}
      onToggle={() => setOpen(current => !current)} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} />
  </div>
}
function AssistantClosed() { return <HomeAssistantDemo initiallyOpen={false} /> }
function AssistantOpen() { return <HomeAssistantDemo initiallyOpen /> }
function ToastStatus() { return <Toast>示例设置已更新</Toast> }
function ToastError() { return <Toast role="alert">示例内容读取失败，请重试。</Toast> }

function Suggestions({ count }: { count: number }) {
  const [selected, setSelected] = useState('')
  const [show, setShow] = useState(true)
  const suggestions = ['为什么需要时钟信号？', '计数器有哪些状态？', '如何验证设计结果？', '下一步可以尝试什么？']
  return <div className="demo-suggest"><div className="demo-suggest-anchor"><SuggestionStack items={suggestions.slice(0, count)} show={show} onPick={setSelected} /></div>
    <div className="demo-suggest-footer"><Button type="button" variant="outline" onClick={() => setShow(!show)}>{show ? '隐藏建议' : '显示建议'}</Button><output>{selected && `已选择：${selected}`}</output></div></div>
}
function SuggestionsThree() { return <Suggestions count={3} /> }
function SuggestionsFour() { return <Suggestions count={4} /> }

const source = 'apps/web/src/ui-catalog/examples/foundation.tsx'
const foundation = '@xunjie/ui/foundation'
export const foundationEntries: CatalogEntry[] = [
  { id: 'button', name: 'Button', description: '主操作与次操作按钮。', importPath: foundation, source: 'packages/ui/src/foundation/Button.tsx', exampleSource: source, props: ['variant: primary | outline', '原生 button 属性与 ref'], dependencies: [], states: [
    { id: 'variants', name: '主 / 次操作', component: ButtonVariants }, { id: 'disabled', name: '禁用', component: DisabledButtons },
  ] },
  { id: 'account-avatar', name: 'AccountAvatar', description: '由名称或显式头像地址渲染的账户头像。', importPath: foundation, source: 'packages/ui/src/foundation/AccountAvatar.tsx', exampleSource: source, props: ['name: string', 'avatar?: string | null', 'className?: string'], dependencies: ['图片模式由调用方提供地址；示例使用包内本地资源'], states: [
    { id: 'initial', name: '名称头像', component: Avatars }, { id: 'image', name: '图片头像', component: AvatarImage },
  ] },
  { id: 'account-menu', name: 'AccountMenu', description: '由调用方控制开合、身份及菜单动作。', importPath: foundation, source: 'packages/ui/src/foundation/AccountMenu.tsx', exampleSource: source, props: ['open, anchor', 'name, subtitle, avatar', 'onProfile, onSettings, onLogout'], dependencies: ['图标来自 @xunjie/ui/icons'], states: [
    { id: 'pill', name: '账号胶囊锚点', component: AccountPill }, { id: 'rail', name: '收起侧栏锚点', component: AccountRail },
  ] },
  { id: 'theme-menu', name: 'ThemeMenu', description: '受控的浅色、深色与跟随系统外观菜单。', importPath: foundation, source: 'packages/ui/src/foundation/ThemeMenu.tsx', exampleSource: source, props: ['open: boolean', 'preference: light | dark | system', 'onChange, onClose'], dependencies: ['调用方负责应用主题与关闭后恢复焦点；示例仅改变当前预览'], states: [
    { id: 'light', name: '浅色', component: ThemeLight }, { id: 'dark', name: '深色', component: ThemeDark }, { id: 'system', name: '跟随系统', component: ThemeSystem },
  ] },
  { id: 'profile-card', name: 'ProfileCard', description: '受控的身份、画像及记录资料卡。', importPath: foundation, source: 'packages/ui/src/foundation/ProfileCard.tsx', exampleSource: source, props: ['open, name, avatar, roleLabel, term, roleDetails', 'identity, accountFacts, accountLabel', 'portrait, records', 'onClose, onLogout, onAccountSettings, onEditProfile'], dependencies: ['Radix Dialog Portal；资料和操作由调用方提供'], states: [
    { id: 'populated', name: '完整资料', component: ProfilePopulated, height: 700 }, { id: 'empty', name: '无画像与记录', component: ProfileEmpty, height: 700 },
  ] },
  { id: 'session-login', name: 'SessionLogin', description: '由调用方控制的学生 / 教师登录界面。', importPath: foundation, source: 'packages/ui/src/foundation/SessionLogin.tsx', exampleSource: source, props: ['entryRole, loginName, password, busy, logoutFailed', 'notice?, accountRef?, previewLink?', '身份与字段变化、提交、重试和恢复回调'], dependencies: ['示例使用合成账号密码，提交只更新本地提示'], states: [
    { id: 'student', name: '学生', component: LoginStudent, height: 700 }, { id: 'teacher', name: '教师', component: LoginTeacher, height: 700 },
    { id: 'busy', name: '等待', component: LoginBusy, height: 700 }, { id: 'notice', name: '提示', component: LoginNotice, height: 700 },
    { id: 'logout-failed', name: '退出失败', component: LoginLogoutFailed, height: 700 },
  ] },
  { id: 'conversation-row', name: 'ConversationRow', description: '受控会话行及其菜单、重命名和删除确认。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['title, active, pinned', 'mode: normal | renaming | confirming', 'menuOpen, menuUp, menuClosing', '打开、置顶、重命名、归档、删除回调'], dependencies: ['菜单定位由调用方决定'], states: [
    { id: 'normal', name: '普通', component: ConversationNormal }, { id: 'active-pinned', name: '选中与置顶', component: ConversationActive },
    { id: 'menu', name: '菜单向下', component: ConversationMenu }, { id: 'menu-up', name: '菜单向上', component: ConversationMenuUp },
    { id: 'renaming', name: '重命名', component: ConversationRenaming }, { id: 'confirming', name: '删除确认', component: ConversationConfirming },
  ] },
  { id: 'conversation-pane', name: 'ConversationPane', description: '受控会话历史、搜索、分组和归档视图。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['archived, archivedVisible, archivedHits, pinned, groups', 'archiveOpen, query, searching, activeId', 'menu, renamingId, confirmingId, foldedGroups, foldingGroup', 'remaining, moreArchived, foldableGroups', '新建、打开、搜索、置顶、重命名、归档、删除、恢复、分组和分页回调'], dependencies: ['示例数据和变更只存在于当前预览的本地内存'], states: [
    { id: 'populated', name: '非空列表', component: PanePopulated }, { id: 'empty', name: '空列表', component: PaneEmpty }, { id: 'archived', name: '归档列表', component: PaneArchived },
  ] },
  { id: 'archived-conversation-row', name: 'ArchivedConversationRow', description: '归档会话行与恢复入口。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['title: string', 'onRestore: () => void'], dependencies: [], states: [{ id: 'default', name: '归档', component: ArchivedRow }] },
  { id: 'conversation-group', name: 'ConversationGroup', description: '可折叠的会话分组。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['label, count', 'foldable, folded, folding', 'onToggle, children'], dependencies: [], states: [
    { id: 'expanded', name: '展开', component: GroupExpanded }, { id: 'folded', name: '折叠', component: GroupFolded },
  ] },
  { id: 'conversation-sentinel', name: 'ConversationSentinel', description: '进入视口时通知调用方加载的展示节点。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['onShow: () => void', 'signal?: unknown'], dependencies: ['调用方负责分页与去重'], states: [{ id: 'visible', name: '进入视口', component: SentinelDemo }] },
  { id: 'conversation-pane-swap', name: 'ConversationPaneSwap', description: '会话区域挂载时的入场容器。', importPath: foundation, source: 'packages/ui/src/foundation/ConversationHistory.tsx', exampleSource: source, props: ['className: string', 'children: ReactNode'], dependencies: [], states: [{ id: 'enter', name: '入场', component: PaneSwapDemo }] },
  { id: 'composer', name: 'Composer', description: '首页学习助手的入口与输入气泡。', importPath: foundation, source: 'packages/ui/src/foundation/Composer.tsx', exampleSource: source, props: ['open, value', 'onChange, onSend, onOpen, onClose'], dependencies: ['窄屏隐藏收起态入口；示例使用 1200px 视口'], states: [
    { id: 'closed', name: '收起', component: ComposerClosed, viewport: 'wide', initialScroll: 'end' }, { id: 'open', name: '展开', component: ComposerOpen, viewport: 'wide', initialScroll: 'end' }, { id: 'typed', name: '已输入', component: ComposerTyped, viewport: 'wide', initialScroll: 'end' },
  ] },
  { id: 'context-ring', name: 'ContextRing', description: '上下文用量与悬浮说明。', importPath: foundation, source: 'packages/ui/src/foundation/ContextRing.tsx', exampleSource: source, props: ['tokens: number', 'limit: number（显式提供）'], dependencies: ['悬浮信息通过 body Portal 渲染'], states: [{ id: 'levels', name: '空 / 使用中 / 已满', component: ContextLevels }] },
  { id: 'fluid-highlight', name: 'FluidHighlight', description: '在一组目标之间移动的共享高亮。', importPath: foundation, source: 'packages/ui/src/foundation/FluidHighlight.tsx', exampleSource: source, props: ['activeIndex: number | null', 'rects: readonly ItemRect[]', 'className?: string'], dependencies: ['调用方提供目标矩形及高亮样式'], states: [{ id: 'interactive', name: '悬停与键盘聚焦', component: FluidDemo }] },
  { id: 'progress-bar', name: 'ProgressBar', description: '任务进度轨道。', importPath: foundation, source: 'packages/ui/src/foundation/ProgressBar.tsx', exampleSource: source, props: ['percent: number', 'done?: boolean'], dependencies: [], states: [{ id: 'levels', name: '未开始 / 进行中 / 完成', component: ProgressLevels }] },
  { id: 'shell-frame', name: 'ShellFrame', description: '由调用方提供导航、侧栏和内容的界面外壳。', importPath: foundation, source: 'packages/ui/src/foundation/ShellFrame.tsx', exampleSource: source, props: ['collapsed, immersive', 'navigation, bottom, rail, toggle, children', 'mainRef?, overlays?, className?'], dependencies: ['预览使用独立视口以保留固定定位'], states: [
    { id: 'expanded', name: '展开', component: ShellExpanded }, { id: 'collapsed', name: '收起', component: ShellCollapsed }, { id: 'immersive', name: '沉浸', component: ShellImmersive },
  ] },
  { id: 'sidebar-navigation', name: 'SidebarNavigation', description: '展开侧栏的首页、对话导航与历史区域。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['onHome, onAgent, history', 'openHome, openAgent'], dependencies: ['历史内容由调用方传入'], states: [
    { id: 'home', name: '首页 / 历史收起', component: NavigationHome }, { id: 'agent', name: '对话 / 历史展开', component: NavigationAgent },
  ] },
  { id: 'sidebar-bottom', name: 'SidebarBottom', description: '展开侧栏的账户、设置和外观入口。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['account, accountOpen, collapsed, settingsActive', 'themeOpen, themePreference, themeResolved, themeTip', '账户、设置、外观动作及可选 refs'], dependencies: ['账户和主题偏好由调用方提供'], states: [
    { id: 'default', name: '默认', component: BottomDefault }, { id: 'account', name: '账户菜单', component: BottomAccount }, { id: 'theme', name: '外观菜单', component: BottomTheme },
  ] },
  { id: 'sidebar-toggle', name: 'SidebarToggle', description: '控制侧栏展开或收起的按钮。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['collapsed: boolean', 'onToggle: () => void', 'buttonRef?'], dependencies: ['在 ShellFrame 中呈现固定定位'], states: [
    { id: 'expanded', name: '展开', component: ToggleExpanded }, { id: 'collapsed', name: '收起', component: ToggleCollapsed },
  ] },
  { id: 'sidebar-rail', name: 'SidebarRail', description: '收起侧栏后的导航轨道与账户入口。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['onHome, onAgent, panel, archivedCount, archiveOpen', 'account, accountOpen, railVisible, accountRef?', '导航、搜索、归档和账户回调'], dependencies: ['通过 ShellFrame 的 rail 插槽放置；示例面板与操作均为本地状态'], states: [
    { id: 'home', name: '首页', component: RailHome }, { id: 'agent', name: '对话', component: RailAgent }, { id: 'account', name: '账户菜单', component: RailAccount },
  ] },
  { id: 'rail-history-panel', name: 'RailHistoryPanel', description: '收起侧栏时的历史浮层与遮罩。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['visible: boolean', 'onClose, children, panelRef?'], dependencies: ['内容由调用方提供；固定定位与遮罩在独立预览中呈现'], states: [
    { id: 'open', name: '展开', component: PanelOpen }, { id: 'closed', name: '收起', component: PanelClosed },
  ] },
  { id: 'home-assistant', name: 'HomeAssistant', description: '首页角色及可展开输入气泡。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['open, value', 'onChange, onSend, onToggle, onOpen, onClose'], dependencies: ['窄屏隐藏收起态输入气泡；示例使用 1200px 视口'], states: [
    { id: 'closed', name: '收起', component: AssistantClosed, viewport: 'wide' }, { id: 'open', name: '展开', component: AssistantOpen, viewport: 'wide' },
  ] },
  { id: 'toast', name: 'Toast', description: '普通或需要立即通知的状态提示。', importPath: foundation, source: 'packages/ui/src/foundation/ShellParts.tsx', exampleSource: source, props: ['children: ReactNode', 'role?: status | alert'], dependencies: ['固定定位；错误示例使用 alert 语义'], states: [
    { id: 'status', name: '普通提示', component: ToastStatus }, { id: 'error', name: '错误提示', component: ToastError },
  ] },
  { id: 'status-chip', name: 'StatusChip', description: '学生任务状态标记。', importPath: foundation, source: 'packages/ui/src/foundation/StatusChip.tsx', exampleSource: source, props: ['status: TaskDisplayStatus'], dependencies: [], states: [{ id: 'statuses', name: '全部任务状态', component: StatusLevels }] },
  { id: 'suggestion-stack', name: 'SuggestionStack', description: '可展开并选取的建议问题。', importPath: foundation, source: 'packages/ui/src/foundation/SuggestionStack.tsx', exampleSource: source, props: ['items: string[]', 'onPick: (text: string) => void', 'label?, show?'], dependencies: ['放置在相对定位的输入框锚点内'], states: [
    { id: 'three', name: '三条建议', component: SuggestionsThree }, { id: 'four', name: '四条建议', component: SuggestionsFour },
  ] },
]
