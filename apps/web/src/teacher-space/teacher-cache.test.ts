// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { clearTeacherCache, readTeacherCache, writeTeacherCache } from './teacher-cache'

const context = {
  clientNamespace: 'test',
  account: { key: 'school:connection', accountName: 'wuboqun', schoolName: '示例学校' },
}
const catalog = { available: true, courses: [] }

beforeEach(() => { sessionStorage.clear() })

it('returns the last painted teacher workspace within the cache window', () => {
  writeTeacherCache(context, catalog)
  expect(readTeacherCache()).toEqual({ context, catalog })
})

it('ignores an expired or incomplete cache', () => {
  sessionStorage.setItem('xj.teacher-space.v1', JSON.stringify({ context, catalog, savedAt: Date.now() - 31 * 60 * 1000 }))
  expect(readTeacherCache()).toBeNull()
  writeTeacherCache({ ...context, account: null }, catalog)
  expect(readTeacherCache()).toBeNull()
})

it('clears the painted workspace when live reads no longer match', () => {
  writeTeacherCache(context, catalog)
  clearTeacherCache()
  expect(readTeacherCache()).toBeNull()
})
