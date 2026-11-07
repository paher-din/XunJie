import { aggregationPresenter } from './aggregation'
import { PresenterRegistry } from './model'
import { aluPresenter } from './alu'

export { PresenterRegistry, type RecordPresenter } from './model'

/**
 * The presenters this build ships, one per registered run family. A family without a presenter still
 * has its record listed and its state shown; only its own explanation is missing, which is honest.
 */
export const recordPresenters = new PresenterRegistry([aggregationPresenter,aluPresenter])
