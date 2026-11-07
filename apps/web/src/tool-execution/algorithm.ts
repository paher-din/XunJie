/**
 * Fixed table aggregation over a restricted WebAssembly algorithm.
 *
 * The host owns every boundary here: it supplies the only linear memory, refuses any
 * other import, bounds the input and output, and maps a NaN result to a real failure
 * instead of manufacturing a number. The algorithm never reads this document.
 */
import type { ExecutionAction, ExecutionLimits } from '@xunjie/contracts/execution'
import { ExecutionError } from './errors'
export interface AggregationTable { columns: string[]; rows: string[][] }
export interface AggregationParameters { groupColumn: string; valueColumn: string; aggregate: 'count' | 'sum' | 'mean' }
export interface AggregationGroup { key: string; count: number; value: number; sum: number; mean: number; min: number; max: number }
export interface AggregationResult { rows: number; aggregate: AggregationParameters['aggregate']
  groupColumn: string; valueColumn: string; groups: AggregationGroup[]; value: number; rejected: number[] }
export interface AggregationArtifact { name: string; mediaType: string; text: string }
export interface AggregationOutcome { result: AggregationResult; artifact: AggregationArtifact }

/** The aggregation ABI's own failures; every code is a real published reason, never a fallback. */
export class AlgorithmError extends ExecutionError {}

/** What the worker really receives. The ABI's own mapping lives here, not in the generic executor. */
export interface AlgorithmJob { bytes: ArrayBuffer; memoryPages: number; entry: string; table: AggregationTable
  parameters: AggregationParameters; inputBytes: number; outputBytes: number; timeMs: number }

/**
 * The fixed command already carries the state copy and the declared parameters, so the ABI reads
 * the job from it instead of guessing from the live workspace.
 */
export function jobFromAction(action: ExecutionAction, limits: ExecutionLimits): Omit<AlgorithmJob,
  'bytes' | 'memoryPages' | 'entry'> {
  const value = action.execution.parameters as { groupColumn?: unknown; valueColumn?: unknown; aggregate?: unknown }
  const aggregate = String(value.aggregate ?? 'count')
  if (!(aggregate in aggregateModes)) throw new AlgorithmError('invalid-input', '聚合方式不在已声明的范围内。')
  const parameters: AggregationParameters = { groupColumn: String(value.groupColumn ?? ''),
    valueColumn: String(value.valueColumn ?? ''), aggregate: aggregate as AggregationParameters['aggregate'] }
  const state = action.execution.basis.state
  const file = action.execution.basis.works.find(candidate => candidate.name === state?.name)
  let content: unknown
  try { content = file ? JSON.parse(file.value) : undefined } catch { throw new AlgorithmError('invalid-input', '固定输入的状态副本无法读取。') }
  const table = (content as { content?: { table?: { columns?: unknown; rows?: unknown } } } | undefined)?.content?.table
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows))
    throw new AlgorithmError('invalid-input', '固定输入缺少已声明的表格结构。')
  return { table: table as AggregationTable, parameters, inputBytes: limits.inputBytes,
    outputBytes: limits.outputBytes, timeMs: limits.timeMs }
}

export const aggregateModes: Record<AggregationParameters['aggregate'], number> = { count: 0, sum: 1, mean: 2 }
const MODE_COUNT = 0, MODE_SUM = 1, MODE_MEAN = 2, MODE_MIN = 3, MODE_MAX = 4
const MAX_GROUPS = 200, MAX_COLUMNS = 12, MAX_ROWS = 2000

interface AlgorithmInstance { aggregate(ptr: number, count: number, mode: number): number; memory: WebAssembly.Memory }

/** Module.imports omits defined (including unexported) memories and tables. This ABI needs no
 * tables and only host memory; reject other storage before instantiation can allocate it. */
function assertNoDefinedStorage(bytes: Uint8Array) {
  let offset = 8 // The engine has already validated the magic, version and section encoding.
  const invalid = () => new AlgorithmError('algorithm-error', '算法内存声明无法核实，已拒绝实例化。')
  const readU32 = () => {
    let value = 0
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = bytes[offset++]
      if (byte === undefined || (shift === 28 && byte > 15)) throw invalid()
      value += (byte & 127) * 2 ** shift
      if (!(byte & 128)) return value
    }
    throw invalid()
  }
  while (offset < bytes.length) {
    const section = bytes[offset++]
    const size = readU32(), end = offset + size
    if (end > bytes.length) throw invalid()
    if (section === 4 && readU32() !== 0)
      throw new AlgorithmError('algorithm-error', '算法不能定义 table，当前聚合接口只允许受预算限制的宿主内存。')
    if (section === 5 && readU32() !== 0)
      throw new AlgorithmError('algorithm-error', '算法不能定义额外线性内存，只能使用受预算限制的宿主内存。')
    offset = end
  }
}

