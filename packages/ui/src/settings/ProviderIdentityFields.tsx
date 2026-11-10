import { useId, useState } from 'react'
import { Icon } from '../icons'
import { Field, Seg, TextInput } from './controls'

/** Shared supplier presentation: both controllers supply values and persistence; no Session/store/API. */
export function ProviderIdentityFields({ name, baseUrl, apiKey, hasKey, errors = {}, protocol, snapshotCredential = false,
  apiKeyDisabled = false, baseUrlReadOnly = false, onBaseUrlBlur, onApiKeyBlur, onName, onBaseUrl, onApiKey }: {
  name: string; baseUrl: string; apiKey: string; hasKey?: boolean | undefined
  errors?: { name?: string | undefined; baseUrl?: string | undefined }
  protocol?: { value: string; options: Array<{ value: string; label: string }>; placeholder: string; onChange(value: string): void }
  snapshotCredential?: boolean; apiKeyDisabled?: boolean
  baseUrlReadOnly?: boolean
  onBaseUrlBlur?(): void
  onApiKeyBlur?(): void
  onName(value: string): void; onBaseUrl(value: string): void; onApiKey(value: string): void
}) {
  const [visible, setVisible] = useState(false)
  const baseUrlErrorId = useId()
  return <>
    <Field label="名称" error={errors.name}><TextInput aria-label="连接名称" value={name} placeholder="例如：DeepSeek 官方" onChange={event => onName(event.target.value)} /></Field>
    <Field label="Base URL" tip={baseUrlReadOnly ? '预设按模型自动匹配地址与协议；如需修改地址，请选择自定义供应商' : '填写基础地址，系统按协议追加接口路径'} error={errors.baseUrl} errorId={baseUrlErrorId}>
      {protocol && <div className="st-provider-protocol"><Seg ariaLabel="协议" options={protocol.options} value={protocol.value} onChange={protocol.onChange} /></div>}
      <TextInput aria-label="Base URL" aria-invalid={Boolean(errors.baseUrl)} aria-describedby={errors.baseUrl ? baseUrlErrorId : undefined}
        value={baseUrl} placeholder={protocol?.placeholder ?? 'https://api.example.com/v1'} className="st-mono-input"
        readOnly={baseUrlReadOnly} onBlur={onBaseUrlBlur} onChange={event => onBaseUrl(event.target.value)} />
    </Field>
    <Field label="API Key" tip={snapshotCredential ? '保存输入框中的当前密钥；清空后保存即可移除密钥' : hasKey ? '已加密保存；留空保留，填写后替换' : '仅由所属服务保管，读取不返回密钥'}>
      <div className="st-secret-input">
        <TextInput aria-label="API Key" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} disabled={apiKeyDisabled}
          value={apiKey} placeholder={apiKeyDisabled ? '正在读取已保存的密钥…' : 'sk-…'} className="st-mono-input" onBlur={onApiKeyBlur} onChange={event => onApiKey(event.target.value)} />
        <button type="button" className="st-secret-reveal" aria-label={visible ? '隐藏 API Key' : '显示 API Key'} aria-pressed={visible}
          disabled={apiKeyDisabled} onMouseDown={event => event.preventDefault()} onClick={() => setVisible(value => !value)}><Icon name="eye" size={18} /></button>
      </div>
    </Field>
  </>
}

import type { ComponentProps } from 'react'
export type ProviderIdentityFieldsProps = ComponentProps<typeof ProviderIdentityFields>
