import type { PersonalModelSettings } from '../../lib/modelSettings'

interface Props {
  data: Pick<PersonalModelSettings, 'revision' | 'enabled' | 'callsEnabled'> | null
  loading: boolean
  saving: boolean
  error: string
  savedRevision: number | null
}

/** One stable status slot, with current configuration retained on save failure. */
export function ModelSettingsFeedback({ data, loading, saving, error, savedRevision }: Props) {
  const current = data ? (data.enabled ? '个人模型已启用' : '个人模型未启用') : '尚未读取模型配置'
  const failed = !loading && !saving && Boolean(error)
  const message = loading ? '正在读取配置…'
    : saving ? `正在保存… · ${current}`
    : failed ? `${current} · ${error}`
    : data && savedRevision === data.revision ? `已保存 · ${current}`
    : current

  return (
    <p className="st-model-feedback" role={failed ? 'alert' : 'status'} aria-atomic="true" data-status={failed ? 'error' : undefined}>
      {message}
      {data && !data.callsEnabled ? ' · 管理员已停用模型调用' : ''}
    </p>
  )
}
