import { AdapterRegistry } from '../adapter'
import { createAggregationAdapter, type AlgorithmProvider, type RunAlgorithm } from './aggregation'
import { createAluAdapter, type RuntimeResourceLoader } from './alu'

export { createAggregationAdapter, type AlgorithmProvider, type RunAlgorithm } from './aggregation'

/**
 * The complete executor set this build ships. Registering an adapter is a deliberate act: a fixed
 * action this table has no entry for is refused, never quietly run by something else.
 *
 * Only implementations that can really run are listed. The Icarus ALU adapter joins this table once
 * its fixed runtime resources can be prepared and verified, so no activity can be promised a run
 * this build cannot finish.
 */
export function createAdapterRegistry(options: {
  provider: AlgorithmProvider
  run?: RunAlgorithm
  runtimeResources?: RuntimeResourceLoader
}): AdapterRegistry {
  return new AdapterRegistry([createAggregationAdapter({ provider: options.provider,
    ...(options.run ? { run: options.run } : {}) }), ...(options.runtimeResources ? [createAluAdapter(options.runtimeResources)] : [])])
}
