// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DashboardSection, type DashboardLayout } from './index'

it('正式看板通过受控布局移出／添加组件，不读写布局存储', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const get = vi.spyOn(Storage.prototype, 'getItem'), set = vi.spyOn(Storage.prototype, 'setItem')
  const change = vi.fn()
  const node = document.createElement('div'); document.body.append(node)
  const root = createRoot(node)
  function Host() {
    const [layout, setLayout] = useState<DashboardLayout>({ board: ['progress'], tray: ['heat'] })
    return <DashboardSection data={{}} tasks={null} taskCount={2} now={new Date('2026-11-08T00:00:00Z')}
      layout={layout} onLayoutChange={next => { change(next); setLayout(next) }}
      periodLabel="本周期" editHint="由宿主保存排布" continueSlot={<button>继续任务</button>} />
  }
  try {
    act(() => root.render(<Host />))
    expect(node.textContent).toContain('完成进度暂无统计')
    expect(node.textContent).toContain('继续任务')
    act(() => (node.querySelector('.db-edit-btn') as HTMLButtonElement).click())
    act(() => (node.querySelector('.db-rm') as HTMLButtonElement).click())
    expect(change).toHaveBeenLastCalledWith({ board: [], tray: ['heat', 'progress'] })
    expect(node.querySelector('.dash-grid')?.children).toHaveLength(0)
    act(() => (node.querySelector('.t-item button') as HTMLButtonElement).click())
    expect(change).toHaveBeenLastCalledWith({ board: ['heat'], tray: ['progress'] })
    expect(node.querySelector('.db-tabs')?.textContent).toContain('每日每周')
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount()); node.remove(); get.mockRestore(); set.mockRestore()
  }
})
