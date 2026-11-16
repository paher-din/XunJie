// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useFluidHover, useRegisterFluidHoverItem } from './fluidHover'

it('measures positioned card wrappers in grid coordinates and follows all three cards', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const define = (element: HTMLElement, values: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(values)) Object.defineProperty(element, name, { configurable: true, value })
  }
  function Card({ index, register }: { index: number; register(index: number, el: HTMLElement | null): void }) {
    const ref = useRef<HTMLButtonElement>(null)
    useLayoutEffect(() => {
      const card = ref.current!, wrapper = card.parentElement!, grid = wrapper.parentElement!
      define(wrapper, { offsetParent: grid, offsetTop: index === 2 ? 108 : 16, offsetLeft: index === 1 ? 112 : 0 })
      define(card, { offsetParent: wrapper, offsetTop: 0, offsetLeft: 0, offsetWidth: 100, offsetHeight: 80 })
    }, [index])
    useRegisterFluidHoverItem(register, index, ref)
    return <div><button ref={ref}>卡片 {index}</button></div>
  }
  function Probe() {
    const ref = useRef<HTMLDivElement>(null)
    const hover = useFluidHover(ref)
    useLayoutEffect(() => { ref.current!.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect }, [])
    return <div ref={ref} {...hover.handlers} data-grid="">
      {[0, 1, 2].map(index => <Card key={index} index={index} register={hover.registerItem} />)}
      <output>{JSON.stringify({ active: hover.activeIndex, rects: hover.itemRects })}</output>
    </div>
  }
  const waitFor = async (check: () => void) => {
    for (let i = 0; i < 100; i++) {
      try { check(); return } catch (error) { if (i === 99) throw error }
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
  }
  const state = () => JSON.parse(host.querySelector('output')!.textContent!)
  try {
    await act(async () => root.render(<Probe />))
    await waitFor(() => expect(state().rects).toEqual([
      { left: 0, top: 16, width: 100, height: 80 },
      { left: 112, top: 16, width: 100, height: 80 },
      { left: 0, top: 108, width: 100, height: 80 },
    ]))
    for (const [index, x, y] of [[0, 130, 96], [1, 242, 96], [2, 130, 188]]) {
      await act(async () => host.querySelector('[data-grid]')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })))
      await waitFor(() => expect(state().active).toBe(index))
    }
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
