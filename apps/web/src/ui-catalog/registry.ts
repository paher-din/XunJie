import { brandEntries } from './examples/brand'
import { chatEntries } from './examples/chat'
import { dashboardEntries } from './examples/dashboard'
import { foundationEntries } from './examples/foundation'
import { feedbackEntries } from './examples/feedback'
import { homeEntries } from './examples/home'
import { iconEntries } from './examples/icons'
import { prepWorkspacePageEntries } from './examples/prep-workspace-page'
import { settingsEntries } from './examples/settings'
import { teacherEntries } from './examples/teacher'
import { teacherDesignEntries } from './examples/teacher-design'
import { teacherReviewEntries } from './examples/teacher-review'
import { teacherShellEntries } from './examples/teacher-shell'
import { workspaceEntries } from './examples/workspace'
import { workspacePageEntries } from './examples/workspace-page'
import type { CatalogEntry, CatalogGroup, CatalogState } from './types'

/** 只登记已经有真实示例的组件。新分组可在这里追加，不需要修改路由。 */
export const catalog: CatalogGroup[] = [
  { id: 'foundation', name: '基础组件', entries: foundationEntries },
  { id: 'feedback', name: '通知反馈', entries: feedbackEntries },
  { id: 'icons', name: '图标', entries: iconEntries },
  { id: 'brand', name: '品牌', entries: brandEntries },
  { id: 'home', name: '首页', entries: homeEntries },
  { id: 'chat', name: '对话', entries: chatEntries },
  { id: 'dashboard', name: '学习看板', entries: dashboardEntries },
  { id: 'settings', name: '学生设置', entries: settingsEntries },
  { id: 'teacher', name: '教师基础组件', entries: teacherEntries },
  { id: 'teacher-shell', name: '教师外壳', entries: teacherShellEntries },
  { id: 'teacher-design', name: '教师项目设计', entries: teacherDesignEntries },
  { id: 'teacher-review', name: '教师审阅与材料', entries: teacherReviewEntries },
  { id: 'prep-workspace', name: '准备工作区', entries: prepWorkspacePageEntries },
  { id: 'workspace', name: '工作区', entries: workspaceEntries },
  { id: 'workspace-page', name: '工作区页面', entries: workspacePageEntries },
]

const validId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function requireUnique(ids: string[], context: string) {
  if (ids.some(id => !validId.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`Invalid or duplicate catalog ID: ${context}`)
  }
}
requireUnique(catalog.map(group => group.id), 'groups')
for (const group of catalog) {
  requireUnique(group.entries.map(entry => entry.id), group.id)
  for (const entry of group.entries) {
    if (!entry.states.length) throw new Error(`Catalog entry has no states: ${group.id}/${entry.id}`)
    requireUnique(entry.states.map(state => state.id), `${group.id}/${entry.id}`)
  }
}

export interface CatalogSelection { group: CatalogGroup; entry: CatalogEntry; state: CatalogState }
export function selectionPath(group: CatalogGroup, entry: CatalogEntry, state: CatalogState) {
  return `#/${group.id}/${entry.id}/${state.id}`
}
export function findSelection(hash: string): CatalogSelection | undefined {
  if (!hash || hash === '#') {
    const group = catalog[0]
    const entry = group.entries[0]
    return { group, entry, state: entry.states[0] }
  }
  const match = /^#\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(hash)
  if (!match) return undefined
  const group = catalog.find(item => item.id === match[1])
  const entry = group?.entries.find(item => item.id === match[2])
  const state = entry?.states.find(item => item.id === match[3])
  return group && entry && state ? { group, entry, state } : undefined
}
