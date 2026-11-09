import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon } from '../icons'

/** 滚动时按可见位置请求下一页；分页数据与游标由调用方持有。 */
export function ConversationSentinel({ onShow, signal }: { onShow: () => void; signal?: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      const rect = el.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) onShow()
    }
    check()
    const timer = window.setTimeout(check, 400)
    window.addEventListener('scroll', check, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', check, true)
    }
  }, [onShow, signal])
  return <div ref={ref} className="agent-conv-sentinel">下拉加载更早…</div>
}

/** 区域挂载时播放一次入场，后续数据更新不重复播放。 */
export function ConversationPaneSwap({ className, children }: { className: string; children: ReactNode }) {
  const [fresh, setFresh] = useState(true)
  return <div className={fresh ? `${className} swap-in` : className}
    onAnimationEnd={event => { if (event.target === event.currentTarget) setFresh(false) }}>{children}</div>
}

export interface ConversationRowProps {
  conversationId?: string
  title: string
  active: boolean
  pinned: boolean
  mode?: 'normal' | 'renaming' | 'confirming'
  menuOpen: boolean
  menuUp?: boolean
  menuClosing?: boolean
  disabled?: boolean
  onOpen: () => void
  onToggleMenu: (anchor: HTMLElement) => void
  onTogglePin: () => void
  onStartRename: () => void
  onCommitRename: (title: string) => void
  onCancelRename: () => void
  onArchive: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}

/** 会话普通、重命名、删除确认及菜单状态；数据写入由宿主完成。 */
export function ConversationRow({ conversationId, title, active, pinned, mode = 'normal', menuOpen, menuUp, menuClosing, disabled = false,
  onOpen, onToggleMenu, onTogglePin, onStartRename, onCommitRename, onCancelRename,
  onArchive, onAskDelete, onConfirmDelete, onCancelDelete }: ConversationRowProps) {
  const menuId = useId()
  const more = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const confirmation = useRef<HTMLDivElement>(null)
  const renameFinished = useRef(false)
  const supportsPopover = typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function'
  useEffect(() => { if (mode === 'renaming' && !disabled) renameFinished.current = false }, [mode, disabled])
  useLayoutEffect(() => {
    const element = menu.current
    const row = more.current?.closest('.agent-conv-row')
    if (!menuOpen || !element || !row || typeof element.showPopover !== 'function') return
    const bounds = row.getBoundingClientRect()
    element.style.right = `${document.documentElement.clientWidth - bounds.right + 32}px`
    element.style.top = menuUp ? 'auto' : `${bounds.bottom + 6}px`
    element.style.bottom = menuUp ? `${window.innerHeight - bounds.top + 6}px` : 'auto'
    // Keep the menu outside scroll/fold clipping without moving it out of its row's DOM.
    element.showPopover()
    return () => { if (element.isConnected && element.matches(':popover-open')) element.hidePopover() }
  }, [menuOpen, menuUp])
  useEffect(() => {
    if (menuOpen && !menuClosing && !menu.current?.closest('[inert]')) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menuOpen, menuClosing])
  useEffect(() => {
    if (mode === 'confirming' && !disabled && !confirmation.current?.closest('[inert]')) confirmation.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [mode, disabled])
  const commitRename = (input: HTMLInputElement) => {
    if (renameFinished.current || disabled) return
    renameFinished.current = true
    const next = input.value.trim()
    if (!next || next === title) onCancelRename()
    else onCommitRename(next)
  }
  if (mode === 'confirming') return <div ref={confirmation} className="agent-conv-confirm" data-conversation-id={conversationId} role="group" aria-label={`删除「${title}」`}
    onKeyDown={event => { if (event.key === 'Escape' && !disabled) { event.stopPropagation(); onCancelDelete() } }}>
    <span>删除这条对话？</span>
    <button className="danger" disabled={disabled} onClick={onConfirmDelete}>删除</button>
    <button disabled={disabled} onClick={onCancelDelete}>取消</button>
  </div>
  if (mode === 'renaming') return <div className="agent-conv-row renaming" data-conversation-id={conversationId}>
    <input className="agent-conv-rename" defaultValue={title} aria-label="重命名对话" autoFocus disabled={disabled} maxLength={200}
      onFocus={event => event.currentTarget.select()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') { event.preventDefault(); commitRename(event.currentTarget) }
        if (event.key === 'Escape') { event.stopPropagation(); renameFinished.current = true; onCancelRename() }
      }} onBlur={event => commitRename(event.currentTarget)} />
  </div>
  return <div data-conversation-id={conversationId} className={'agent-conv-row' + (active ? ' active' : '') + (menuOpen ? ' menu-open' : '')}>
    <button className={active ? 'agent-conv active' : 'agent-conv'} aria-current={active ? 'page' : undefined} title={title} onClick={onOpen}>{title}</button>
    <button ref={more} className="agent-conv-more" aria-label="更多操作" title="更多操作" aria-haspopup="menu" disabled={disabled}
      aria-controls={menuOpen ? menuId : undefined} aria-expanded={menuOpen && !menuClosing}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' && (!menuOpen || menuClosing)) { event.preventDefault(); onToggleMenu(event.currentTarget) }
        if (event.key === 'Escape' && menuOpen && !menuClosing) { event.stopPropagation(); onToggleMenu(event.currentTarget) }
      }} onClick={event => { event.stopPropagation(); onToggleMenu(event.currentTarget) }}>
      <Icon name="menu-dots" size={14} />
    </button>
    <button className={'agent-conv-pin' + (pinned ? ' on' : '')}
      aria-label={pinned ? '取消置顶' : '置顶'} title={pinned ? '取消置顶' : '置顶'} aria-pressed={pinned} disabled={disabled}
      onClick={event => { event.stopPropagation(); onTogglePin() }}>
      <Icon name="pin" size={14} variant={pinned ? 'bold' : 'linear'} />
    </button>
    {menuOpen && <div ref={menu} id={menuId} popover={supportsPopover ? 'manual' : undefined} className={'agent-conv-menu' + (menuUp ? ' up' : '') + (menuClosing ? ' closing' : '')}
      role="menu" aria-label="会话操作" inert={menuClosing} aria-hidden={menuClosing || undefined}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation()
          if (more.current) { more.current.focus(); onToggleMenu(more.current) }
          return
        }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
        if (next >= 0 && items[next]) { event.preventDefault(); items[next].focus() }
      }}>
      <button role="menuitem" disabled={disabled} onClick={onStartRename}><Icon name="pen" size={14} /><span className="cm-label">重命名</span></button>
      <button role="menuitem" disabled={disabled} onClick={onArchive}><Icon name="archive" size={14} /><span className="cm-label">归档</span></button>
      <button role="menuitem" disabled={disabled} className="danger" onClick={onAskDelete}><Icon name="trash-bin-trash" size={14} /><span className="cm-label">删除</span></button>
    </div>}
  </div>
}

