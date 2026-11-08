/** Public identity of the visible run selected by the learner.
 * Ownership checks, object-reference construction and requests stay with the application.
 */
export interface RunHelpTarget {
  runId: string
  snapshotId: string
}
