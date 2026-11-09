import { acceptsState, type StateShape } from '@xunjie/contracts/components'
import type { ExecutionAction } from '@xunjie/contracts/execution'
import type { AnyExecutionAction } from '@xunjie/contracts/execution'
import { ExecutionError } from '../errors'
import { AlgorithmError, jobFromAction, type AggregationOutcome } from '../algorithm'
import { runInWorker } from '../runner'
import type { AdapterResult, ExecutionAdapter } from '../adapter'

/** Where the aggregation ABI's own bytes and declared result shape come from. */
export interface AlgorithmProvider {
  /** `result` is the snapshot's declared result shape; a run must produce exactly that. */
  load(action: ExecutionAction): Promise<{ bytes: ArrayBuffer; entry: string; memoryPages: number; result: StateShape }>
}

export interface RunAlgorithm { (job: Parameters<typeof runInWorker>[0], signal: AbortSignal): Promise<AggregationOutcome> }

const isAggregation = (action: AnyExecutionAction): action is ExecutionAction => action.protocolVersion === 2

/**
 * The fixed table-aggregation executor. Everything aggregation-specific lives here: the input table
 * it reads from the command's own basis copy, the parameters, the CSV it produces and the declared
 * result shape. The public controller never learns what a group, a column or a CSV row is.
 */
export function createAggregationAdapter(options: {
  provider: AlgorithmProvider
  run?: RunAlgorithm
}): ExecutionAdapter {
  const run = options.run ?? runInWorker
  return {
    adapterId: 'table-aggregation',
    adapterVersion: 1,
    protocolVersion: 2,
    handles: (action): action is ExecutionAction => isAggregation(action)
      && action.execution.operation.operationId === 'aggregate',
    validateAndFreeze(action) {
      if (!isAggregation(action)) throw new ExecutionError('capability-unavailable', '聚合 Adapter 只接受 2 版聚合动作。')
      // Only what makes the basis itself incoherent is refused here. Whether a particular input can
      // produce a table is decided when the run reads it, so acceptance stays what it always was.
      const kinds = action.execution.basis.resources.map(item => item.kind).sort()
      if (kinds.join(',') !== 'algorithm,entry')
        throw new ExecutionError('invalid-input', '固定输入没有引用本组件声明的入口与算法资源。')
    },
    async run(action, context): Promise<AdapterResult> {
      if (!isAggregation(action)) throw new ExecutionError('capability-unavailable', '聚合 Adapter 只接受 2 版聚合动作。')
      const limits = action.execution.limits
      // The ABI, not the generic executor, decides how a fixed command becomes a worker job.
      const job = jobFromAction(action, limits)
      const algorithm = await options.provider.load(action)
      await context.checkpoint()
      context.signal.throwIfAborted()
      const outcome = await run({ ...job, bytes: algorithm.bytes, memoryPages: Math.min(algorithm.memoryPages, limits.memoryPages),
        entry: algorithm.entry }, context.signal)
      await context.checkpoint()
      // The manifest declared the result structure; a run whose numbers do not fit it is not published.
      if (!acceptsState(algorithm.result, outcome.result))
        throw new AlgorithmError('algorithm-error', '算法结果与清单声明的结果结构不一致，已停止。')
      return { output: outcome.result, resources: [outcome.artifact], diagnostics: [] }
    },
  }
}
