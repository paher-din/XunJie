import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import wabtFactory from 'wabt'
import { executionQuerySchema, executionActionSchema, advanceExecution, fixedActionKind } from '@xunjie/contracts/execution'
import type { ExecutionQuery } from '@xunjie/contracts/execution'
import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { acceptsState, type StateShape } from '@xunjie/contracts/components'
import { AlgorithmError, expectedAggregation, instantiateAlgorithm, runAggregation, type AggregationTable } from './algorithm'
import { abandonedQuery, progressQuery, stopDecision, type ExecutionRecord } from './ledger'

const algorithm = readFileSync(new URL('../../../../components/table-aggregation/algorithm.wasm', import.meta.url))
const limits = { memoryPages: 256, entry: 'aggregate', inputBytes: 1048576, outputBytes: 1048576, timeMs: 5000 }
const table: AggregationTable = { columns: ['班级', '姓名', '分数'],
  rows: [['A', '甲', '80'], ['A', '乙', '90.5'], ['B', '丙', '70'], ['B', '丁', '60'], ['A', '戊', '100']] }

function run(overrides: Partial<Parameters<typeof runAggregation>[0]> = {}) {
  return runAggregation({ bytes: algorithm, table, parameters: { groupColumn: '班级', valueColumn: '分数', aggregate: 'mean' }, ...limits, ...overrides })
}

/** Real modules with an aggregate that reads f64 from the supplied memory; private memories
 * deliberately remain unexported, so export inspection cannot detect the regression. */
function memoryModule(options: { definedMemories?: number[][]; extraImports?: number[][]; importMaximum?: number
  customData?: number[] } = {}) {
  const u32 = (value: number) => {
    const bytes: number[] = []
    do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)) } while (value)
    return bytes
  }
  const name = (value: string) => [...u32(value.length), ...Buffer.from(value)]
  const section = (id: number, body: number[]) => [id, ...u32(body.length), ...body]
  const extraImports = options.extraImports ?? []
  const memory = options.importMaximum === undefined ? [0, 1] : [1, 1, ...u32(options.importMaximum)]
  const body = [0, 32, 0, 43, 3, 0, 11] // local.get 0; f64.load (memory 0)
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(0, [...name('padding'), ...(options.customData ?? [])]),
    ...section(1, [1, 96, 3, 127, 127, 127, 1, 124]),
    ...section(2, [1 + extraImports.length, ...name('env'), ...name('memory'), 2, ...memory, ...extraImports.flat()]),
    ...section(3, [1, 0]),
    ...(options.definedMemories ? section(5, [options.definedMemories.length, ...options.definedMemories.flat()]) : []),
    ...section(6, [1, 127, 0, 65, 1, 11]),
    ...section(7, [2, ...name('aggregate'), 0, 0, ...name('abiVersion'), 3, 0]),
    ...section(10, [1, ...u32(body.length), ...body])])
}

