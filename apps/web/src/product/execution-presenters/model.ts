import type { ReactNode } from 'react'
import type { ComponentBinding } from '@xunjie/contracts/components'
import type { AnyExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { ExecutionRecord } from '../../tool-execution/ledger'

/**
 * How one run family explains itself. The public panel keeps the record list, the run/stop/query
 * controls and the artifact download; everything that knows what a group, a port or a CSV row means
 * lives in a presenter beside its adapter. A record with no presenter still shows its real state,
 * so an unregistered family degrades to "the run happened", never to a wrong label.
 */
export interface RecordPresenter {
  readonly id: string
  /** Which records this presenter explains; at most one presenter may answer for a record. */
  matches(action: AnyExecutionAction): boolean
  /** Label of this family's primary artifact on the download control. */
  readonly artifactLabel: string
  /**
   * Everything this record says about itself beyond its state: the fixed parameters, whether the
   * workspace moved on, the result summary and any reference anchors.
   */
  Detail(input: { activity: LearningActivity; binding: ComponentBinding; record: ExecutionRecord
    /** The component state file as it is now; `undefined` means it is gone. */
    currentValue: string | undefined; authorized: boolean }): ReactNode
}

export class PresenterRegistry {
  constructor(private readonly presenters: RecordPresenter[]) {}
  find(action: AnyExecutionAction): RecordPresenter | undefined {
    return this.presenters.filter(presenter => presenter.matches(action)).at(0)
  }
}
