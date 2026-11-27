import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { TeacherCatalog } from './data'

export interface TeacherContext {
  clientNamespace: string
  account: { key: string; accountName: string; schoolName?: string } | null
  identities?: { key: string; identity: SpaceIdentity }[]
  readOnly?: boolean
}

interface TeacherCache {
  context: TeacherContext
  catalog: TeacherCatalog
  savedAt: number
}

const cacheKey = 'xj.teacher-space.v1'
const maxAgeMs = 30 * 60 * 1000

/** Paint the last teacher page immediately on refresh; the live reads still replace it. */
export function readTeacherCache(): { context: TeacherContext; catalog: TeacherCatalog } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null') as Partial<TeacherCache> | null
    if (!value || typeof value.savedAt !== 'number' || Date.now() - value.savedAt >= maxAgeMs) return null
    if (!value.context?.account?.key || !value.catalog?.available) return null
    return { context: value.context, catalog: value.catalog }
  } catch { return null }
}

export function writeTeacherCache(context: TeacherContext, catalog: TeacherCatalog) {
  if (!context.account?.key || !catalog.available) return
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ context, catalog, savedAt: Date.now() })) }
  catch { /* A page cache is optional; live reads remain authoritative. */ }
}

export function clearTeacherCache() {
  try { sessionStorage.removeItem(cacheKey) } catch { /* Optional cache. */ }
}