export function ArchivedConversationRow({ title, onRestore, disabled = false }: { title: string; onRestore: () => void; disabled?: boolean }) {
  return <div className="agent-conv-row archived">
    <span className="agent-conv" title={title}>{title}</span>
    <button className="agent-conv-restore" onClick={onRestore} disabled={disabled} aria-label={`恢复「${title}」`}>恢复</button>
  </div>
}

export interface ConversationGroupProps {
  label: string
  count: number
  foldable: boolean
  folded: boolean
  folding: boolean
  onToggle: () => void
  children: ReactNode
}

export function ConversationGroup({ label, count, foldable, folded, folding, onToggle, children }: ConversationGroupProps) {
  return <div className="agent-group">
    {foldable ? <button className={'agent-group-label foldable' + (folded ? ' folded' : '')}
      aria-expanded={!folded} onClick={onToggle}>
      {label}{folded && <span className="count">{count}</span>}<Icon className="gl-chev" name="alt-arrow-down" size={12} />
    </button> : <div className="agent-group-label">{label}</div>}
    <div className={'agent-group-body' + (folded ? ' folded' : '') + (folding ? ' folding' : '')}>
      <div className="agent-group-inner" inert={folded ? true : undefined}>{(!folded || folding) && children}</div>
    </div>
  </div>
}

export interface ConversationItem { id: string; title: string; pinned: boolean }
export interface ConversationPaneProps {
  actionsDisabled?: boolean
  archived: readonly ConversationItem[]
  archivedVisible: readonly ConversationItem[]
  archivedHits: readonly ConversationItem[]
  pinned: readonly ConversationItem[]
  groups: ReadonlyArray<{ label: string; items: readonly ConversationItem[] }>
  archiveOpen: boolean
  query: string
  searching: boolean
  activeId: string | null
  menu: { id: string | null; up: boolean; closing: boolean }
  renamingId: string | null
  confirmingId: string | null
  foldedGroups: readonly string[]
  foldingGroup: string | null
  foldableGroups: ReadonlySet<string>
  remaining: boolean
  moreArchived: boolean
  foldSignal?: unknown
  searchRef?: RefObject<HTMLInputElement | null>
  onNew: () => void
  onOpen: (id: string) => void
  onToggleArchive: (open: boolean) => void
  onSearch: (query: string) => void
  onClearSearch: () => void
  onToggleMenu: (id: string, anchor: HTMLElement) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onStartRename: (id: string) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
  onArchive: (id: string) => void
  onAskDelete: (id: string) => void
  onConfirmDelete: (id: string) => void
  onCancelDelete: () => void
  onRestore: (id: string) => void
  onToggleGroup: (label: string) => void
  onLoadMore: () => void
  onLoadMoreArchived: () => void
}

