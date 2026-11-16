import { Icon } from '../icons'
import './material-picker.css'

export interface MaterialPickerItem { id: string; name: string; detail?: string; onOpen(): void; disabled?: boolean }
export interface MaterialPickerProps {
  title: string; groups: { title: string; items: MaterialPickerItem[] }[]
  loading?: boolean; error?: string; busy?: boolean
  empty: string; addLabel: string; onAdd(): void; canAdd?: boolean; onRefresh(): void
}
/** Stateless list shared by reading tools; material identity and reading stay with callers. */
export function MaterialPicker({ title, groups, loading, error, busy, empty, addLabel, onAdd, canAdd = true, onRefresh }: MaterialPickerProps) {
  const hasItems = groups.some(group => group.items.length)
  return <div className="ui-material-picker">
    <div className="ui-material-picker-head"><h2>{title}</h2><button type="button" className="ws-btn ghost" disabled={!canAdd || busy} onClick={onAdd}>{addLabel}</button></div>
    <p className="ui-material-hint">选择一份材料开始阅读。</p>
    {loading && <p role="status">正在读取材料列表…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="ws-btn ghost" disabled={loading || busy} onClick={onRefresh}>重试读取列表</button></div>}
    {!loading && !error && !hasItems && <p className="ui-material-hint">{empty}</p>}
    {groups.filter(group => group.items.length).map(group => <section key={group.title} aria-label={group.title}>
      <h3>{group.title}</h3><ul className="ui-material-rows">{group.items.map(item => <li key={item.id}>
        <Icon name="file-text" size={20} /><div><strong>{item.name}</strong>{item.detail && <span>{item.detail}</span>}</div>
        <button type="button" className="ws-btn ghost" disabled={busy || item.disabled} aria-label={`打开 ${item.name}`} onClick={item.onOpen}>打开</button>
      </li>)}</ul>
    </section>)}
    <button type="button" className="ws-btn ghost" disabled={loading || busy} onClick={onRefresh}>刷新材料列表</button>
  </div>
}
