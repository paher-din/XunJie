import { courseMaterialContentSchema, type CourseActivityBinding } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { learningRequest } from '../product/learningTransport'
import { decodeBase64, sha256 } from './device'
import { preparationStore, type PreparationStore } from './store'

/**
 * Fixed-released course text is immutable and already identified by its own digest, so an opened
 * activity may read it again after a reload without the service. This reuses the preparation
 * resource store: the same byte-addressed cache, so no new object store and no IndexedDB upgrade.
 *
 * Only student-visible UTF-8 text is cached, and only after the bytes match the digest the course
 * release declared. A cache hit is re-hashed before use, so a damaged entry costs one re-download
 * rather than serving different bytes. PDFs and other binary materials stay on the authorized
 * material route: their absence is reported as unreadable instead of being called available offline.
 *
 * This is a content cache, not a standing grant. Access is still decided by the caller's `authorized`
 * state and by the service on every reconnection; nothing here makes an activity allowed.
 */
export const cacheableMaterial = (mediaType: string) => mediaType.startsWith('text/') || mediaType === 'application/json'

export function createMaterialCache(options: { store?: PreparationStore } = {}) {
  const store = options.store ?? preparationStore
  /** Verified UTF-8 text for one declared material: local bytes when intact, otherwise the fixed route. */
  async function text(activity: LearningActivity, course: CourseActivityBinding, spaceKey: string, namespace: string,
    material: { materialId: string; mediaType: string; sha256: string; byteLength: number }): Promise<string> {
    const saved = await store.readResource(material.sha256).catch(() => undefined)
    if (saved && saved.bytes.length === material.byteLength && await sha256(saved.bytes) === material.sha256)
      return new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes)
    if (saved) await store.dropResource(material.sha256).catch(() => undefined)
    const payload = courseMaterialContentSchema.parse(await learningRequest(activity, spaceKey, namespace,
      `releases/${course.releaseId}/materials/${material.materialId}`))
    // The route is chosen by the caller; the answer must still describe that same material.
    if (payload.materialId !== material.materialId || payload.sha256 !== material.sha256
      || payload.byteLength !== material.byteLength || payload.mediaType !== material.mediaType)
      throw new Error('material-corrupt')
    const bytes = decodeBase64(payload.contentBase64)
    if (bytes.length !== material.byteLength || await sha256(bytes) !== material.sha256) throw new Error('material-corrupt')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Losing the cache costs a re-download on the next open, never correctness for this one.
    await store.writeResource({ sha256: material.sha256, byteLength: bytes.length, mediaType: material.mediaType,
      bytes, storedAt: new Date().toISOString() }).catch(() => undefined)
    return value
  }
  return { text }
}
export const materialCache = createMaterialCache()
