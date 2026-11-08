export interface ModelConfigActionsProps {
  saving: boolean
  enabled: boolean
  reloadDisabled: boolean
  toggleDisabled: boolean
  onReload: () => void
  onToggle: () => void
}

/** Configuration actions only; acknowledged state and persistence belong to the adapter. */
export function ModelConfigActions({ saving, enabled, reloadDisabled, toggleDisabled, onReload, onToggle }: ModelConfigActionsProps) {
  return <>
    <button className="outline" disabled={reloadDisabled} onClick={onReload}>
      重新读取配置
    </button>
    <button className="primary" disabled={toggleDisabled} onClick={onToggle}>
      {saving ? '保存中…' : enabled ? '停用个人模型' : '启用个人模型'}
    </button>
  </>
}
