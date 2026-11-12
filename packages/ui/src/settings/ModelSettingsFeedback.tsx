import type { ModelSettingsFeedbackData } from './types'

export interface ModelSettingsFeedbackProps {
  data: ModelSettingsFeedbackData | null
  loading: boolean
  saving: boolean
  error: string
  savedRevision: number | null
}

/** One stable status slot, with current configuration retained on save failure. */
export function ModelSettingsFeedback({ data, loading, saving, error, savedRevision }: ModelSettingsFeedbackProps) {
  const current = data ? (data.enabled ? '个人模型已启用' : '个人模型未启用') : '尚未读取模型配置'
  const failed = !loading && !saving && Boolean(error)
  const message = loading || saving ? ''
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
