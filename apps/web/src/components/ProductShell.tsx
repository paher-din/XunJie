import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { THEME_OPTIONS, useTheme } from '../lib/theme'
import { ShellFrame, useShellNavigation } from './ShellFrame'
import { ThemeMenu } from './ThemeMenu'
import './product-shell.css'

export interface ProductShellProps {
  children: ReactNode
  immersive: boolean
  identityName: string
  spaces: { key: string; label: string }[]
  spaceKey: string
  onSpaceChange: (key: string) => void
  onHome: () => void
  onConnections: () => void
  onModels?: () => void
  modelName?: string
}

function ProductThemeButton({ visible, rail = false }: { visible: boolean; rail?: boolean }) {
  const { preference, resolved } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label = THEME_OPTIONS.find(option => option.value === preference)?.label ?? '跟随系统'
  const tip = preference === 'system'
    ? `外观 · 跟随系统（当前${resolved === 'dark' ? '深色' : '浅色'}）`
    : `外观 · ${label}`
  const close = useCallback(() => {
    setOpen(false)
    if (visible) triggerRef.current?.focus({ preventScroll: true })
  }, [visible])

  useLayoutEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])
  useEffect(() => {
    if (!open || !visible) return
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, visible])

  return (
    <div className="theme-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={(rail ? 'railbtn' : 'side-icon') + (open ? ' active' : '')}
        aria-label={tip}
        data-tip={rail ? undefined : tip}
        title={tip}
        aria-haspopup="menu"
        aria-expanded={open && visible}
        onClick={() => setOpen(value => !value)}
      >
        <Icon name={resolved === 'light' ? 'sun' : 'moon'} size={16} variant="linear" tone="neutral" />
      </button>
      <div inert={!open || !visible}>
        <ThemeMenu open={open && visible} onClose={close} />
      </div>
    </div>
  )
}

/** Product presentation consumes real data and callbacks; it owns no business services or routing. */
export function ProductShell({
  children, immersive, identityName, spaces, spaceKey, onSpaceChange, onHome, onConnections, onModels, modelName,
}: ProductShellProps) {
  const { collapsed, toggle } = useShellNavigation()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const railVisible = collapsed && !immersive

  useLayoutEffect(() => {
    const active = document.activeElement
    if (!active?.closest('[inert]') || !mainRef.current?.parentElement?.contains(active)) return
    if (immersive) {
      const main = mainRef.current
      if (main) {
        main.tabIndex = -1
        main.focus({ preventScroll: true })
      }
    } else {
      toggleRef.current?.focus({ preventScroll: true })
    }
  }, [collapsed, immersive])

  return (
    <ShellFrame
      className="product-shell"
      collapsed={collapsed}
      immersive={immersive}
      mainRef={mainRef}
      navigation={
        <nav className="side-nav" aria-label="主导航">
          <button type="button" className="sidebtn" onClick={onHome}>
            <span className="navicon"><Icon name="home-2" size={20} /></span>首页
          </button>
          <div className="product-spaces" role="group" aria-label="学习空间">
            {spaces.map(space => (
              <button
                type="button"
                key={space.key}
                className={'sidebtn' + (space.key === spaceKey ? ' active' : '')}
                aria-pressed={space.key === spaceKey}
                title={space.label}
                onClick={() => onSpaceChange(space.key)}
              >
                <span className="navicon"><Icon name="user-rounded" size={20} /></span>
                <span className="product-space-label">{space.label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="sidebtn" onClick={onConnections}>
            <span className="navicon"><Icon name="link" size={20} /></span>学校连接
          </button>
          {onModels && <button type="button" className="sidebtn" aria-label="个人设置" title={modelName ? '个人设置 · 当前模型：' + modelName : '个人设置'} onClick={onModels}>
            <span className="navicon"><Icon name="model" size={20} /></span><span className="product-model-nav-label">个人设置{modelName && <small>{modelName}</small>}</span></button>}
        </nav>
      }
      bottom={
        <div className="side-bottom">
          <div className="product-identity" title={identityName}>
            <Icon name="user-rounded" size={20} />
            <span className="account-name">{identityName}</span>
          </div>
          <ProductThemeButton visible={!collapsed && !immersive} />
        </div>
      }
      toggle={
        <button
          type="button"
          className="sidebar-toggle"
          ref={toggleRef}
          onClick={toggle}
          aria-label="切换边栏"
          aria-expanded={!collapsed}
          title="切换边栏"
        >
          <Icon name="panel-left-close" size={18} />
        </button>
      }
      rail={<>
        <nav className="product-rail-nav" aria-label="主导航">
          <button type="button" className="railbtn" title="首页" aria-label="首页" onClick={onHome}>
            <Icon name="home-2" size={20} />
          </button>
          <div className="product-spaces" role="group" aria-label="学习空间">
            {spaces.map(space => (
              <button
                type="button"
                key={space.key}
                className={'railbtn' + (space.key === spaceKey ? ' active' : '')}
                aria-label={space.label}
                title={space.label}
                aria-pressed={space.key === spaceKey}
                onClick={() => onSpaceChange(space.key)}
              >
                {Array.from(space.label)[0]}
              </button>
            ))}
          </div>
          <button type="button" className="railbtn" title="学校连接" aria-label="学校连接" onClick={onConnections}>
            <Icon name="link" size={20} />
          </button>
          {onModels && <button type="button" className="railbtn" title="个人设置" aria-label="个人设置" onClick={onModels}><Icon name="model" size={20} /></button>}
        </nav>
        <div className="product-rail-bottom">
          <span className="railbtn product-rail-identity" role="img" title={identityName} aria-label={identityName}>
            <Icon name="user-rounded" size={20} />
          </span>
          <ProductThemeButton visible={railVisible} rail />
        </div>
      </>}
    >
      {children}
    </ShellFrame>
  )
}

export default ProductShell
