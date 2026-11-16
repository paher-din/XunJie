// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileStripView } from '@xunjie/ui/workspace'
import { ActivityCardMenu, LearningTaskCard } from '@xunjie/ui/home'
import { ProductActivityList } from './ProductActivityList'
import { PdfMaterials, type PdfMaterialsController } from './PdfMaterials'
import type { CourseMaterial } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'

let host: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const click = async (label: string) => act(async () => {
  const button = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label)
  if (!button) throw Error('missing button ' + label)
  button.click()
})
const input = async (value: string) => act(async () => {
  const field = host.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

it('closes a view without deleting its file and permits reopening from the file menu', async () => {
  const remove = vi.fn(() => null)
  function Probe() {
    const [open, setOpen] = useState(true)
    const files = [{ id: 'stable-id', name: 'main.c' }]
    return <FileStripView files={files} openFiles={open ? files : []} activeId={open ? 'stable-id' : null}
      onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onDelete={remove} onCreate={() => null} onRename={() => null} onExport={() => {}} />
  }
  await act(async () => root.render(<Probe />))
  await click('关闭 main.c 的标签')
  expect(host.textContent).toContain('没有打开的文件')
  expect(remove).not.toHaveBeenCalled()
  await click('文件1'); await click('main.c')
  expect(host.querySelector('[aria-label="关闭 main.c 的标签"]')).not.toBeNull()
})

it('keeps rename errors in place and requires confirmation before attempting deletion', async () => {
  const rename = vi.fn(() => '名称已存在'), remove = vi.fn(() => '删除失败，原内容保留')
  await act(async () => root.render(<FileStripView files={[{ id: 'stable-id', name: 'main.c' }]} openFiles={[]} activeId={null}
    onOpen={() => {}} onClose={() => {}} onRename={rename} onDelete={remove} onCreate={() => null} onExport={() => {}} />))
  await click('文件1'); await click('管理 main.c'); await click('重命名')
  await input('other.c'); await click('确认改名')
  expect(rename).toHaveBeenCalledWith('stable-id', 'other.c')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('名称已存在')
  expect(host.querySelector('input')?.value).toBe('other.c')
  await click('取消'); await click('管理 main.c'); await click('删除')
  expect(remove).not.toHaveBeenCalled()
  await click('取消'); expect(remove).not.toHaveBeenCalled()
  await click('文件1'); await click('管理 main.c'); await click('删除'); await click('删除文件')
  expect(remove).toHaveBeenCalledWith('stable-id')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('原内容保留')
})

it('shows a course PDF before it has a document record and opens it by material identity', async () => {
  const openCourse = vi.fn()
  const pdf = { document: null, reading: null, documents: [], loading: false, busy: false, writable: true,
    loadError: '', showList: false, setShowList: vi.fn(), openCourse, refresh: vi.fn(), chooseUpload: vi.fn() } as unknown as PdfMaterialsController
  await act(async () => root.render(<PdfMaterials pdf={pdf} onBack={() => {}}
    courseMaterials={[{ materialId: 'course-pdf', title: '实验指南.pdf', mediaType: 'application/pdf' } as CourseMaterial]} />))
  expect(host.textContent).toContain('课程 PDF')
  await click('打开 实验指南.pdf')
  expect(openCourse).toHaveBeenCalledWith('course-pdf')
})

it('filters real closed states without presenting them as completion or inventing progress', async () => {
  const activities = [{ activityId: 'a', status: 'open', goal: '进行中的问题', question: '', createdAt: '2026-01-02' },
    { activityId: 'b', status: 'closed', goal: '已关闭的问题', question: '', createdAt: '2026-01-01' }] as LearningActivity[]
  await act(async () => root.render(<ProductActivityList activities={activities} onOpen={() => {}} />))
  await click('已关闭')
  expect(host.querySelector('[data-activity-id="a"]')).toBeNull()
  expect(host.querySelector('[data-activity-id="b"]')).not.toBeNull()
  expect(host.textContent).not.toContain('已完成')
  expect(host.querySelector('.progresslabel')).toBeNull()
  await input('找不到'); expect(host.textContent).toContain('没有符合条件')
  await click('清除筛选'); expect(host.querySelectorAll('[data-activity-id]')).toHaveLength(2)
})

const chooseMenu = async (label: string) => act(async () => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === label)
  if (!item) throw Error('missing menu item ' + label)
  item.click(); await new Promise(resolve => setTimeout(resolve, 0))
})

