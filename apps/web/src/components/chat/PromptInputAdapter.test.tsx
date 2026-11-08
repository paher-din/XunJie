// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PromptInput } from '../PromptInput'
import { saveModelSettings } from '../../lib/modelSettings'

vi.mock('../../workspace/mode', () => ({ PREP_BUILD: false }))
vi.mock('../../lib/modelSettings', () => ({
  useModelSettings: () => ({ data: { defaultModelId: 'one', enabled: true, callsEnabled: true, efforts: { one: '高' } }, loading: false, saving: false, error: '' }),
  personalModelOptions: () => [{ id: 'one', name: '模型一', note: '', icon: 'model' }, { id: 'two', name: '模型二', note: '', icon: 'model' }],
  reasoningOptions: () => ['低', '高'], saveModelSettings: vi.fn(async () => {}),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('旧适配器保留发送未接纳时的附件，确认接纳后才释放；模型修改仍走旧 store', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
  const NativeURL = URL
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = vi.fn(() => 'blob:preview'); static revokeObjectURL = revoke })
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  const onSend = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  try {
    act(() => root.render(<PromptInput value=" 原问题 " onChange={() => {}} onSend={onSend} showContextRing={false} />))
    const input = node.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'image.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(node.querySelectorAll('.prompt-tile')).toHaveLength(1)
    await act(async () => { node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onSend).toHaveBeenLastCalledWith('原问题', [expect.objectContaining({ file, name: 'image.png', src: 'blob:preview' })])
    expect(node.querySelector('.prompt-tile')).not.toBeNull()
    expect(revoke).not.toHaveBeenCalled()
    act(() => (node.querySelector('[aria-label="切换模型"]') as HTMLButtonElement).click())
    await act(async () => { (node.querySelectorAll('.prompt-model-item')[1] as HTMLElement).click() })
    expect(saveModelSettings).toHaveBeenCalledWith({ defaultModelId: 'two' })
    await act(async () => { node.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(node.querySelector('.prompt-tile')).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:preview')
  } finally { act(() => root.unmount()); node.remove() }
})
