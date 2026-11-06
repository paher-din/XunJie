import { ALU_CONTROLS, type AluControl } from './state'

/** Physical SW/LED numbers in the published course configuration, ordered port MSB first. */
export interface AluBoardMapping {
  version: 1
  inputs: Record<AluControl, readonly number[]>
  outputs: { F: readonly number[]; Cout: readonly number[] }
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Unknown or invalid mappings stay unavailable; the host never repairs them with hidden wiring. */
export function parseAluBoardMapping(value: unknown): AluBoardMapping | null {
  const source = recordOf(value), inputs = recordOf(source?.inputs), outputs = recordOf(source?.outputs)
  if (source?.version !== 1 || !inputs || !outputs) return null
  const pins = (value: unknown, width: number): value is number[] => Array.isArray(value)
    && value.length === width && value.every(pin => Number.isInteger(pin) && pin >= 0 && pin <= 15)
  const { A, B, M, S, Cin } = inputs
  if (Object.keys(inputs).length !== ALU_CONTROLS.length || Object.keys(outputs).length !== 2
    || !pins(A, 4) || !pins(B, 4) || !pins(M, 1) || !pins(S, 2) || !pins(Cin, 1)
    || !pins(outputs.F, 4) || !pins(outputs.Cout, 1)) return null
  const inputPins = [...A, ...B, ...M, ...S, ...Cin]
  const outputPins = [...outputs.F, ...outputs.Cout]
  if (new Set(inputPins).size !== inputPins.length || new Set(outputPins).size !== outputPins.length) return null
  return { version: 1,
    inputs: { A: [...A], B: [...B], M: [...M], S: [...S], Cin: [...Cin] },
    outputs: { F: [...outputs.F], Cout: [...outputs.Cout] } }
}
