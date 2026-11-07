import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { executionActionV3Schema, type ExecutionActionV3 } from '@xunjie/contracts/execution'
import { AdapterRegistry } from './adapter'
import { ExecutionController } from './controller'
import { expectedAlu, indexInputs, type AluRow } from './adapters/alu-check'
import { createAluAdapter } from './adapters/alu'
import { BrowserExecutionReceiver } from './receiver'

const mock = vi.hoisted(() => ({
  variant: 'correct' as 'correct' | 'drop-carry' | 'x-reserved',
  compileDelayMs: 0,
  simulateMode: 'normal' as 'normal' | 'fatal' | 'timeout' | 'failed-check',
  simulateDelayMs: 0,
  checkStdout: '',
}))
vi.mock('./icarus-runtime', () => ({
  aluOperationIds: ['run-single', 'observe-enabled', 'check-all'],
  icarusProfile: { adapterId: 'icarus-alu', adapterVersion: 1, operationIds: ['run-single', 'observe-enabled', 'check-all'], memoryMiB: 256 },
  verifiedIcarus: async () => ({
    async compile(_input: unknown, { signal }: { signal: AbortSignal }) {
      if (signal.aborted) return { status: 'stopped', stage: 'compile', diagnostics: ['compile observed abort'], cacheHit: false }
      if (mock.compileDelayMs) await new Promise(resolve => setTimeout(resolve, mock.compileDelayMs))
      if (signal.aborted) return { status: 'stopped', stage: 'compile', diagnostics: ['compile observed abort'], cacheHit: false }
      return { status: 'completed', stage: 'compile', diagnostics: [], cacheHit: false,
      artifact: { version: 1, dependencyId: 'd'.repeat(64), bundleIdentity: 'b'.repeat(64), program: new Uint8Array([1]),
        programSha256: 'e'.repeat(64) } }
    },
    async simulate(request: { plusargs?: string[]; expectedIndices?: number[] }, { signal }: { signal: AbortSignal }) {
      if (mock.simulateDelayMs) await new Promise(resolve => setTimeout(resolve, mock.simulateDelayMs))
      const round = Number(request.plusargs?.find(arg => arg.startsWith('+ROUND='))?.split('=')[1] ?? 0)
      if (signal.aborted) return { status: 'stopped', stage: 'simulate', diagnostics: ['simulate observed abort'],
        dependencyId: 'd'.repeat(64), output: [], vcd: null, observations: [], observationState: 'unavailable' }
      if (mock.simulateMode === 'fatal') return { status: 'failed', stage: 'simulate', diagnostics: [],
        dependencyId: 'd'.repeat(64), output: ['FATAL: full boundary failure at alu.sv:27 scope=experiment.core @ 12ns'],
        vcd: null, observations: [], observationState: 'unavailable' }
      if (mock.simulateMode === 'timeout') return { status: 'budget-exceeded', stage: 'simulate', diagnostics: [],
        dependencyId: 'd'.repeat(64), output: ['simulation deadline exceeded'], vcd: null, observations: [],
        observationState: 'unavailable' }
      if (mock.simulateMode === 'failed-check' && request.expectedIndices?.length === 4096 && round === 1)
        return { status: 'failed', stage: 'simulate', diagnostics: ['round two diagnostic'], dependencyId: 'd'.repeat(64),
          output: ['round two stdout log'], vcd: null, observations: [], observationState: 'unavailable' }
      const sample = Number(request.plusargs?.find(arg => arg.startsWith('+SAMPLE='))?.split('=')[1] ?? 1)
      const rows: AluRow[] = (request.expectedIndices ?? []).map(index => {
        const inputs = indexInputs(index)
        if (mock.variant === 'x-reserved' && inputs.M === 1 && inputs.S !== 0) return { index, f: 'xxxx', cout: 'x' }
        const value = expectedAlu(inputs)
        return mock.variant === 'drop-carry' && inputs.M === 1 && inputs.S === 0
          ? { index, f: value.f, cout: '0' } : { index, f: value.f, cout: value.cout }
      })
      return { status: 'completed', stage: 'simulate', diagnostics: [], dependencyId: 'd'.repeat(64),
        output: request.expectedIndices?.length === 4096 ? [`check stdout round=${round} sample=${sample}`, ...(mock.checkStdout ? [mock.checkStdout] : [])] : [],
        vcd: `$enddefinitions $end\n#${round}${sample}\n`, observations: rows,
        observationState: mock.variant === 'x-reserved' ? 'complete-with-unknown' : 'complete' }
    },
  }),
}))

