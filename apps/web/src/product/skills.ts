import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingSkillListSchema,
  teachingSkillImportSchema, teachingSkillLimits, teachingSkillPathSchema, type TeachingSkillImport } from '@xunjie/contracts/agent-skills'
import { learningSubjectRequest } from './learningTransport'

export const skillCatalogSchema = teachingSkillListSchema.extend({ selections: teachingSkillListSchema.shape.selections.optional() })
export type SkillCatalog = z.infer<typeof skillCatalogSchema>
export type SkillCatalogEntry = SkillCatalog['skills'][number]
const catalogChanges = new Set<(scope: string, sender: object) => void>()

/** Scope defaults do not gate an explicit question pin; other owner failures still do. */
export function draftSkillOption(skill: SkillCatalogEntry) {
  const unavailable = skill.disabled ? '已停用'
    : skill.unavailable && skill.unavailable.reason !== 'not-selected' ? skill.unavailable.detail || '当前不可用' : undefined
  return { skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, fixed: skill.origin === 'course',
    ...(unavailable ? { unavailable } : {}) }
}

export function useSkillCatalog(identity: SpaceIdentity, spaceKey: string, namespace: string, activityId?: string) {
  const scope = JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId, activityId])
  const current = useRef(scope), live = useRef(false), reads = useRef(0)
  const client = useRef({})
  current.current = scope
  const [state, setState] = useState<{ scope: string; data: SkillCatalog | null; loading: boolean; error: string; epoch: number }>({ scope, data: null, loading: true, error: '', epoch: 0 })
  const request = useCallback(async (route: string, body?: unknown) => {
    // An activity's pinned owner remains authoritative even if the member binding changes.
    const boundRoute = activityId && (route === 'skills' || route.startsWith('skills/')) ? `agent/${activityId}/${route}` : route
    const result = await learningSubjectRequest(identity, spaceKey, namespace, boundRoute, body)
    if (body !== undefined && ['skills/import', 'skills/select', 'skills/disable'].includes(route))
      for (const changed of catalogChanges) changed(scope, client.current)
    return result
  }, [scope])
  const reload = useCallback(async () => {
    const epoch = ++reads.current
    const active = () => live.current && current.current === scope && reads.current === epoch
    if (active()) setState(previous => ({ ...previous, loading: true }))
    try {
      const data = skillCatalogSchema.parse(await request('skills'))
      if (active()) setState({ scope, data, loading: false, error: '', epoch })
      return data
    } catch {
      if (active()) setState(previous => ({ ...previous, scope, loading: false, error: 'Skills 暂时无法读取，已选版本与问题草稿仍保留。' }))
      return null
    }
  }, [scope, activityId, request])
  useEffect(() => {
    live.current = true
    setState({ scope, data: null, loading: true, error: '', epoch: 0 })
    const changed = (changedScope: string, sender: object) => {
      if (changedScope === scope && sender !== client.current) void reload()
    }
    catalogChanges.add(changed)
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener('focus', refresh)
    return () => { live.current = false; reads.current++; catalogChanges.delete(changed); window.removeEventListener('focus', refresh) }
  }, [scope, reload])
  return { ...(state.scope === scope ? state : { data: null, loading: true, error: '' }), reload, request,
    // An older rendered controller cannot fix pins while its catalog is being replaced.
    isCurrent: () => live.current && current.current === scope && state.scope === scope && !!state.data
      && state.epoch === reads.current && !state.loading && !state.error }
}

const textExtensions = /\.(?:md|txt|json|ya?ml|toml|csv|tsv|html?|css|[cm]?js|tsx?|jsx|py|sh|bash|sql|xml|svg)$/i
/** A package is transported intact; directory prefixes never become server filesystem paths. */
export async function readSkillPackage(files: readonly File[]): Promise<TeachingSkillImport['files']> {
  if (!files.length || files.length > teachingSkillLimits.files) throw new Error('请选择一个包含 SKILL.md 的包，最多 64 个文件。')
  if (files.some(file => file.size > teachingSkillLimits.fileBytes)
    || files.reduce((total, file) => total + file.size, 0) > teachingSkillLimits.packageBytes) throw new Error('Skill 包超出大小限制：单文件 512 KB，整包 2 MB。')
  const paths = files.map(file => file.webkitRelativePath || file.name)
  const roots = paths.filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  if (roots.length !== 1) throw new Error('每次请选择一个真实 Skill 包，且包含唯一的 SKILL.md。')
  const prefix = roots[0].slice(0, -'SKILL.md'.length)
  const normalized = paths.map(path => {
    if (!path.startsWith(prefix)) throw new Error('所有文件必须属于同一个 SKILL.md 包目录。')
    const result = teachingSkillPathSchema.safeParse(path.slice(prefix.length))
    if (!result.success) throw new Error('包内路径必须是规范相对路径；请用目录导入保留文件结构。')
    return result.data
  })
  if (new Set(normalized.map(path => path.toLowerCase())).size !== normalized.length) throw new Error('包中包含重名路径。')
  return Promise.all(files.map(async (file, index) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = normalized[index]
    if (path === 'SKILL.md' || textExtensions.test(path)) {
      try { return { path, encoding: 'utf8' as const, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), ...(file.type ? { mediaType: file.type } : {}) } }
      catch { if (path === 'SKILL.md') throw new Error('SKILL.md 必须是 UTF-8 文本。') }
    }
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return { path, encoding: 'base64' as const, content: btoa(binary), ...(file.type ? { mediaType: file.type } : {}) }
  }))
}

export function skillImportInput(input: TeachingSkillImport) {
  const parsed = teachingSkillImportSchema.safeParse(input)
  if (!parsed.success) throw new Error('请填写来源、包版本，并选择包含 SKILL.md 的有效文件包。')
  return parsed.data
}