describe('fixed table aggregation runs in a restricted algorithm', () => {
  it('matches an independently computed expectation for every supported aggregate', () => {
    for (const aggregate of ['count', 'sum', 'mean'] as const) {
      const parameters = { groupColumn: '班级', valueColumn: '分数', aggregate }
      const outcome = run({ parameters })
      expect(Object.fromEntries(outcome.result.groups.map(group => [group.key, group.value])))
        .toEqual(expectedAggregation(table, parameters).groups)
      expect(outcome.result.value).toBeCloseTo(expectedAggregation(table, parameters).value, 10)
    }
    // The numbers above come from real WebAssembly code, not from this expectation.
    expect(run().result.groups.find(group => group.key === 'A')).toMatchObject({ count: 3, sum: 270.5, min: 80, max: 100 })
  })
  it('stops before computing when the selected column is not numeric and names the rows', () => {
    const broken = { ...table, rows: [['A', '甲', '80'], ['A', '乙', '不是数字']] }
    expect(() => run({ table: broken })).toThrow(AlgorithmError)
    try { run({ table: broken }) } catch (error) { expect((error as AlgorithmError).code).toBe('invalid-input')
      expect((error as AlgorithmError).message).toContain('第 2 行') }
    expect(() => run({ table: { ...table, rows: [['A', '甲', '']] } })).toThrow(/不是有限数字/)
  })
  it('refuses a module with an unpermitted import, a foreign ABI or a tampered body', () => {
    const functionImport = Uint8Array.from(Buffer.from('AGFzbQEAAAABBAFgAAACCwEDZW52A2xvZwAA', 'base64'))
    expect(() => instantiateAlgorithm(functionImport, { memoryPages: 256, entry: 'aggregate' })).toThrow(/未经许可的导入/)
    const tampered = Uint8Array.from(algorithm.subarray(0, algorithm.length - 40))
    expect(() => instantiateAlgorithm(tampered, { memoryPages: 256, entry: 'aggregate' })).toThrow(AlgorithmError)
    expect(() => instantiateAlgorithm(algorithm, { memoryPages: 256, entry: 'missing' })).toThrow(/预期的入口/)
    expect(WebAssembly.Module.imports(new WebAssembly.Module(algorithm))).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }])
  })
  it('reports a real output budget failure instead of truncating the file', () => {
    expect(() => run({ outputBytes: 20 })).toThrow(/输出上限/)
  })
  it('pins the algorithm memory maximum so nothing can grow past the declared budget', () => {
    const instance = instantiateAlgorithm(algorithm, { memoryPages: 4, entry: 'aggregate' })
    expect(instance.memory.buffer.byteLength).toBe(4 * 65536)
    expect(() => instance.memory.grow(1)).toThrow()
    expect(instance.aggregate(0, 0, 1)).toBeNaN()
  })
  it.each([
    ['over-budget private memory', [1, 129, 2, 129, 2]], // min/max 257 pages
    ['small private memory', [1, 1, 1]],
    ['zero-sized growable private memory', [0, 0]],
  ])('refuses %s before instantiation', (_label, memory) => {
    const bytes = memoryModule({ definedMemories: [memory] })
    expect(WebAssembly.validate(bytes)).toBe(true)
    expect(WebAssembly.Module.imports(new WebAssembly.Module(bytes))).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }])
    expect(() => instantiateAlgorithm(bytes, { memoryPages: 1, entry: 'aggregate' })).toThrow(/额外线性内存/)
  })
  it('rejects private tables compiled from real WAT while preserving the ABI global', async () => {
    const wabt = await wabtFactory()
    for (const size of [null, 0, 1, 4194304]) {
      const wat = wabt.parseWat('table-budget.wat', `(module
        (import "env" "memory" (memory 1))
        ${size === null ? '' : `(table ${size} funcref)`}
        (global (export "abiVersion") i32 (i32.const 1))
        (func (export "aggregate") (param i32 i32 i32) (result f64)
          (f64.load (local.get 0))))`)
      try {
        const buffer = new Uint8Array(wat.toBinary({}).buffer)
        expect(WebAssembly.validate(buffer)).toBe(true)
        const module = new WebAssembly.Module(buffer)
        expect(WebAssembly.Module.imports(module)).toEqual([{ module: 'env', name: 'memory', kind: 'memory' }])
        expect(WebAssembly.Module.exports(module)).toContainEqual({ name: 'abiVersion', kind: 'global' })
        if (size !== null) {
          // Compile/validate the huge declaration, but never allocate its table in the test.
          expect(() => instantiateAlgorithm(buffer, { memoryPages: 1, entry: 'aggregate' })).toThrow(/不能定义 table/)
        } else {
          const instance = instantiateAlgorithm(buffer, { memoryPages: 1, entry: 'aggregate' })
          new Float64Array(instance.memory.buffer)[0] = 42.25
          expect(instance.aggregate(0, 1, 0)).toBe(42.25)
        }
      } finally { wat.destroy() }
    }
  })
  it.each([
    ['global under the permitted memory name', [3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 3, 127, 0]],
    ['second memory', [3, 101, 110, 118, 5, 111, 116, 104, 101, 114, 2, 0, 1]],
    ['function', [3, 101, 110, 118, 3, 108, 111, 103, 0, 0]],
  ])('refuses an additional imported %s', (_label, imported) => {
    const bytes = memoryModule({ extraImports: [imported] })
    expect(WebAssembly.validate(bytes)).toBe(true)
    expect(() => instantiateAlgorithm(bytes, { memoryPages: 1, entry: 'aggregate' })).toThrow(/未经许可的导入/)
  })
  it('accepts compatible bounded or unbounded imports but caps actual memory and computes from it', () => {
    for (const importMaximum of [undefined, 4]) {
      const bytes = memoryModule({ importMaximum, definedMemories: [], customData: [...Array<number>(160).fill(0), 5, 3, 1, 0, 0] })
      const padded = new Uint8Array(bytes.length + 10)
      padded.set(bytes, 5)
      for (const input of [bytes.buffer, padded.subarray(5, 5 + bytes.length)]) {
        const instance = instantiateAlgorithm(input, { memoryPages: 4, entry: 'aggregate' })
        new Float64Array(instance.memory.buffer)[0] = 42.25
        expect(instance.aggregate(0, 1, 0)).toBe(42.25)
        expect(instance.memory.buffer.byteLength).toBe(4 * 65536)
        expect(() => instance.memory.grow(1)).toThrow()
      }
    }
  })
  it.each([0, -1, 1.5, 257, NaN, Infinity])('rejects an unsupported host memory budget %s', memoryPages => {
    expect(() => instantiateAlgorithm(algorithm, { memoryPages, entry: 'aggregate' })).toThrow(/内存预算/)
  })
})

