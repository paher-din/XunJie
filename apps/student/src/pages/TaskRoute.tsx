import { useParams } from 'react-router-dom'
import { PREP_BUILD } from '../workspace/mode'
import { PREP_TASK_ID } from '../workspace/prepEntry'
import { demoTasks } from '../bridge/mockData'
import PrepWorkspacePage from './PrepWorkspacePage'
import WorkspacePage from './WorkspacePage'

/**
 * 任务入口分发：沿用原有 `/task/:taskId` 路由，不新增页面或导航。
 *
 * 原 Design 演示 ID 保留原工作区。正常模式的其他深链引用交给既有 C 页面读取获准分配；
 * 不把演示卡片当真实分配，不新增导航或分配发现 API。准备常量仅开发构建使用。
 */
export default function TaskRoute() {
  const { taskId } = useParams()
  if (PREP_BUILD && taskId === PREP_TASK_ID) return <PrepWorkspacePage />
  if (PREP_BUILD || !taskId || demoTasks.some(task => task.id === taskId)) return <WorkspacePage />
  return <PrepWorkspacePage key={taskId} assignmentId={taskId} />
}
