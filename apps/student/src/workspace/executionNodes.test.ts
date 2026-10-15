import { beforeEach, expect, it, vi } from 'vitest'
import { clearExecutionNodes, executionNodeReady, getExecutionNodes, loadExecutionNodes, selectExecutionNode, selectedExecutionNode } from './executionNodes'
import { WorkspaceRequestError } from './http'

const get = vi.hoisted(() => vi.fn())
vi.mock('./http', async original => ({ ...await original<object>(), apiGet: get }))
const nodes = [{ nodeId: 'robert', label: 'Robert 的电脑', cReady: false, hdlReady: true },
  { nodeId: 'member', label: '成员的电脑', cReady: true, hdlReady: true }]
const cache = new Map<string, string>()
beforeEach(() => {
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value), removeItem: (key: string) => cache.delete(key) })
  clearExecutionNodes(); cache.clear(); get.mockReset(); get.mockResolvedValue({ nodes })
})

it('requires an explicit registered node and uses its actual course readiness', async () => {
  await loadExecutionNodes('student')
  expect(selectedExecutionNode()).toBeUndefined()
  expect(await executionNodeReady('student', 'c')).toBe(false)
  selectExecutionNode('unregistered')
  expect(selectedExecutionNode()).toBeUndefined()
  selectExecutionNode('robert')
  expect(await executionNodeReady('student', 'c')).toBe(false)
  expect(await executionNodeReady('student', 'hdl')).toBe(true)
  // Current selection does not decide where an existing HDL Session is controlled.
  expect(await executionNodeReady('student', 'hdl', true)).toBe(true)
  selectExecutionNode('')
  expect(await executionNodeReady('student', 'hdl', true)).toBe(true)
})

it('retains the old single-node path only for an empty registry or an unsupported endpoint', async () => {
  get.mockResolvedValueOnce({ nodes: [] })
  expect(await executionNodeReady('student', 'c')).toBeUndefined()
  get.mockRejectedValueOnce(new WorkspaceRequestError({ kind: 'protocol', status: 404, message: 'old host' }, 'GET', '/api/execution-nodes'))
  expect(await executionNodeReady('student', 'c')).toBeUndefined()
  get.mockRejectedValueOnce(new WorkspaceRequestError({ kind: 'transport', message: 'offline' }, 'GET', '/api/execution-nodes'))
  expect(await executionNodeReady('student', 'c')).toBe(false)
  expect(getExecutionNodes().status).toBe('unavailable')
})

it('does not reuse an unregistered, other-account, or stale session selection', async () => {
  await loadExecutionNodes('student-a'); selectExecutionNode('member')
  await loadExecutionNodes('student-b')
  expect(selectedExecutionNode()).toBeUndefined()
  selectExecutionNode('robert')
  get.mockResolvedValueOnce({ nodes: [nodes[1]] })
  await loadExecutionNodes('student-b')
  expect(selectedExecutionNode()).toBeUndefined()
  let resolve!: (value: unknown) => void
  get.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const late = loadExecutionNodes('student-b')
  clearExecutionNodes()
  resolve({ nodes }); await late
  expect(getExecutionNodes().status).toBe('idle')
  expect(cache.size).toBe(0)
})
