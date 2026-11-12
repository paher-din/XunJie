// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductSettings, type ProductSettingsProps } from './ProductSettings'
import { ProductProfile } from './ProductProfile'

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button).toBeDefined()
  button!.click()
})
const renderSettings = async (props: Partial<ProductSettingsProps> = {}) => act(async () => {
  root.render(<ProductSettings accountName="未登录" onBack={() => {}} schoolControls={null} modelSettings={null} {...props} />)
})

it('keeps model drafts and pending operations mounted through category switches and parent updates', async () => {
  let mounts = 0, unmounts = 0, finish: () => void = () => {}
  const completion = new Promise<void>(resolve => { finish = resolve })
  function Models() {
    const [status, setStatus] = useState('等待检查')
    useEffect(() => { mounts++; return () => { unmounts++ } }, [])
    return <><input aria-label="模型草稿" defaultValue="" />
      <button type="button" onClick={() => { void completion.then(() => setStatus('检查已完成')) }}>检查</button>
      <output>{status}</output></>
  }
  await renderSettings({ initialTab: 'models', modelSettings: <Models /> })
  const draft = host.querySelector<HTMLInputElement>('[aria-label="模型草稿"]')!
  draft.value = '未保存的模型地址'
  await click('检查')
  await click('账户')
  const models = draft.closest<HTMLElement>('.product-settings-pane')!
  expect(models.hidden).toBe(true)
  expect(models.hasAttribute('inert')).toBe(true)
  await act(async () => { finish(); await completion })
  await renderSettings({ initialTab: 'models', accountName: '已核对的身份', modelSettings: <Models /> })
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('账户')
  await click('模型')
  expect(host.querySelector('[aria-label="模型草稿"]')).toBe(draft)
  expect(draft.value).toBe('未保存的模型地址')
  expect(models.hidden).toBe(false)
  expect(models.hasAttribute('inert')).toBe(false)
  expect(models.textContent).toContain('检查已完成')
  expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 })
})

it('supports school sign-in without an identity or models, preserving the supplied form and callbacks', async () => {
  const login = vi.fn(), onBack = vi.fn()
  await renderSettings({ initialTab: 'account', onBack,
    schoolControls: <form onSubmit={event => { event.preventDefault(); login(new FormData(event.currentTarget).get('account')) }}>
      <label>学校账号<input name="account" /></label><button type="submit">登录此学校</button>
    </form> })
  const account = host.querySelector<HTMLInputElement>('[name="account"]')!
  account.value = 'school-user'
  await click('模型')
  expect(host.querySelector('.product-settings-model')?.textContent).toContain('个人设置暂不可用')
  await click('账户')
  expect(host.querySelector('[name="account"]')).toBe(account)
  await click('登录此学校')
  expect(login).toHaveBeenCalledWith('school-user')
  await click('返回学习空间')
  expect(onBack).toHaveBeenCalledOnce()
})

it('shows only the supplied profile identity and restores focus after Escape', async () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const onClose = vi.fn(() => root.render(null))
  await act(async () => root.render(<ProductProfile accountName="真实身份" schoolName="真实学校" onClose={onClose} onSettings={() => {}} />))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.textContent).toContain('真实身份')
  expect(dialog.querySelector('dl')?.textContent).toBe('学校真实学校')
  expect(dialog.textContent).toContain('暂无画像信息')
  expect(dialog.textContent).not.toMatch(/学习进度|编辑资料|学号|学期/)
  expect(dialog.contains(document.activeElement)).toBe(true)
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