const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(),
  principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }

function query(patch: Partial<ExecutionQuery>): ExecutionQuery {
  return executionQuerySchema.parse({ requestId: crypto.randomUUID(), inputDigest: 'a'.repeat(64), scope,
    executionRef: crypto.randomUUID(), state: 'running', statusKnowledge: 'confirmed', stopRequested: false,
    confirmedSeq: 2, reason: null, output: null, ...patch })
}

describe('execution facts only move forward', () => {
  it('keeps a confirmed terminal fact when a later answer is unknown or older', () => {
    const base = query({})
    const done = advanceExecution(base, { ...base, state: 'succeeded', confirmedSeq: 3 })
    expect(advanceExecution(done, { ...base, statusKnowledge: 'unknown', state: 'running', confirmedSeq: 2,
      reason: { code: 'worker-terminated', detail: '页面已关闭' } }).state).toBe('succeeded')
    expect(advanceExecution(done, { ...base, confirmedSeq: 1 }).confirmedSeq).toBe(3)
    expect(advanceExecution(done, { ...base, state: 'cancelled', confirmedSeq: 4 }).state).toBe('succeeded')
  })
  it('degrades only knowledge, never the last confirmed state, and keeps a requested stop', () => {
    const base = query({})
    const unknown = advanceExecution(base, { ...base, statusKnowledge: 'unknown', confirmedSeq: 2,
      reason: { code: 'worker-terminated', detail: '原页面已关闭' } })
    expect(unknown).toMatchObject({ state: 'running', statusKnowledge: 'unknown', stopRequested: false })
    const stopped = advanceExecution(base, { ...base, stopRequested: true, confirmedSeq: 3 })
    expect(advanceExecution(stopped, { ...base, stopRequested: false, confirmedSeq: 4 }).stopRequested).toBe(true)
    // A stop request on its own is not a terminal fact.
    expect(stopped.state).toBe('running')
  })
  it('refuses to mix two executions', () => {
    const base = query({})
    expect(() => advanceExecution(base, { ...base, executionRef: crypto.randomUUID() })).toThrow('invalid-input')
  })
})

const record = (patch: Partial<ExecutionRecord> = {}): ExecutionRecord => ({ scope: 'scope', requestId: crypto.randomUUID(),
  inputDigest: 'a'.repeat(64), executionRef: crypto.randomUUID(), generation: 1,
  action: {} as ExecutionRecord['action'], acceptance: {} as ExecutionRecord['acceptance'],
  query: query({}), startedAt: 1, stoppedAt: null, createdAt: 0, ...patch })