const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
  activityId: crypto.randomUUID() }
const uuid = () => crypto.randomUUID()
const scaffoldResourceId = uuid()
const action = (operationId: 'check-all' | 'run-single', parameters: unknown, jobTimeoutMs = 10000): ExecutionActionV3 =>
  executionActionV3Schema.parse({ protocolVersion: 3, kind: 'execution', requestId: uuid(), scope: identity,
    receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
    execution: {
      instance: { instanceId: `${identity.activityId}:alu`, key: 'alu', componentId: uuid(), componentVersion: 2,
        definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 2 },
      operation: { operationId, effect: 'execute' }, parameters,
      basis: { works: [{ objectId: uuid(), contentId: uuid(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
        mediaType: 'text/plain', value: 'module alu; endmodule' }],
        runtime: { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: 'b'.repeat(64), resources: [{
          resourceId: scaffoldResourceId, sha256: 'c'.repeat(64), byteLength: 20, path: 'check.sv', role: 'scaffold',
          mediaType: 'text/plain' }] },
        compile: { top: 'experiment', entryFiles: ['alu.sv'], includeDirs: [] },
        observation: { scaffoldResourceId, scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' },
          resultFormat: 'xunjie-observations-v1' },
        course: { releaseId: uuid(), behaviorRuleDigest: 'd'.repeat(64), planDigest: 'e'.repeat(64) },
        expected: { stateContentId: null } },
      limits: { compileTimeoutMs: 1000, simulateTimeoutMs: 1000, jobTimeoutMs, memoryMiB: 256,
        inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216,
        concurrentJobs: 1, queuedJobs: 1 },
      plan: { planId: 'browser-job', planVersion: 1, planDigest: 'f'.repeat(64), location: 'browser', kind: 'job' },
      initiator: { kind: 'student', principalId: identity.principalId },
    } })
const context = { signal: new AbortController().signal, checkpoint: async () => {} }

beforeEach(() => {
  mock.variant = 'correct'; mock.compileDelayMs = 0; mock.simulateMode = 'normal'; mock.simulateDelayMs = 0
  mock.checkStdout = ''
})

describe('ALU adapter operations', () => {
  it('declares the three ALU operations and validates their parameters before acceptance', async () => {
    const { createAluAdapter } = await import('./adapters/alu')
    const adapter = createAluAdapter(async () => ({ 'check.sv': new TextEncoder().encode('module experiment; endmodule') }))
    expect(adapter.handles(action('check-all', {}))).toBe(true)
    expect(adapter.handles(action('run-single', { A: 0, B: 0, M: 0, S: 0, Cin: 0 }))).toBe(true)
    expect(() => adapter.validateAndFreeze(action('check-all', { A: 0 }))).toThrow('invalid-input')
    expect(() => adapter.validateAndFreeze(action('run-single', { A: 16, B: 0, M: 0, S: 0, Cin: 0 }))).toThrow('invalid-input')
  })

  it('packs a pass report, all 16384 observations, diagnostics and the four VCDs in four retained resources', async () => {
    const { createAluAdapter } = await import('./adapters/alu')
    const adapter = createAluAdapter(async () => ({ 'check.sv': new TextEncoder().encode('module experiment; endmodule') }))
    const result = await adapter.run(action('check-all', {}), context)
    expect(result.resources.map(resource => resource.name)).toEqual(['check-report.json', 'check-observations.json',
      'diagnostics.txt', 'check-traces.json'])
    const report = JSON.parse(result.resources[0]!.text)
    expect(report).toMatchObject({ kind: 'alu-check', verdict: 'pass', totalInputs: 4096, plannedSamples: 16384,
      sampledRows: 16384, comparedRows: 16384, fullyComparedInputs: 4096, reservedCovered: 1536,
      behaviorErrorInputs: 0, unknownInputs: 0, inconsistentInputs: 0, missingInputs: 0, roundsCompleted: 4 })
    const observations = JSON.parse(result.resources[1]!.text)
    expect(observations.rounds).toHaveLength(4)
    expect(observations.rounds.every((round: { rows: unknown[] }) => round.rows.length === 4096)).toBe(true)
    expect(observations.counterexamples).toHaveLength(0)
    const traces = JSON.parse(result.resources[3]!.text)
    expect(traces.rounds).toHaveLength(4)
    expect(traces.rounds.every((round: { vcd: string | null }) => typeof round.vcd === 'string')).toBe(true)
    expect(result.output).toMatchObject({ verdict: 'pass', totalInputs: 4096, roundsCompleted: 4 })
  })

  it('reports the fixed negative variants without inflating their input counts', async () => {
    const { createAluAdapter } = await import('./adapters/alu')
    const adapter = createAluAdapter(async () => ({ 'check.sv': new TextEncoder().encode('module experiment; endmodule') }))
    mock.variant = 'drop-carry'
    const drop = await adapter.run(action('check-all', {}), context)
    expect(JSON.parse(drop.resources[0]!.text)).toMatchObject({ verdict: 'fail', behaviorErrorInputs: 256,
      counterexampleTotal: 256, comparedRows: 16384 })
    mock.variant = 'x-reserved'
    const x = await adapter.run(action('check-all', {}), context)
    expect(JSON.parse(x.resources[0]!.text)).toMatchObject({ verdict: 'fail', unknownInputs: 1536,
      fullyComparedInputs: 2560, counterexampleTotal: 1536 })
  })
})

const controllers: ExecutionController[] = []
const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const offline = { accept: async () => { throw new Error('offline') }, report: async () => { throw new Error('offline') },
  stop: async () => { throw new Error('offline') }, result: async () => { throw new Error('offline') }, read: async () => { throw new Error('offline') } }
function durableRun(load: (value: ExecutionActionV3) => Promise<Record<string, Uint8Array>> = async () => ({
  'check.sv': new TextEncoder().encode('module experiment; endmodule'),
})) {
  const selected = action('run-single', { A: 1, B: 2, M: 0, S: 0, Cin: 0 })
  const scope = uuid(), receiver = new BrowserExecutionReceiver(selected.receiver, scope, 1)
  const controller = new ExecutionController(scope, receiver, {
    createExecution: async input => {
      const submitted = executionActionV3Schema.parse({ ...selected, ...input, protocolVersion: 3 })
      return receiver.accept(submitted, digestOf(submitted))
    },
    cancel: async () => null,
  }, offline, new AdapterRegistry([createAluAdapter(load)]))
  controllers.push(controller)
  return { selected, scope, receiver, controller }
}
const until = async (check: () => unknown | Promise<unknown>) => {
  await vi.waitFor(async () => { expect(await check()).toBeTruthy() }, { timeout: 4000, interval: 10 })
}
async function terminal(env: ReturnType<typeof durableRun>) {
  await until(async () => {
    const query = await env.controller.query(env.selected.requestId)
    return query && ['succeeded', 'failed', 'cancelled'].includes(query.state)
  })
  return (await env.controller.query(env.selected.requestId))!
}
async function reopen(env: ReturnType<typeof durableRun>) {
  const receiver = new BrowserExecutionReceiver(env.selected.receiver, env.scope, 2)
  const controller = new ExecutionController(env.scope, receiver, { createExecution: async () => null,
    cancel: async () => null }, offline, new AdapterRegistry([createAluAdapter(async () => ({}))]))
  controllers.push(controller)
  await controller.open()
  return { query: await controller.query(env.selected.requestId), result: await controller.artifact(env.selected.requestId) }
}
afterEach(async () => {
  for (const controller of controllers) controller.dispose()
  controllers.length = 0
  vi.restoreAllMocks()
})

describe('ALU budget and retained product logs', () => {
  it.each(['loader', 'compile'] as const)('%s deadline is a failed budget result and remains queryable after reopen', async stage => {
    if (stage === 'compile') mock.compileDelayMs = 1200
    const env = durableRun(stage === 'loader' ? async () => {
      await new Promise(resolve => setTimeout(resolve, 1200))
      return { 'check.sv': new TextEncoder().encode('module experiment; endmodule') }
    } : undefined)
    const timed = { ...env.selected, execution: { ...env.selected.execution,
      limits: { ...env.selected.execution.limits, jobTimeoutMs: 1000 } } }
    await env.controller.submit(timed)
    const query = await terminal({ ...env, selected: timed })
    expect(query.state).toBe('failed')
    expect(query.reason?.code).toBe('budget-exceeded')
    const reopened = await reopen({ ...env, selected: timed })
    expect(reopened.query).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    expect(reopened.result).not.toBeNull()
  }, 6000)

  it('a simulation timeout is failed with budget-exceeded and its terminal fact survives reopen', async () => {
    mock.simulateMode = 'timeout'
    const env = durableRun()
    await env.controller.submit(env.selected)
    const query = await terminal(env)
    expect(query).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    expect((await reopen(env)).query).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
  })

  it('a user stop stays cancelled after a later job deadline', async () => {
    mock.simulateDelayMs = 1200
    const env = durableRun()
    const timed = { ...env.selected, execution: { ...env.selected.execution,
      limits: { ...env.selected.execution.limits, jobTimeoutMs: 1000 } } }
    await env.controller.submit(timed)
    await until(() => env.controller.counts().running === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    await env.controller.stop(timed.requestId, uuid())
    expect(await terminal({ ...env, selected: timed })).toMatchObject({ state: 'cancelled' })
    expect((await reopen({ ...env, selected: timed })).query).toMatchObject({ state: 'cancelled' })
  }, 6000)

  it('keeps the first job deadline when a user stops at 1050ms before the 1200ms loader resolves', async () => {
    let started!: () => void, finished!: () => void, loaderResolved = false
    const loaderStarted = new Promise<void>(resolve => { started = resolve })
    const loaderFinished = new Promise<void>(resolve => { finished = resolve })
    const env = durableRun(async () => {
      started()
      await new Promise(resolve => setTimeout(resolve, 1200))
      loaderResolved = true
      finished()
      return { 'check.sv': new TextEncoder().encode('module experiment; endmodule') }
    })
    const timed = { ...env.selected, execution: { ...env.selected.execution,
      limits: { ...env.selected.execution.limits, jobTimeoutMs: 1000 } } }
    const checked = { ...env, selected: timed }
    await env.controller.submit(timed)
    await loaderStarted
    await new Promise(resolve => setTimeout(resolve, 1050))
    expect(loaderResolved, 'the later stop occurs while the original loader is still pending').toBe(false)
    await env.controller.stop(timed.requestId, uuid())
    expect(await terminal(checked)).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    await loaderFinished
    const reopened = await reopen(checked)
    expect(reopened.query).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    expect(reopened.result).not.toBeNull()
  }, 6000)

  it('retains full fatal stdout context in the diagnostics artifact after reopen', async () => {
    mock.simulateMode = 'fatal'
    const env = durableRun()
    await env.controller.submit(env.selected)
    const query = await terminal(env)
    expect(query).toMatchObject({ state: 'failed' })
    const result = (await reopen(env)).result!
    const diagnostics = result.resources?.find(resource => resource.name === 'diagnostics.txt')?.text ?? ''
    expect(diagnostics).toContain('FATAL: full boundary failure at alu.sv:27 scope=experiment.core @ 12ns')
  })

  it('retains stdout from all successful check rounds in the diagnostics artifact after reopen', async () => {
    const env = durableRun()
    const check = action('check-all', {})
    const receiver = env.receiver
    const controller = new ExecutionController(env.scope, receiver, {
      createExecution: async input => {
        const submitted = executionActionV3Schema.parse({ ...check, ...input, protocolVersion: 3 })
        return receiver.accept(submitted, digestOf(submitted))
      },
      cancel: async () => null,
    }, offline, new AdapterRegistry([createAluAdapter(async () => ({
      'check.sv': new TextEncoder().encode('module experiment; endmodule'),
    }))]))
    controllers.push(controller)
    await controller.submit(check)
    const checked = { ...env, selected: check, controller }
    expect(await terminal(checked)).toMatchObject({ state: 'succeeded' })
    const diagnostics = (await reopen(checked)).result?.resources?.find(resource => resource.name === 'diagnostics.txt')?.text ?? ''
    for (const round of [0, 1]) for (const sample of [1, 2])
      expect(diagnostics).toContain(`check stdout round=${round} sample=${sample}`)
  }, 6000)

  it('preserves reports and bounded UTF-8 diagnostics after four rounds exceed the cumulative text budget', async () => {
    mock.checkStdout = '界'.repeat(204800) // 600 KiB per round, below the runtime's individual 2 MiB limit.
    const env = durableRun()
    const check = action('check-all', {})
    const controller = new ExecutionController(env.scope, env.receiver, {
      createExecution: async input => {
        const submitted = executionActionV3Schema.parse({ ...check, ...input, protocolVersion: 3 })
        return env.receiver.accept(submitted, digestOf(submitted))
      },
      cancel: async () => null,
    }, offline, new AdapterRegistry([createAluAdapter(async () => ({
      'check.sv': new TextEncoder().encode('module experiment; endmodule'),
    }))]))
    controllers.push(controller)
    const checked = { ...env, selected: check, controller }
    await controller.submit(check)
    expect(await terminal(checked)).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    const reopened = await reopen(checked)
    expect(reopened.query).toMatchObject({ state: 'failed', reason: { code: 'budget-exceeded' } })
    expect(reopened.result, 'budget failure must retain the original check artifacts').not.toBeNull()
    const result = reopened.result!
    expect(JSON.parse(result.text)).toMatchObject({ kind: 'alu-check', totalInputs: 4096,
      plannedSamples: 16384, sampledRows: 16384, roundsCompleted: 4 })
    const observations = result.resources?.find(resource => resource.name === 'check-observations.json')
    expect(observations, 'original sampled observations remain reopenable').toBeTruthy()
    const retained = JSON.parse(observations!.text)
    expect(retained).toMatchObject({ kind: 'alu-check-observations', totalInputs: 4096, plannedSamples: 16384 })
    expect(retained.rounds).toHaveLength(4)
    expect(retained.rounds.map((round: { rows: unknown[] }) => round.rows.length)).toEqual([4096, 4096, 4096, 4096])
    const diagnostics = result.resources?.find(resource => resource.name === 'diagnostics.txt')
    expect(diagnostics).toBeTruthy()
    expect(new TextEncoder().encode(diagnostics!.text).length).toBeLessThanOrEqual(check.execution.limits.textBytes)
    expect(diagnostics!.text).toContain('check stdout round=0 sample=1')
    expect(diagnostics!.text).toContain('界')
    expect(diagnostics!.text).not.toContain('\uFFFD')
    expect(diagnostics!.text).toContain('[日志达到本次文本预算，后续内容未保留。]')
  }, 6000)

  it('retains stdout and diagnostics from the failed check round in the product artifact', async () => {
    mock.simulateMode = 'failed-check'
    const env = durableRun()
    const check = action('check-all', {})
    const receiver = env.receiver
    const controller = new ExecutionController(env.scope, receiver, {
      createExecution: async input => {
        const submitted = executionActionV3Schema.parse({ ...check, ...input, protocolVersion: 3 })
        return receiver.accept(submitted, digestOf(submitted))
      },
      cancel: async () => null,
    }, offline, new AdapterRegistry([createAluAdapter(async () => ({
      'check.sv': new TextEncoder().encode('module experiment; endmodule'),
    }))]))
    controllers.push(controller)
    await controller.submit(check)
    const checked = { ...env, selected: check, controller }
    expect(await terminal(checked)).toMatchObject({ state: 'failed' })
    const result = (await reopen(checked)).result!
    const diagnostics = result.resources?.find(resource => resource.name === 'diagnostics.txt')?.text ?? ''
    expect(diagnostics).toContain('round two stdout log')
    expect(diagnostics).toContain('round two diagnostic')
  }, 6000)
})
