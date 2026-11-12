// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SproutMascot } from '@xunjie/ui/brand'
import type { SproutTool } from '@xunjie/ui/brand'

let root: Root, host: HTMLDivElement
let holdPencil: boolean, releasePencil: (() => void) | undefined
beforeEach(() => {
  holdPencil = false; releasePencil = undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Image', class {
    src = ''
    decode() {
      return holdPencil && this.src.includes('pencil') ? new Promise<void>(resolve => { releasePencil = resolve }) : Promise.resolve()
    }
  })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { releasePencil?.(); root.unmount() })
  host.remove(); vi.unstubAllGlobals()
})

const render = async (tool: SproutTool) => {
  await act(async () => { root.render(<SproutMascot tool={tool} textureSize="compact" />) })
  await act(async () => { await vi.dynamicImportSettled() })
}

it('retains the ready character across deferred accessory loading and drops a superseded tool change', async () => {
  await render('none')
  expect(host.querySelector('svg')?.getAttribute('data-rig-ready')).toBe('true')
  expect(host.querySelector('[data-accessory]')).toBeNull()
  await render('glasses')
  expect(host.querySelector('svg')?.getAttribute('data-tool')).toBe('glasses')
  expect(host.querySelector('[data-accessory="glasses-v1.png"]')).not.toBeNull()
  await render('chalk')
  expect(host.querySelector('svg')?.getAttribute('data-tool')).toBe('chalk')
  expect(host.querySelectorAll('[data-accessory="chalk-v1.png"]').length).toBeGreaterThan(0)
  holdPencil = true
  await act(async () => {
    root.render(<SproutMascot tool="pencil" textureSize="compact" />)
    await vi.dynamicImportSettled()
  })
  await render('none')
  await act(async () => { releasePencil?.() })
  expect(host.querySelector('svg')?.getAttribute('data-tool')).toBe('none')
  expect(host.querySelector('svg')?.getAttribute('data-rig-ready')).toBe('true')
})
