import { textHash } from './confirmation'
import type { HdlActivityExecution } from './hdlActivityContracts'
export type { HdlActivityExecution } from './hdlActivityContracts'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const image = (v: unknown): v is string => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v)
const widths: Record<string, number> = { clock: 1, switches: 16, buttons: 5, resetN: 1, leds: 16, anodes: 8, segments: 7, dp: 1 }
const requiredSignals = ['clock', 'switches', 'leds', 'anodes', 'segments', 'dp']

/** Fail closed on a mismatched projection; missing execution preserves the original C route. */
export async function verifyHdlActivity(value: unknown, activityProfile: string): Promise<HdlActivityExecution | undefined> {
  if (value === undefined) return undefined
  const invalid = () => { throw new Error('HDL 活动配置或版本不完整，不能采用模拟板卡或发送运行。') }
  if (!object(value) || value.kind !== 'hdl_board' || value.runtimeProfileVersion !== activityProfile || !hash(value.contentHash) ||
    !object(value.configuration)) return invalid()
  const cfg = value.configuration, runtime = cfg.runtime, board = cfg.board, signals = cfg.signals
  if (!id(cfg.versionId) || !object(runtime) || runtime.runtimeProfileVersion !== activityProfile || !id(runtime.engineVersion) ||
    !image(runtime.buildImage) || !image(runtime.runtimeImage) || !hash(runtime.sourceHash) || !object(board) ||
    !id(board.boardProfileVersion) || !id(board.mappingVersion) || !id(board.topModule) || !Array.isArray(board.bindings) ||
    board.bindings.length === 0 || board.bindings.length > 128 || !object(signals)) return invalid()
  const expected = { bitOrder: 'msb_first', clockHz: 100000000, initialClock: '0', initialSwitches: '0000000000000000',
    initialButtons: '00000', initialResetN: '1', stableSampling: 'low_phase', anodesActive: 'low', segmentsActive: 'low', dpActive: 'low' }
  if (Object.entries(expected).some(([key, fixed]) => signals[key] !== fixed)) return invalid()
  const covered = new Set<string>()
  const portBits = new Set<string>()
  for (const b of board.bindings) {
    if (!object(b) || typeof b.signal !== 'string' || !Object.hasOwn(widths, b.signal) || !id(b.port) || !Number.isSafeInteger(b.offset) ||
      !Number.isSafeInteger(b.portOffset) || !Number.isSafeInteger(b.width) || Number(b.offset) < 0 || Number(b.portOffset) < 0 ||
      Number(b.width) < 1 || Number(b.offset) + Number(b.width) > widths[b.signal]!) return invalid()
    for (let bit = Number(b.offset); bit < Number(b.offset) + Number(b.width); bit++) {
      const key = `${b.signal}:${bit}`
      const portBit = `${b.port}:${Number(b.portOffset) + bit - Number(b.offset)}`
      if (covered.has(key) || portBits.has(portBit)) return invalid()
      covered.add(key)
      portBits.add(portBit)
    }
  }
  if (requiredSignals.some(signal => Array.from({ length: widths[signal]! }, (_, bit) => `${signal}:${bit}`).some(bit => !covered.has(bit))) || cfg.structuralCoverage !== 'board_bindings_and_defined_alu_domain' ||
    !Object.hasOwn(cfg, 'alu') || await textHash(JSON.stringify(cfg)) !== value.contentHash) return invalid()
  return value as unknown as HdlActivityExecution
}
