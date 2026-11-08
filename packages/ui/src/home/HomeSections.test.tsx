// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { CourseBreadcrumb, HomeCourseRegion, HomeSectionHeading, HomeStatus, HomeTaskCard, PreparationEntryCard } from './HomeSections'

it('面包屑保留键盘来源，课程区和标题保留定位／焦点 ref 与刷新回调', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
  const region = createRef<HTMLDivElement>(), heading = createRef<HTMLHeadingElement>(), back = vi.fn(), refresh = vi.fn()
  try {
    act(() => root.render(<HomeCourseRegion selected regionRef={region}>
      <HomeSectionHeading title="课程与任务" count="2 个任务" headingRef={heading} refresh={{ disabled: false, onRefresh: refresh }} />
      <CourseBreadcrumb title="课程" onBack={back} />
    </HomeCourseRegion>))
    expect(region.current).toBe(node.querySelector('.course-region[data-course-selected="true"]'))
    act(() => heading.current!.focus())
    expect(document.activeElement).toBe(heading.current)
    const button = node.querySelector('.course-breadcrumb button')!
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })))
    expect(back).toHaveBeenLastCalledWith(true)
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })))
    expect(back).toHaveBeenLastCalledWith(false)
    act(() => (node.querySelector('.outline') as HTMLButtonElement).click())
    expect(refresh).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); node.remove() }
})

it('首页状态与任务内容保留空／失败语义、徽标和可选进度差异', () => {
  const pending = renderToStaticMarkup(<HomeStatus kind="loading" message="读取中" />)
  const error = renderToStaticMarkup(<HomeStatus kind="error" message="失败" retry={{ disabled: true, onRetry() {} }} />)
  expect(pending).toBe('<p role="status">读取中</p>')
  expect(error).toBe('<div class="empty" role="alert"><p>失败</p><button type="button" disabled="">重试</button></div>')
  const props = { title: '任务', status: '已分配' as const, action: '进入任务', onOpen() {} }
  const unknown = renderToStaticMarkup(<HomeTaskCard {...props} />)
  expect(unknown).toContain('task-card-without-progress')
  expect(unknown).not.toContain('progresslabel')
  const known = renderToStaticMarkup(<HomeTaskCard {...props} overdue progress={{ percent: 0, done: false }} footer="截止日期" />)
  expect(known).toContain('<span class="status overdue">已逾期</span>')
  expect(known).toContain('<div class="progresslabel"><span>任务进度</span><span>0%</span></div>')
  expect(known).toContain('width:0%')
  expect(known).toContain('截止日期')
  const entry = renderToStaticMarkup(<PreparationEntryCard flag="来源" title="标题" description="目标" note="说明" action="进入" onOpen={() => {}} />)
  expect(entry).toContain('class="prep-entry-body"')
  expect(entry).toContain('<p class="prep-entry-note">说明</p>')
})
