import { questionReferenceInputSchema, questionReferenceKey } from '@xunjie/contracts/question-drafts'
import type { QuestionReferenceSource, QuestionWorkBasis, QuestionReferenceRange } from '@xunjie/contracts/question-drafts'

/** Ephemeral frontend references; production persistence uses the reliable draft authority. */
export interface ReferenceSnapshot {
  readonly workspaceKey: string
  /** Stable instance identity, never a display path. */
  readonly sourceId: string
  readonly sourceName: string
  readonly kind: QuestionReferenceRange['kind']
  readonly text: string
  /** Local-only original, used to reject stale locations. Never sent as a reference field. */
  readonly sourceText?: string
  /** Typed source object and immutable content identity; required for production drafts. */
  readonly source?: QuestionReferenceSource
  /** Full selected work snapshot registered as a fixed basis, never stored as reference copy. */
  readonly basis?: QuestionWorkBasis
  /** Half-open UTF-16 offsets in the original, including its actual newline separators. */
  readonly range: Readonly<{ start: number; end: number; formatVersion?: 1; typeId?: string; version?: number; target?: Record<string, unknown> }>
}
export interface WorkspaceReference extends ReferenceSnapshot { readonly id: string }
export type SubmittedReference = Omit<WorkspaceReference, 'sourceText' | 'basis'>
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
  locate(reference: ReferenceSnapshot): LocateResult | Promise<LocateResult>
}
export function referenceKey(ref: ReferenceSnapshot): string {
  if (ref.source && ref.kind === 'semantic') return JSON.stringify([ref.workspaceKey, questionReferenceKey({ source: ref.source, range: { ...ref.range, kind: 'semantic' } as QuestionReferenceRange })])
  return JSON.stringify([ref.workspaceKey, ref.sourceId, ref.kind, ref.range.start, ref.range.end, ref.text])
}
function splitsPair(text: string, offset: number): boolean {
  const a = text.charCodeAt(offset - 1), b = text.charCodeAt(offset)
  return (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) || (a === 13 && b === 10)
}
export function snapshotReference(input: Omit<ReferenceSnapshot, 'text'>): ReferenceSnapshot | null {
  if (input.kind === 'semantic') {
    const candidate = questionReferenceInputSchema.safeParse({ referenceId: crypto.randomUUID(), source: input.source,
      range: { ...input.range, kind: 'semantic' }, copy: input.sourceText, sourceName: input.sourceName });
    return candidate.success ? Object.freeze({ ...input, text: candidate.data.copy, range: Object.freeze({ ...input.range }) }) : null
  }
  const { start, end } = input.range
  if (!input.workspaceKey || !input.sourceId || !input.sourceText ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end <= start || end > input.sourceText.length || splitsPair(input.sourceText, start) ||
    splitsPair(input.sourceText, end)) return null
  const text = input.sourceText.slice(start, end)
  if (!text.trim()) return null
  return Object.freeze({ ...input, text, range: Object.freeze({ start, end }) })
}
export function submissionReference(ref: WorkspaceReference): SubmittedReference {
  const { sourceText: _sourceText, basis: _basis, ...rest } = ref
  return Object.freeze({ ...rest, range: Object.freeze({ ...ref.range }) })
}