/** 对话历史的完整视图；搜索、分页、菜单及对话操作的状态由宿主共享。 */
export function ConversationPane(props: ConversationPaneProps) {
  const row = (item: ConversationItem) => <ConversationRow key={item.id} conversationId={item.id} title={item.title} disabled={props.actionsDisabled}
    active={item.id === props.activeId} pinned={item.pinned}
    mode={props.confirmingId === item.id ? 'confirming' : props.renamingId === item.id ? 'renaming' : 'normal'}
    menuOpen={props.menu.id === item.id} menuUp={props.menu.up} menuClosing={props.menu.closing}
    onOpen={() => props.onOpen(item.id)} onToggleMenu={anchor => props.onToggleMenu(item.id, anchor)}
    onTogglePin={() => props.onTogglePin(item.id, !item.pinned)}
    onStartRename={() => props.onStartRename(item.id)} onCommitRename={title => props.onCommitRename(item.id, title)}
    onCancelRename={props.onCancelRename} onArchive={() => props.onArchive(item.id)} onAskDelete={() => props.onAskDelete(item.id)}
    onConfirmDelete={() => props.onConfirmDelete(item.id)} onCancelDelete={props.onCancelDelete} />
  const group = (label: string, items: readonly ConversationItem[]) => {
    const foldable = props.foldableGroups.has(label)
    const folded = foldable && props.foldedGroups.includes(label)
    return <ConversationGroup key={label} label={label} count={items.length} foldable={foldable}
      folded={folded} folding={props.foldingGroup === label} onToggle={() => props.onToggleGroup(label)}>
      {items.map(row)}
    </ConversationGroup>
  }
  const archivedRow = (item: ConversationItem) => <ArchivedConversationRow key={item.id} title={item.title}
    disabled={props.actionsDisabled} onRestore={() => props.onRestore(item.id)} />

  return <>
    <button className="agent-newchat" onClick={props.onNew}>
      <span className="navicon"><Icon name="pen-new-square" size={14} /></span>新对话
    </button>
    {(props.archived.length > 0 || props.archiveOpen) && <button
      className={'agent-archive-entry' + (props.archiveOpen ? ' on' : '')}
      onClick={() => props.onToggleArchive(!props.archiveOpen)} aria-expanded={props.archiveOpen}
      aria-label={props.archiveOpen ? '返回对话列表' : `已归档 ${props.archived.length} 个对话`}>
      <Icon name={props.archiveOpen ? 'alt-arrow-left' : 'archive'} size={14} />已归档
      <span className="count">{props.archived.length}</span>
    </button>}
    {props.archiveOpen ? <ConversationPaneSwap className="agent-groups">
      <div className="agent-group">{props.archivedVisible.map(archivedRow)}</div>
      {props.moreArchived && <ConversationSentinel onShow={props.onLoadMoreArchived} />}
    </ConversationPaneSwap> : <>
      <div className="agent-search">
        <Icon name="minimalistic-magnifier" size={14} />
        <input ref={props.searchRef} aria-label="搜索对话" placeholder="搜索对话…"
          value={props.query} onChange={event => props.onSearch(event.target.value)} />
      </div>
      <ConversationPaneSwap className="agent-groups">
        {props.pinned.length > 0 || props.groups.length > 0 || props.archivedHits.length > 0 ? <>
          {props.pinned.length > 0 && group('置顶', props.pinned)}
          {props.groups.map(item => group(item.label, item.items))}
          {props.archivedHits.length > 0 && <div className="agent-group">
            <div className="agent-group-label">已归档</div>{props.archivedHits.map(archivedRow)}
          </div>}
        </> : props.searching ? <div className="agent-side-empty">
          没有匹配「{props.query.trim()}」的对话
          <button className="agent-side-clear" onClick={props.onClearSearch}>清除搜索</button>
        </div> : <div className="agent-side-empty">开始提问后，对话会留在这里</div>}
        {!props.searching && props.remaining && <ConversationSentinel onShow={props.onLoadMore} signal={props.foldSignal} />}
      </ConversationPaneSwap>
    </>}
  </>
}
