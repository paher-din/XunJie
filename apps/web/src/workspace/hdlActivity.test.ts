import { describe, expect, it } from 'vitest'
import { textHash } from './confirmation'
import { verifyHdlActivity } from './hdlActivity'

const widths = { clock: 1, switches: 16, buttons: 5, resetN: 1, leds: 16, anodes: 8, segments: 7, dp: 1 }
function configuration() {
  return { versionId: 'cfg', board: { boardProfileVersion: 'board', mappingVersion: 'mapping', topModule: 'top',
    bindings: Object.entries(widths).map(([signal, width]) => ({ signal, offset: 0, port: signal, portOffset: 0, width })) },
  runtime: { runtimeProfileVersion: 'hdl', engineVersion: 'engine', buildImage: `sha256:${'a'.repeat(64)}`,
    runtimeImage: `sha256:${'b'.repeat(64)}`, sourceHash: 'c'.repeat(64) },
  signals: { bitOrder: 'msb_first', clockHz: 100000000, initialClock: '0', initialSwitches: '0000000000000000',
    initialButtons: '00000', initialResetN: '1', stableSampling: 'low_phase', anodesActive: 'low', segmentsActive: 'low', dpActive: 'low' },
  alu: { courseData: 'opaque to board rendering' }, structuralCoverage: 'board_bindings_and_defined_alu_domain' }
}
async function projection(cfg = configuration()) {
  return { kind: 'hdl_board', runtimeProfileVersion: 'hdl', configuration: cfg, contentHash: await textHash(JSON.stringify(cfg)) }
}
describe('authorized HDL Activity projection', () => {
  it('missing execution preserves the original C route', async () => {
    expect(await verifyHdlActivity(undefined, 'c17')).toBeUndefined()
  })
  it('keeps the exact approved binding and configuration bytes', async () => {
    const value = await projection()
    expect(await verifyHdlActivity(value, 'hdl')).toBe(value)
  })
  it('accepts original optional or partly bound buttons/reset without inventing bindings', async () => {
    for (const omitted of [['resetN'], ['buttons', 'resetN']]) {
      const cfg = configuration(); cfg.board.bindings = cfg.board.bindings.filter(binding => !omitted.includes(binding.signal))
      const value = await projection(cfg)
      expect(await verifyHdlActivity(value, 'hdl')).toBe(value)
    }
    const cfg = configuration(); cfg.board.bindings.find(binding => binding.signal === 'buttons')!.width = 1
    const value = await projection(cfg)
    expect(await verifyHdlActivity(value, 'hdl')).toBe(value)
  })
  it('rejects aliasing two logical signals to the same physical port bit', async () => {
    const cfg = configuration()
    cfg.board.bindings.find(binding => binding.signal === 'resetN')!.port = 'clock'
    await expect(verifyHdlActivity(await projection(cfg), 'hdl')).rejects.toThrow()
  })
  it('cannot select a different runtime using an HDL file extension or mismatched profile', async () => {
    await expect(verifyHdlActivity(await projection(), 'c17')).rejects.toThrow()
    await expect(verifyHdlActivity({ kind: 'other' }, 'hdl')).rejects.toThrow()
  })
  it('rejects changed configuration even when its shape still looks correct', async () => {
    const value = await projection()
    value.configuration.board.topModule = 'changed'
    await expect(verifyHdlActivity(value, 'hdl')).rejects.toThrow()
  })
  it.each(['clockHz', 'stableSampling', 'segmentsActive', 'initialResetN'])('does not silently repair %s', async key => {
    const cfg = configuration()
    Object.assign(cfg.signals, { [key]: 'unsupported' })
    await expect(verifyHdlActivity(await projection(cfg), 'hdl')).rejects.toThrow()
  })
  it('rejects missing or duplicate logical bindings and unsafe offsets', async () => {
    const missing = configuration(); missing.board.bindings.pop()
    const duplicate = configuration(); duplicate.board.bindings.push(duplicate.board.bindings[0]!)
    const unsafe = configuration(); unsafe.board.bindings[0]!.offset = -1
    for (const cfg of [missing, duplicate, unsafe]) await expect(verifyHdlActivity(await projection(cfg), 'hdl')).rejects.toThrow()
  })
})
