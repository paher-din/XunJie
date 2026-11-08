import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageTaskCard } from './chat'
import { TaskInfo, TaskProgress } from './workspace'

describe('旧版组件复用边界', () => {
  it('进度未知的任务不显示虚构进度，任务信息只有显式传入时显示演示说明', () => {
    const card = renderToStaticMarkup(<MessageTaskCard status="已分配" title="任务"
      metadata={['完成状态未知']} onOpen={() => {}} />)
    expect(card).toContain('完成状态未知')
    expect(card).not.toContain('class="progress"')

    const info = renderToStaticMarkup(<TaskInfo name="任务" status="进行中" goal="目标" percent={25}
      done={false} currentProgress="第一步" stage="1 / 4" deadline="无" course="课程" />)
    expect(info).not.toContain('ws-demo-flag')
  })

  it('多个任务进度环分别引用自身的渐变', () => {
    const html = renderToStaticMarkup(<>
      <TaskProgress percent={25} done={false} status="进行中" title="第一项" ariaLabel="第一项进度" />
      <TaskProgress percent={100} done status="已完成" title="第二项" ariaLabel="第二项进度" />
    </>)
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1])
    const targets = [...html.matchAll(/stroke="url\(#([^)]*)\)"/g)].map(match => match[1])
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(targets).toEqual([ids[0], ids[3]])
  })
})
