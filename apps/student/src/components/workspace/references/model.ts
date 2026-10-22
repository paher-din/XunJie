/** Ephemeral frontend references. No persistence or model-service contract is implied. */
export interface ReferenceSnapshot {
  readonly workspaceKey: string
  /** Stable instance identity, never a display path. */
  readonly sourceId: string
  readonly sourceName: string
  readonly kind: 'text' | 'code'
  readonly text: string
  /** Local-only original, used to reject stale locations. Never sent to onSubmit. */
  readonly sourceText: string
  /** Half-open UTF-16 offsets in the original, including its actual newline separators. */
  readonly range: Readonly<{ start: number; end: number }>
}
export interface WorkspaceReference extends ReferenceSnapshot { readonly id: string }
export type SubmittedReference = Omit<WorkspaceReference, 'sourceText'>
export interface ReferenceSubmission {
  readonly workspaceKey: string
  readonly question: string
  readonly references: readonly SubmittedReference[]
}
export interface SelectionRect { left: number; right: number; top: number; bottom: number }
export interface ReferenceSelection {
  readonly snapshot: ReferenceSnapshot
  /** Re-read geometry on scroll/resize; null means no visible anchor. */
  readonly anchor: () => SelectionRect | null
}
export type LocateResult = { ok: true } | { ok: false; reason: string }
export interface ReferenceSource {
  readonly sourceId: string
  locate(reference: ReferenceSnapshot): LocateResult
}
export function referenceKey(ref: ReferenceSnapshot): string {
  return JSON.stringify([ref.workspaceKey, ref.sourceId, ref.kind, ref.range.start, ref.range.end, ref.text])
}
function splitsPair(text: string, offset: number): boolean {
  const a = text.charCodeAt(offset - 1), b = text.charCodeAt(offset)
  return (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) || (a === 13 && b === 10)
}
export function snapshotReference(input: Omit<ReferenceSnapshot, 'text'>): ReferenceSnapshot | null {
  const { start, end } = input.range
  if (!input.workspaceKey || !input.sourceId || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end <= start || end > input.sourceText.length || splitsPair(input.sourceText, start) ||
    splitsPair(input.sourceText, end)) return null
  const text = input.sourceText.slice(start, end)
  if (!text.trim()) return null
  return Object.freeze({ ...input, text, range: Object.freeze({ start, end }) })
}
export function submissionReference(ref: WorkspaceReference): SubmittedReference {
  return Object.freeze({ id: ref.id, workspaceKey: ref.workspaceKey, sourceId: ref.sourceId, sourceName: ref.sourceName,
    kind: ref.kind, text: ref.text, range: Object.freeze({ start: ref.range.start, end: ref.range.end }) })
}
