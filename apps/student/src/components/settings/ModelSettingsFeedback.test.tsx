import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelSettingsFeedback } from './ModelSettingsFeedback'

const data = { revision: 4, enabled: false, callsEnabled: true }
const base = { data, loading: false, saving: false, error: '', savedRevision: null }
const render = (patch: Partial<Parameters<typeof ModelSettingsFeedback>[0]> = {}) =>
  renderToStaticMarkup(<ModelSettingsFeedback {...base} {...patch} />)

describe('model settings feedback preserves confirmed state', () => {
  it('shows success only for the acknowledged current revision', () => {
    expect(render()).not.toContain('已保存')
    expect(render({ savedRevision: 4 })).toContain('已保存 · 个人模型未启用')
    expect(render({ savedRevision: 3 })).not.toContain('已保存')
    expect(render({ savedRevision: 4, saving: true })).not.toContain('已保存')
    expect(render({ savedRevision: 4, loading: true })).not.toContain('已保存')
  })

  it('keeps the last confirmed configuration and error instead of claiming success', () => {
    const result = render({ savedRevision: 4, error: '保存未确认，请重新读取后再试。' })
    expect(result).toContain('role="alert"')
    expect(result).toContain('个人模型未启用 · 保存未确认')
    expect(result).not.toContain('已保存')
  })

  it('does not interpret missing configuration as disabled, or hide an administrator restriction', () => {
    expect(render({ data: null, error: '读取失败' })).toContain('尚未读取模型配置 · 读取失败')
    for (const patch of [{}, { saving: true }, { loading: true }, { error: '保存未确认' }]) {
      expect(render({ ...patch, data: { ...data, enabled: true, callsEnabled: false } }))
        .toContain('管理员已停用模型调用')
    }
  })
})
