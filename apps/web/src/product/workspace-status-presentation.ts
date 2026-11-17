import type { ExecutionQuery } from '@xunjie/contracts/execution'

export function executionSummary(queries: ExecutionQuery[], uncertain: boolean, ready: boolean) {
  if (!ready) return '运行状态尚未就绪'
  const current = [...new Map(queries.map(query => [query.requestId, query])).values()]
  if (uncertain || current.some(query => query.statusKnowledge !== 'confirmed')) return '运行状态待确认'
  const counts = ['running', 'queued', 'paused'].map(state => current.filter(query => query.state === state).length)
  if (counts.some(Boolean)) return counts.map((count, i) => count ? `${['运行中', '排队', '已暂停'][i]} ${count}` : '').filter(Boolean).join(' · ')
  return current.length ? '当前没有进行中的运行' : '尚未运行课程工具'
}