/**
 * Refuses unpermitted imports, defined tables/memories and an unexpected ABI.
 * The host memory is the only one the module can ever reach.
 */
export function instantiateAlgorithm(bytes: ArrayBuffer | Uint8Array, options: { memoryPages: number; entry: string }): AlgorithmInstance {
  if (!Number.isInteger(options.memoryPages) || options.memoryPages < 1 || options.memoryPages > 256)
    throw new AlgorithmError('invalid-input', '算法内存预算必须为 1 至 256 页。')
  // Compile and inspect the same private copy, even if the caller supplied a shared/mutable view.
  const binary = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  let module: WebAssembly.Module
  try { module = new WebAssembly.Module(binary) }
  catch { throw new AlgorithmError('algorithm-error', '算法资源不是有效的 WebAssembly 模块。') }
  const imports = WebAssembly.Module.imports(module)
  const permitted = imports.length === 1 && imports[0]!.module === 'env' && imports[0]!.name === 'memory' && imports[0]!.kind === 'memory'
  if (!permitted) throw new AlgorithmError('algorithm-error', '算法声明了未经许可的导入，已拒绝实例化。')
  assertNoDefinedStorage(binary)
  const exports = WebAssembly.Module.exports(module)
  if (!exports.some(item => item.name === options.entry && item.kind === 'function')
    || !exports.some(item => item.name === 'abiVersion' && item.kind === 'global'))
    throw new AlgorithmError('algorithm-error', '算法没有声明预期的入口或版本。')
  // The maximum is fixed here, so no code path can grow the algorithm past its budget.
  const memory = new WebAssembly.Memory({ initial: options.memoryPages, maximum: options.memoryPages })
  let instance: WebAssembly.Instance
  try { instance = new WebAssembly.Instance(module, { env: { memory } }) }
  catch { throw new AlgorithmError('algorithm-error', '算法与宿主内存不兼容，已拒绝运行。') }
  const abi = instance.exports.abiVersion as WebAssembly.Global | undefined
  if (!(abi?.value === 1)) throw new AlgorithmError('algorithm-error', '算法版本与宿主不兼容。')
  const aggregate = instance.exports[options.entry]
  if (typeof aggregate !== 'function') throw new AlgorithmError('algorithm-error', '算法入口不可调用。')
  return { aggregate: aggregate as unknown as AlgorithmInstance['aggregate'], memory }
}

export function typedInputBytes(table: AggregationTable, parameters: AggregationParameters): number {
  return new TextEncoder().encode(JSON.stringify({ table, parameters })).length
}

/**
 * Groups by the selected key column and lets the algorithm compute each group's numbers.
 * An unparsable value is reported with its row number: a silent zero would be a made-up result.
 */
