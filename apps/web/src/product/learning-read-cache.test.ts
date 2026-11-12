import { afterEach, expect, it, vi } from 'vitest'
import { LearningReadCache } from './learning-read-cache'

afterEach(() => vi.restoreAllMocks())

it('shares pending reads and retains the snapshot while refreshing after expiry', async () => {
  const cache = new LearningReadCache()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  let finish!: (value: string[]) => void
  const load = vi.fn(() => new Promise<string[]>(resolve => { finish = resolve }))
  const first = cache.read('personal', 'activities', load)
  const second = cache.read('personal', 'activities', load)
  expect(load).toHaveBeenCalledOnce()
  finish(['original'])
  expect(await first).toEqual(['original'])
  expect(await second).toEqual(['original'])
  await cache.read('personal', 'activities', load)
  expect(load).toHaveBeenCalledOnce()
  clock.mockReturnValue(32000)
  const refresh = cache.read('personal', 'activities', load)
  expect(cache.peek('personal', 'activities')).toEqual(['original'])
  finish(['updated'])
  expect(await refresh).toEqual(['updated'])
})

it('keeps an acknowledged mutation when an older list request finishes afterward', async () => {
  const cache = new LearningReadCache()
  let finish!: (value: string[]) => void
  const read = cache.read('school:one', 'activities', () => new Promise<string[]>(resolve => { finish = resolve }))
  cache.set('school:one', 'activities', ['new activity'])
  finish(['old activity'])
  expect(await read).toEqual(['new activity'])
  expect(cache.peek('school:two', 'activities')).toBeUndefined()
  expect(new LearningReadCache().peek('school:one', 'activities')).toBeUndefined()
})

it('allows retry after failure without discarding previously loaded data', async () => {
  const cache = new LearningReadCache()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  cache.set('personal', 'courses', ['saved'])
  clock.mockReturnValue(32000)
  await expect(cache.read('personal', 'courses', async () => { throw new Error('offline') })).rejects.toThrow('offline')
  expect(cache.peek('personal', 'courses')).toEqual(['saved'])
  expect(await cache.read('personal', 'courses', async () => ['recovered'])).toEqual(['recovered'])
})

it('bounds retained snapshots and evicts the least recently used entry', () => {
  const cache = new LearningReadCache(2)
  cache.set('personal', 'first', ['one'])
  cache.set('personal', 'second', ['two'])
  cache.peek('personal', 'first')
  cache.set('personal', 'third', ['three'])
  expect(cache.peek('personal', 'second')).toBeUndefined()
  expect(cache.peek('personal', 'first')).toEqual(['one'])
})

it('ignores a late read failure after an acknowledged mutation has replaced it', async () => {
  const cache = new LearningReadCache()
  let reject!: (cause: Error) => void
  const read = cache.read('personal', 'activities', () => new Promise((_, fail) => { reject = fail }))
  cache.set('personal', 'activities', ['acknowledged'])
  reject(new Error('old connection failed'))
  expect(await read).toEqual(['acknowledged'])
})