describe('stop and reload decisions', () => {
  it('cancels before a worker starts and stops a worker that already runs', () => {
    expect(stopDecision(record({ startedAt: null }), query({ state: 'queued', confirmedSeq: 1 }))).toBe('pre-start-cancel')
    expect(stopDecision(record(), query({}))).toBe('stop-worker')
    expect(stopDecision(null, null)).toBe('blocked')
    expect(stopDecision(record(), query({ state: 'succeeded', confirmedSeq: 5 }))).toBe('already-terminal')
  })
  it('turns a reload into unknown knowledge without inventing a terminal state', () => {
    expect(abandonedQuery(query({})).statusKnowledge).toBe('unknown')
    expect(abandonedQuery(query({})).state).toBe('running')
    const finished = query({ state: 'succeeded', confirmedSeq: 6 })
    expect(abandonedQuery(finished)).toEqual(finished)
    const next = progressQuery(query({}), { state: 'running', confirmedSeq: 3 })
    expect(next.state).toBe('running')
  })
})

describe('the action envelope keeps legacy question actions byte-identical', () => {
  const legacy = { requestId: crypto.randomUUID(), scope,
    receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' },
    draft: { token: crypto.randomUUID(), question: '为什么是甲？', references: [], bases: [] },
    works: [{ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: '原文.txt', kind: 'text',
      encoding: 'utf8', mediaType: 'text/plain', value: '甲' }], evidence: [] }
  it('does not add a discriminator or rewrite the fixed basis of an old record', () => {
    const before = JSON.stringify(actionInputSchema.parse(legacy))
    expect(fixedActionKind(legacy)).toBe('question')
    expect(before).not.toContain('protocolVersion')
    expect(JSON.parse(before).draft.question).toBe('为什么是甲？')
  })
  it('requires an execution receiver, the scope principal and a declared effect', () => {
    const base = { protocolVersion: 2, kind: 'execution', requestId: crypto.randomUUID(), scope,
      receiver: { receiverId: 'browser-table', location: 'local', kind: 'execution' },
      execution: { instance: { instanceId: 'i', key: 'table', componentId: crypto.randomUUID(), componentVersion: 1,
        definitionDigest: 'b'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: 'aggregate', effect: 'execute' }, parameters: { groupColumn: '班级' },
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 1048576, concurrentJobs: 2, queuedJobs: 4 },
        plan: { planId: 'browser-job', planVersion: 1, planDigest: 'c'.repeat(64), location: 'browser', kind: 'job' },
        initiator: { kind: 'student', principalId: scope.principalId } } }
    expect(executionActionSchema.parse(base).execution.operation.operationId).toBe('aggregate')
    expect(() => executionActionSchema.parse({ ...base, receiver: { ...base.receiver, kind: 'question' } })).toThrow()
    expect(() => executionActionSchema.parse({ ...base, execution: { ...base.execution,
      initiator: { kind: 'student', principalId: crypto.randomUUID() } } })).toThrow()
    expect(() => executionActionSchema.parse({ ...base, execution: { ...base.execution,
      operation: { operationId: 'aggregate', effect: 'write' } } })).toThrow()
  })
})

describe('the published component matches its own manifest', () => {
  it('pins the algorithm and view bytes the release will serve', async () => {
    const { aggregationPackage } = await import('../../../../components/table-aggregation/package.mjs')
    const published = await aggregationPackage()
    const wasm = Buffer.from(published.algorithmBase64, 'base64')
    const view = Buffer.from(published.contentBase64, 'base64')
    expect(wasm.equals(algorithm)).toBe(true)
    expect(wasm.length).toBe(published.manifest.algorithm!.resource.byteLength)
    expect(view.length).toBe(published.manifest.entry.byteLength)
    // The declared result structure really accepts what this algorithm returns for the sample table.
    const sample = published.manifest.initialState as { table: AggregationTable }
    const outcome = run({ table: sample.table, parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } })
    expect(acceptsState(published.manifest.operations![0]!.result as StateShape, outcome.result)).toBe(true)
    expect(acceptsState(published.manifest.operations![0]!.result as StateShape, { ...outcome.result, value: 'x' })).toBe(false)
  })
  it('ships a view that cannot reach the network, storage or a second port', () => {
    const view = readFileSync(new URL('../../../../components/table-aggregation/view.html', import.meta.url), 'utf8')
    expect(view).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|importScripts|sessionStorage|localStorage|document\.cookie/)
    expect(view).not.toMatch(/https?:\/\//)
    // The only message source it accepts is the host's transferred port.
    expect(view).toContain('event.ports[0]')
    expect(view).toContain("event.source !== parent")
  })
})
