import { AlgorithmError, runAggregation } from './algorithm'
import type { AlgorithmJob, AggregationOutcome } from './algorithm'

export type { AlgorithmJob }
export type AlgorithmReply = { ok: true; outcome: AggregationOutcome }
  | { ok: false; code: AlgorithmError['code']; detail: string }

/** Trusted wrapper: the algorithm only ever receives bounded bytes and fixed parameters. */
const scope = self as unknown as { onmessage: ((event: MessageEvent<AlgorithmJob>) => void) | null
  postMessage(message: AlgorithmReply): void }

scope.onmessage = (event: MessageEvent<AlgorithmJob>) => {
  const job = event.data
  try {
    scope.postMessage({ ok: true, outcome: runAggregation(job) })
  } catch (error) {
    scope.postMessage({ ok: false, code: error instanceof AlgorithmError ? error.code : 'algorithm-error',
      detail: error instanceof Error ? error.message : '算法没有完成。' })
  }
}
