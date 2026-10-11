import { useParams } from 'react-router-dom'
import { PREP_BUILD } from '../workspace/mode'
import { PREP_TASK_ID } from '../workspace/prepEntry'
import PrepWorkspacePage from './PrepWorkspacePage'
import WorkspacePage from './WorkspacePage'

/**
 * 任务入口分发：沿用原有 `/task/:taskId` 路由，不新增页面或导航。
 *
 * 只有准备构建（`npm run dev:prep`）下命中固定合成场景 ID 时才进 I0-A 的 C 准备工作区，
 * 其余一律走原设计工作区。正式构建里 `PREP_BUILD` 静态折叠为 false，准备页面随之被摇掉，
 * 因此 `dist/` 不含准备入口与准备端点字符串（由构建后检查与 e2e 核对）。
 */
export default function TaskRoute() {
  const { taskId } = useParams()
  if (PREP_BUILD && taskId === PREP_TASK_ID) return <PrepWorkspacePage />
  return <WorkspacePage />
}
