import { Field, TextInput } from './controls'

/** Shared supplier presentation: both controllers supply values and persistence; no Session/store/API. */
export function ProviderIdentityFields({ name, baseUrl, apiKey, hasKey, errors = {}, onName, onBaseUrl, onApiKey }: {
  name: string; baseUrl: string; apiKey: string; hasKey?: boolean | undefined
  errors?: { name?: string | undefined; baseUrl?: string | undefined }
  onName(value: string): void; onBaseUrl(value: string): void; onApiKey(value: string): void
}) {
  return <>
    <Field label="名称" error={errors.name}><TextInput aria-label="连接名称" value={name} placeholder="例如：DeepSeek 官方" onChange={event => onName(event.target.value)} /></Field>
    <Field label="Base URL" tip="SDK 的基础地址；协议路径单独显示" error={errors.baseUrl}>
      <TextInput aria-label="Base URL" value={baseUrl} placeholder="https://api.example.com/v1" className="st-mono-input" onChange={event => onBaseUrl(event.target.value)} />
    </Field>
    <Field label="API Key" tip={hasKey ? '已加密保存；留空保留，填写后替换' : '仅由所属服务保管，读取不返回密钥'}>
      <TextInput aria-label="API Key" type="password" autoComplete="off" value={apiKey} placeholder="sk-…" className="st-mono-input" onChange={event => onApiKey(event.target.value)} />
    </Field>
  </>
}

import type { ComponentProps } from 'react'
export type ProviderIdentityFieldsProps = ComponentProps<typeof ProviderIdentityFields>
