// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ModelAttempt, ModelConnection, ModelProvider } from '@xunjie/contracts/model-connections'
import { ModelTab } from './ModelTab'

const connection: ModelConnection = {
  connectionId: crypto.randomUUID(), name: '示例连接', baseUrl: 'https://example.invalid/v1',
  protocol: 'chat-completions', path: '/chat/completions', modelId: 'example-model', dialect: 'standard',
  parameterMode: 'plain', enabled: true, version: 1, routeId: crypto.randomUUID(), hasCredential: true,
  adapterState: 'ready', capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' },
}
const provider: ModelProvider = {
  providerId: connection.connectionId, version: 1, name: '示例供应商', baseUrl: connection.baseUrl,
  protocol: connection.protocol, enabled: true, hasCredential: true, models: [connection],
}

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(props: Partial<React.ComponentProps<typeof ModelTab>> = {}) {
  const defaults: React.ComponentProps<typeof ModelTab> = {
    providers: [], attempts: [] as ModelAttempt[], loading: false, error: '', toggleState: {},
    onToggle: vi.fn(), onNew: vi.fn(), onEdit: vi.fn(), onAddModel: vi.fn(), onCheck: vi.fn(),
  }
  await act(async () => root.render(<ModelTab {...defaults} {...props} />))
}

it('separates initial loading from a genuinely empty model list', async () => {
  await render({ loading: true })
  expect(host.textContent).toContain('正在读取模型配置')
  expect(host.textContent).not.toContain('还没有可用模型')

  const onNew = vi.fn()
  await render({ onNew })
  expect(host.textContent).toContain('还没有可用模型')
  await act(async () => host.querySelector<HTMLButtonElement>('.product-provider-add-empty')!.click())
  expect(onNew).toHaveBeenCalledOnce()
})

it('keeps cached providers visible when a refresh fails and exposes the recovery action', async () => {
  const onRetry = vi.fn()
  await render({ providers: [provider], recoveryError: '暂时无法连接原服务，请稍后重试。', onRetry })
  expect(host.textContent).toContain('示例供应商')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('模型配置可能不是最新')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法连接原服务')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '重新读取配置')!.click())
  expect(onRetry).toHaveBeenCalledOnce()
})

it('marks the whole surface read-only and disables every mutation entry', async () => {
  await render({ providers: [provider], readOnly: true })
  expect(host.textContent).toContain('当前学习空间为只读')
  expect(host.querySelector<HTMLButtonElement>('.product-provider-add')?.disabled).toBe(true)
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '编辑')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="启用供应商 示例供应商"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="启用模型 example-model"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="模型测试"]')?.disabled).toBe(true)
})

it('exposes provider switch progress to assistive technology and explains an unknown receipt', async () => {
  await render({ providers: [provider], toggleState: { [provider.providerId]: 'saving' } })
  expect(host.querySelector('.st-provider')?.getAttribute('aria-busy')).toBe('true')
  expect(host.querySelector('.st-provider-save-state')?.textContent).toBe('正在保存开关…')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="启用供应商 示例供应商"]')?.disabled).toBe(true)

  await render({ providers: [provider], toggleState: { [provider.providerId]: 'unknown' } })
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('开关结果未确认')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === '核对开关提交')?.disabled).toBe(false)
})

it('explains why a saved provider or model cannot be tested', async () => {
  const noCredential = { ...connection, hasCredential: false }
  const noKeyProvider = { ...provider, hasCredential: false, models: [noCredential] }
  await render({ providers: [noKeyProvider], onConnectionTest: vi.fn() })
  expect(host.textContent).toContain('尚未保存 API Key；连接测试和模型测试暂不可用。')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="模型测试"]')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('[aria-label="连接测试"]')?.disabled).toBe(true)

  await render({ providers: [{ ...provider, enabled: false }], onConnectionTest: vi.fn() })
  expect(host.textContent).toContain('供应商已停用；启用后才能测试模型并用于新对话。')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="模型测试"]')?.disabled).toBe(true)

  await render({ providers: [{ ...noKeyProvider, models: [] }], onConnectionTest: vi.fn() })
  expect(host.querySelector('.st-provider-empty')).toBeNull()
})

it('explains a school policy that does not allow model checks', async () => {
  await render({ schoolModels: [{ kind: 'school', connection,
    policy: { checksAllowed: false, maxChecksPerHour: 0, maxOutputTokens: 64, timeoutMs: 10000 } }], onSchoolCheck: vi.fn() })
  expect(host.textContent).toContain('学校未开放这个模型的测试。')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="模型测试"]')?.disabled).toBe(true)
})

it('keeps a passed connection result in the provider card', async () => {
  const onConnectionTest = vi.fn(async () => ({ status: 'passed' as const, baseUrl: provider.baseUrl,
    protocol: provider.protocol, endpoint: provider.baseUrl + '/chat/completions', elapsedMs: 12 }))
  await render({ providers: [provider], onConnectionTest })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[aria-label="连接测试"]')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(host.textContent).toContain('连接测试通过')
})

it('moves restart to the original test action after a stopped test', async () => {
  const onCheck = vi.fn()
  await render({ providers: [provider], onCheck, tests: { [connection.connectionId]: {
    status: 'cancelled', title: '模型测试已停止', runId: 'run-1', configurationPassed: true,
  } } })
  expect(host.textContent).toContain('模型测试已停止')
  expect(host.querySelector('.st-model-test-action')).toBeNull()
  const restart = host.querySelector<HTMLButtonElement>('[aria-label="重新测试模型"]')!
  expect(restart).not.toBeNull()
  await act(async () => restart.click())
  expect(onCheck).toHaveBeenCalledWith(connection)
})
