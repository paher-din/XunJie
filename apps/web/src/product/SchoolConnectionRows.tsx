import type { MouseEvent } from 'react'
import { Icon } from '../icons'

export function SchoolConnectionRow({ name, busy, onRebind, onDisconnect }: {
  name: string; busy: boolean
  onRebind?: (event: MouseEvent<HTMLButtonElement>) => void
  onDisconnect?: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return <div className="product-school-row">
    <div className="product-school-name"><span className="product-school-icon"><Icon name="link" size={18} /></span>
      <div><strong>{name}</strong><span className="product-school-status">已绑定</span></div></div>
    <div className="product-school-row-actions">
      {onRebind && <button type="button" className="product-school-rebind" disabled={busy} onClick={onRebind}>换绑学校</button>}
      {onDisconnect && <button type="button" className="product-school-disconnect" aria-label={`断开${name}的连接`} disabled={busy}
        onClick={onDisconnect}>断开连接</button>}
    </div>
  </div>
}

export function SchoolSessionRow({ busy, onLogout }: { busy: boolean; onLogout: () => void }) {
  return <div className="product-school-session"><span className="product-school-status">已登录此学校</span>
    <button type="button" className="outline" disabled={busy} onClick={onLogout}>{busy ? '正在退出…' : '退出学校登录'}</button>
  </div>
}
