/**
 * I0-A 准备场景在**现有任务入口路由**上的固定标识。
 *
 * 这些常量只是导航与文案：合成身份、活动正文与材料全部来自开发 fixture 的 HTTP 响应，
 * 不在客户端硬编码任何正式对象。`PREP_TASK_ID` 带 `i0-prep-` 前缀，明确是准备场景，
 * 不与原图书 / 记账等演示任务混称，也不冒充正式 Assignment。
 */

export const PREP_TASK_ID = 'i0-prep-textscope-c'

export const PREP_TASK_ROUTE = `/task/${PREP_TASK_ID}`

export const PREP_ENTRY_LABEL = 'I0 准备场景（合成）'

export const PREP_ENTRY_COURSE = 'C / TextScope · 准备工作区'

export const PREP_ENTRY_GOAL = '读取合成会话、固定活动要求与材料，进入 C 中心容器。'

export const PREP_ENTRY_NOTE = '合成身份与合成材料，不是正式分配，不写入学习记录。'