export function runAggregation(options: { bytes: ArrayBuffer | Uint8Array; memoryPages: number; entry: string
  table: AggregationTable; parameters: AggregationParameters; inputBytes: number; outputBytes: number; timeMs: number
  now?: () => number }): AggregationOutcome {
  const { table, parameters } = options
  const now = options.now ?? (() => performance.now())
  const started = now()
  if (typedInputBytes(table, parameters) > options.inputBytes)
    throw new AlgorithmError('input-too-large', '固定输入超过了声明的输入上限。')
  if (table.columns.length === 0 || table.columns.length > MAX_COLUMNS || table.rows.length > MAX_ROWS)
    throw new AlgorithmError('invalid-input', '表格结构超出声明的范围。')
  const groupIndex = table.columns.indexOf(parameters.groupColumn)
  const valueIndex = table.columns.indexOf(parameters.valueColumn)
  if (groupIndex < 0 || valueIndex < 0) throw new AlgorithmError('invalid-input', '所选列不在当前表格中。')
  if (table.rows.some(row => row.length !== table.columns.length))
    throw new AlgorithmError('invalid-input', '有行的列数与表头不一致。')

  const rejected: number[] = []
  const buckets = new Map<string, number[]>()
  for (const [index, row] of table.rows.entries()) {
    if (parameters.aggregate === 'count' && !row[valueIndex]!.trim()) { rejected.push(index + 1); continue }
    const raw = row[valueIndex]!.trim()
    const value = Number(raw)
    if (!raw || !Number.isFinite(value)) { rejected.push(index + 1); continue }
    const key = row[groupIndex] ?? ''
    const bucket = buckets.get(key)
    if (bucket) bucket.push(value)
    else buckets.set(key, [value])
  }
  if (rejected.length) throw new AlgorithmError('invalid-input',
    `第 ${rejected.slice(0, 8).join('、')} 行的数值列不是有限数字，已在计算前停止。`)
  if (buckets.size > MAX_GROUPS) throw new AlgorithmError('invalid-input', '分组数量超过声明的上限。')
  if (buckets.size === 0) throw new AlgorithmError('invalid-input', '当前表格没有可计算的行。')

  const algorithm = instantiateAlgorithm(options.bytes, { memoryPages: options.memoryPages, entry: options.entry })
  const scratch = new Float64Array(algorithm.memory.buffer, 0, algorithm.memory.buffer.byteLength / 8)
  const measure = (values: number[]) => {
    if (values.length > scratch.length) throw new AlgorithmError('input-too-large', '单组数值超过了算法内存。')
    scratch.set(values)
    const read = (mode: number) => {
      const value = algorithm.aggregate(0, values.length, mode)
      if (!Number.isFinite(value)) throw new AlgorithmError('algorithm-error', '算法返回了非有限结果，已停止。')
      return value
    }
    const count = read(MODE_COUNT), sum = read(MODE_SUM)
    return { count, sum, mean: read(MODE_MEAN), min: read(MODE_MIN), max: read(MODE_MAX) }
  }
  const measured = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh'))
    .map(([key, values]) => ({ key, ...measure(values) }))
  const total = measure([...buckets.values()].flat())
  const mode = aggregateModes[parameters.aggregate]
  const pick = (group: Omit<AggregationGroup, 'value'>) => parameters.aggregate === 'count' ? group.count
    : parameters.aggregate === 'sum' ? group.sum : group.mean
  const groups: AggregationGroup[] = measured.map(group => ({ ...group, value: pick(group) }))
  const value = mode === MODE_COUNT ? total.count : mode === MODE_SUM ? total.sum : total.mean
  if (now() - started > options.timeMs) throw new AlgorithmError('budget-exceeded', '计算超过了声明的运行时限。')

  const result: AggregationResult = { rows: table.rows.length, aggregate: parameters.aggregate,
    groupColumn: parameters.groupColumn, valueColumn: parameters.valueColumn, groups, value, rejected: [] }
  const header = `${parameters.groupColumn},计数,求和,平均,最小,最大`
  const lines = groups.map(group => [group.key, group.count, group.sum, group.mean, group.min, group.max]
    .map(cell => typeof cell === 'number' ? String(Number(cell.toFixed(6))) : quoteCsv(cell)).join(','))
  const text = [header, ...lines].join('\n') + '\n'
  if (new TextEncoder().encode(text).length > options.outputBytes)
    throw new AlgorithmError('output-too-large', '结果文件超过声明的输出上限。')
  return { result, artifact: { name: `聚合结果-${parameters.aggregate}.csv`, mediaType: 'text/csv;charset=utf-8', text } }
}

const quoteCsv = (value: string) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

/** Independent expectation used by tests and by the self-check; it never runs inside the algorithm. */
export function expectedAggregation(table: AggregationTable, parameters: AggregationParameters): { groups: Record<string, number>; value: number } {
  const groupIndex = table.columns.indexOf(parameters.groupColumn), valueIndex = table.columns.indexOf(parameters.valueColumn)
  const buckets = new Map<string, number[]>()
  for (const row of table.rows) {
    const key = row[groupIndex] ?? ''
    const bucket = buckets.get(key)
    const value = Number(row[valueIndex])
    if (bucket) bucket.push(value); else buckets.set(key, [value])
  }
  const groups = Object.fromEntries([...buckets.entries()].map(([key, values]) => [key,
    parameters.aggregate === 'count' ? values.length : parameters.aggregate === 'sum' ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length]))
  const all = [...buckets.values()].flat()
  return { groups, value: parameters.aggregate === 'count' ? all.length
    : parameters.aggregate === 'sum' ? all.reduce((a, b) => a + b, 0) : all.reduce((a, b) => a + b, 0) / all.length }
}
