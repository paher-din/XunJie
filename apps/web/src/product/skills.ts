import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { teachingSkillListSchema,
  teachingSkillImportSchema, teachingSkillImportFailureSchema, teachingSkillLimits, teachingSkillPathSchema, type TeachingSkillImport } from '@xunjie/contracts/agent-skills'
import { learningSubjectRequest } from './learningTransport'

export const skillCatalogSchema = teachingSkillListSchema.extend({ selections: teachingSkillListSchema.shape.selections.optional() })
export type SkillCatalog = z.infer<typeof skillCatalogSchema>
export type SkillCatalogEntry = SkillCatalog['skills'][number]
const catalogChanges = new Set<(namespace: string, sender: object) => void>()

/** Question pins may use another fixed version; disabled or unavailable packages stay unavailable. */
export function draftSkillOption(skill: SkillCatalogEntry) {
  const unavailable = skill.disabled ? '已停用'
    : skill.unavailable && skill.unavailable.reason !== 'not-selected' ? skill.unavailable.detail || '当前不可用' : undefined
  return { skillId: skill.skillId, version: skill.version, name: skill.name, description: skill.description, fixed: skill.origin === 'course',
    ...(unavailable ? { unavailable } : {}) }
}

export function useSkillCatalog(identity: SpaceIdentity, spaceKey: string, namespace: string, activityId?: string, enabled = true) {
  const scope = JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId, activityId])
  const current = useRef(scope), live = useRef(false), reads = useRef(0)
  const client = useRef({})
  current.current = scope
  const [state, setState] = useState<{ scope: string; data: SkillCatalog | null; loading: boolean; error: string; epoch: number }>({ scope, data: null, loading: true, error: '', epoch: 0 })
  const request = useCallback(async (route: string, body?: unknown) => {
    // An activity's pinned owner remains authoritative even if the member binding changes.
    const boundRoute = activityId && (route === 'skills' || route.startsWith('skills/')) ? `agent/${activityId}/${route}` : route
    const result = await learningSubjectRequest(identity, spaceKey, namespace, boundRoute, body,
      route === 'skills/import' ? teachingSkillLimits.importTimeoutMs : undefined)
    if (body !== undefined && ['skills/import', 'skills/select', 'skills/disable', 'skills/remove'].includes(route))
      for (const changed of catalogChanges) changed(namespace, client.current)
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
      if (active()) setState(previous => ({ ...previous, scope, loading: false, error: '暂时无法加载技能。' }))
      return null
    }
  }, [scope, activityId, request])
  useEffect(() => {
    if (!enabled) {
      setState(previous => ({ ...previous, loading: false, error: '' }))
      return
    }
    live.current = true
    setState({ scope, data: null, loading: true, error: '', epoch: 0 })
    const changed = (changedNamespace: string, sender: object) => {
      if (changedNamespace === namespace && sender !== client.current) void reload()
    }
    catalogChanges.add(changed)
    void reload()
    const refresh = () => { void reload() }
    window.addEventListener('focus', refresh)
    return () => { live.current = false; reads.current++; catalogChanges.delete(changed); window.removeEventListener('focus', refresh) }
  }, [scope, reload, enabled])
  return { ...(state.scope === scope ? state : { data: null, loading: true, error: '' }), reload, request,
    // An older rendered controller cannot fix pins while its catalog is being replaced.
    isCurrent: () => live.current && current.current === scope && state.scope === scope && !!state.data
      && state.epoch === reads.current && !state.loading && !state.error }
}

const textExtensions = /\.(?:md|txt|json|ya?ml|toml|csv|tsv|html?|css|[cm]?js|tsx?|jsx|py|sh|bash|sql|xml|svg)$/i
/** A package is transported intact; directory prefixes never become server filesystem paths. */
export async function readSkillPackage(selectedFiles: readonly File[]): Promise<TeachingSkillImport['files']> {
  const files = selectedFiles.filter(file => !(file.webkitRelativePath || file.name).split('/').some(part => part.toLowerCase() === '.git'))
  if (!files.length || files.length > teachingSkillLimits.files) throw new Error(`请选择含 SKILL.md 的技能文件夹，最多 ${teachingSkillLimits.files} 个文件。`)
  if (files.some(file => file.size > teachingSkillLimits.fileBytes)
    || files.reduce((total, file) => total + file.size, 0) > teachingSkillLimits.packageBytes)
    throw new Error(`技能文件超出大小限制：单文件 ${teachingSkillLimits.fileBytes / 1048576} MiB，总计 ${teachingSkillLimits.packageBytes / 1048576} MiB。`)
  const paths = files.map(file => file.webkitRelativePath || file.name)
  const roots = paths.filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  // A skill may bundle other SKILL.md documents as references or examples.
  const depth = Math.min(...roots.map(path => path.split('/').length))
  const outermost = roots.filter(path => path.split('/').length === depth)
  if (outermost.length !== 1) throw new Error('每次请选择一个技能文件夹，其中应直接包含 SKILL.md。')
  const prefix = outermost[0].slice(0, -'SKILL.md'.length)
  const normalized = paths.map(path => {
    if (!path.startsWith(prefix)) throw new Error('所选文件不属于同一个技能，请选择整个技能文件夹。')
    const result = teachingSkillPathSchema.safeParse(path.slice(prefix.length))
    if (!result.success) throw new Error('文件结构不完整，请改为选择整个技能文件夹。')
    return result.data
  })
  if (new Set(normalized.map(path => path.toLowerCase())).size !== normalized.length) throw new Error('文件中存在重名项，请整理后重新导入。')
  if (files[normalized.indexOf('SKILL.md')].size > teachingSkillLimits.bodyBytes)
    throw new Error(`SKILL.md 最多 ${teachingSkillLimits.bodyBytes / 1048576} MiB。`)
  return Promise.all(files.map(async (file, index) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = normalized[index]
    if (path === 'SKILL.md' || textExtensions.test(path)) {
      try { return { path, encoding: 'utf8' as const, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), ...(file.type ? { mediaType: file.type } : {}) } }
      catch { if (path === 'SKILL.md') throw new Error('SKILL.md 不是 UTF-8 文本，请用文本编辑器重新保存。') }
    }
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return { path, encoding: 'base64' as const, content: btoa(binary), ...(file.type ? { mediaType: file.type } : {}) }
  }))
}

export function skillImportInput(input: TeachingSkillImport) {
  const parsed = teachingSkillImportSchema.safeParse(input)
  if (!parsed.success) throw new Error('无法导入这个技能，请选择包含有效 SKILL.md 的技能文件夹。')
  return parsed.data
}

export function skillImportErrorMessage(cause: unknown) {
  if (!cause || typeof cause !== 'object') return undefined
  const error = cause as { code?: unknown; reason?: unknown }
  const parsed = teachingSkillImportFailureSchema.safeParse({ error: error.code, reason: error.reason })
  if (!parsed.success) return undefined
  return {
    frontmatter: 'SKILL.md 开头的配置格式有误，请检查两行 --- 之间的内容。',
    name: `请在 SKILL.md 开头填写 name，使用中英文、数字和连字符，最多 ${teachingSkillLimits.nameChars} 个字符。`,
    description: `请在 SKILL.md 开头填写 description（技能说明），最多 ${teachingSkillLimits.descriptionChars} 个字符。`,
    metadata: 'SKILL.md 的可选配置格式有误，请检查 allowed-tools、dependencies 等字段。',
    'skill-limit': `技能数量已达 ${teachingSkillLimits.skills} 个，请移除不再使用的技能后继续导入。`,
  }[parsed.data.reason]
}
