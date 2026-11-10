import { useEffect } from 'react'
import { Button } from '@xunjie/ui/foundation'
import { Toaster, toast } from '@xunjie/ui/feedback'
import type { CatalogEntry } from '../types'

function Notifications() {
  useEffect(() => {
    const id = toast.success('设置已保存。')
    return () => { toast.dismiss(id) }
  }, [])
  return <><Toaster /><div className="demo-row">
    <Button type="button" onClick={() => toast.success('设置已保存。')}>成功通知</Button>
    <Button type="button" variant="outline" onClick={() => toast.error('无法连接学校，请检查学校链接后重试。')}>错误通知</Button>
    <Button type="button" variant="outline" onClick={() => toast.info('已加入当前问题草稿。')}>普通通知</Button>
    <Button type="button" variant="outline" onClick={() => toast.warning('当前输入尚未保存，请保留页面后重试。')}>提醒通知</Button>
  </div></>
}

export const feedbackEntries: CatalogEntry[] = [
  { id: 'toaster', name: 'Toaster', description: '学生端统一 Sonner 通知，支持关闭、堆叠和主题。',
    importPath: '@xunjie/ui/feedback', source: 'packages/ui/src/feedback/index.tsx', exampleSource: 'apps/web/src/ui-catalog/examples/feedback.tsx',
    props: ['在应用根挂载一次', 'toast.success / error / info / warning', 'useToastFeedback(message, kind)'],
    dependencies: ['Sonner', '循阶主题 token 与图标'], states: [{ id: 'notifications', name: '成功 / 错误 / 提醒 / 堆叠', component: Notifications }] },
]