it('groups activities by course identity even when course names are equal', async () => {
  const activities = [
    { activityId: 'a', status: 'open', goal: '活动甲', createdAt: '2026-01-02', course: { courseId: 'c1', courseName: '同名课程', objectives: [] } },
    { activityId: 'b', status: 'closed', goal: '活动乙', createdAt: '2026-01-01', course: { courseId: 'c2', courseName: '同名课程', objectives: [] } },
    { activityId: 'c', status: 'open', goal: '历史活动', createdAt: '2026-01-01' },
  ] as LearningActivity[]
  const onCourse = vi.fn()
  await act(async () => root.render(<ProductActivityList activities={activities} groupByCourse onCourse={onCourse} onOpen={() => {}} />))
  expect(host.querySelector('[data-course-group="c1"] [data-activity-id="a"]')).not.toBeNull()
  expect(host.querySelector('[data-course-group="c2"] [data-activity-id="b"]')).not.toBeNull()
  expect(host.querySelector('[data-course-group="unlinked"]')?.textContent).toContain('未关联课程')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-course-group="c2"] .outline')!.click())
  expect(onCourse).toHaveBeenCalledWith('c2')
})

it('keeps status management separate from navigation and retains a failed close for retry', async () => {
  const activity = { activityId: 'a', status: 'open', goal: '测试活动', createdAt: '2026-01-02' } as LearningActivity
  const onOpen = vi.fn(), onStatus = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce(undefined)
  await act(async () => root.render(<ProductActivityList activities={[activity]} onOpen={onOpen} onStatus={onStatus} />))
  await click('管理活动：测试活动'); await chooseMenu('关闭活动')
  expect(host.querySelector('button button')).toBeNull()
  expect(onStatus).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled()
  await click('取消'); expect(onStatus).not.toHaveBeenCalled()
  await click('管理活动：测试活动'); await chooseMenu('关闭活动'); await click('关闭活动')
  expect(onStatus).toHaveBeenCalledWith(activity)
  expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull()
  expect(host.querySelector('[data-activity-id="a"]')?.textContent).toContain('进行中')
  await click('关闭活动')
  expect(onStatus).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(onOpen).not.toHaveBeenCalled()
})

it('reopens an existing closed activity through the same activity identity', async () => {
  const activity = { activityId: 'closed-id', status: 'closed', goal: '已关闭的活动', createdAt: '2026-01-02' } as LearningActivity
  const onStatus = vi.fn().mockResolvedValue(undefined), onOpen = vi.fn()
  await act(async () => root.render(<ProductActivityList activities={[activity]} onOpen={onOpen} onStatus={onStatus} />))
  await click('管理活动：已关闭的活动'); await chooseMenu('重新开始活动')
  expect(onStatus).toHaveBeenCalledWith(activity)
  expect(onOpen).not.toHaveBeenCalled()
})

it('isolates portal menu actions from card-grid click routing', async () => {
  const routeClick = vi.fn(), onOpen = vi.fn(), onStatus = vi.fn()
  await act(async () => root.render(<div onClick={routeClick}><LearningTaskCard title="隔离菜单" action="打开" onOpen={onOpen}
    menu={<ActivityCardMenu title="隔离菜单" closed={false} onOpen={onOpen} onChangeStatus={onStatus} />} /></div>))
  await click('管理活动：隔离菜单'); await chooseMenu('关闭活动')
  expect(onStatus).toHaveBeenCalledOnce()
  expect(routeClick).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
})
