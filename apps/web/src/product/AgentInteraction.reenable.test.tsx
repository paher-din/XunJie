// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { AgentInteractionSettings, useAgentInteraction } from './AgentInteraction'

const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), name: '测试者', kind: 'personal' }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!
let root: Root, host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => { root.unmount(); await settle() }); host.remove(); vi.unstubAllGlobals() })

it('keeps the confirmed send mode on re-entering the agent pane instead of blanking into a reading state', async () => {
  let reads = 0, release: (() => void) | undefined
  vi.stubGlobal('fetch', vi.fn(() => {
    reads++
    return reads === 1 ? Promise.resolve(response({ version: 1, busyInputMode: 'steering' }))
      : new Promise<Response>(resolve => { release = () => resolve(response({ version: 1, busyInputMode: 'steering' })) })
  }))
  function Harness() {
    const [enabled, setEnabled] = useState(true)
    const controller = useAgentInteraction(identity, 'personal', 'test', true, enabled)
    return createElement('div', null,
      createElement('button', { onClick: () => setEnabled(false) }, '离开'),
      createElement('button', { onClick: () => setEnabled(true) }, '返回'),
      createElement(AgentInteractionSettings, { controller }))
  }
  await act(async () => { root.render(createElement(Harness)); await settle() })
  expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain('引导当前任务')
  await act(async () => { button('离开').click(); await settle() })
  // Return while the background reread is still pending: the choice must stay on screen, not a reading placeholder.
  await act(async () => { button('返回').click(); await settle() })
  expect(release).toBeTypeOf('function')
  expect(host.textContent).not.toContain('正在读取发送方式')
  expect(host.textContent).not.toContain('正在重新读取发送方式')
  expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain('引导当前任务')
  await act(async () => { release!(); await settle() })
  expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain('引导当前任务')
})