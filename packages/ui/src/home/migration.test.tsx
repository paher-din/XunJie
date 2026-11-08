// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContinueTaskCard, TaskToolbar } from './index'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('公开工具栏保留受控筛选、清除回调和输入焦点', () => {
  const onFilter = vi.fn(), onQuery = vi.fn()
  act(() => root.render(<TaskToolbar filters={['全部', '进行中']} value="进行中" query="原问题" onFilter={onFilter} onQuery={onQuery} />))
  expect(container.querySelector('.filter.active')?.textContent).toBe('进行中')
  act(() => (container.querySelector('.filter') as HTMLButtonElement).click())
  expect(onFilter).toHaveBeenCalledWith('全部')
  act(() => (container.querySelector('.search-clear') as HTMLButtonElement).click())
  expect(onQuery).toHaveBeenCalledWith('')
  expect(document.activeElement).toBe(container.querySelector('input'))
})

it('继续任务卡保留缺失与空描述、任务说明与百分比的 DOM 差异', () => {
  const props = { tag: '课程', title: '任务', action: '进入任务', onOpen: () => {} }
  const real = renderToStaticMarkup(<ContinueTaskCard {...props} meta="当前获准任务" metaClassName="db-side" />)
  const prep = renderToStaticMarkup(<ContinueTaskCard {...props} description="" meta="25%" metaClassName="pct" />)
  expect(real).not.toContain('<p>')
  expect(real).toContain('<span class="db-side">当前获准任务</span>')
  expect(prep).toContain('<p></p>')
  expect(prep).toContain('<span class="pct">25%</span>')
  expect(prep).not.toContain('progress')
})
