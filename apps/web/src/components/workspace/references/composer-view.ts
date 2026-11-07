/** UI only. Question text, references and Skill pins remain in ReliableQuestionDraft. */
export interface ComposerView { open: boolean; start?: number; end?: number
  direction?: 'forward' | 'backward' | 'none'; focused?: boolean }
const views = new Map<string, ComposerView>()
const compositions = new Map<string, { promise: Promise<void>; finish(): void }>()

export function composerView(key: string): ComposerView { return views.get(key) ?? { open: false } }
export function rememberComposerView(key: string, patch: Partial<ComposerView>) {
  views.set(key, { ...composerView(key), ...patch })
}
export function rememberComposerCaret(key: string, input: HTMLTextAreaElement, focused?: boolean) {
  rememberComposerView(key, { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
    ...(focused === undefined ? {} : { focused }) })
}
export function beginComposerComposition(key: string) {
  if (compositions.has(key)) return
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  compositions.set(key, { promise, finish })
}
export function endComposerComposition(key: string) {
  const pending = compositions.get(key)
  compositions.delete(key)
  pending?.finish()
}
export async function waitForComposerComposition(key: string) {
  while (compositions.has(key)) await compositions.get(key)!.promise
}
