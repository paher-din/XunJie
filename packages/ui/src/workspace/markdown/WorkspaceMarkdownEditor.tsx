import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, StateEffect, StateField, Text, type Range, type SelectionRange } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType, type KeyBinding } from '@codemirror/view'
import type { Token, Tokens } from 'marked'
import { courseMarkdownSourceSyntax, lexCourseMarkdown, linkLabelEnd, renderCourseMarkdownInlineToken,
  renderCourseMarkdownToken, sanitizeCourseMarkdown } from './markup'
import { commitActiveNoteCell, emptyNoteTableRow, focusNoteTableCell, noteTableHeaderColumns, PersonalNoteTable } from './MarkdownTable'
import { markdownEntity, renderedMarkdownCaret } from './selection'
import './markdown-editor.css'

type Span = { from: number; to: number }
type InlinePreview = (Span & { mark: Decoration; opening: number; closing: number; link?: Span; format?: 'strong' | 'em' })
  | (Span & { replacement: Decoration; markers: Span[] })
type BlockPreview = Span & { kind: string; replacement?: Decoration; inline: InlinePreview[];
  heading?: Decoration; markers?: Span[] }

const renderedBlocks = new Set(['heading', 'blockquote', 'list', 'code', 'hr', 'courseDisplayMath'])
const hiddenSyntax = Decoration.replace({})
const visibleSyntax = Decoration.mark({ class: 'personal-note-syntax' })
const openBlock = StateEffect.define<number | null>()
const editorFocus = StateEffect.define<boolean>()

class MarkdownWidget extends WidgetType {
  private html?: string

  constructor(private readonly token: Token, private readonly block: boolean) { super() }

  private markup() {
    return this.html ??= this.block ? renderCourseMarkdownToken(this.token) : renderCourseMarkdownInlineToken(this.token)
  }

  eq(other: MarkdownWidget) {
    return this.block === other.block && this.token.raw === other.token.raw && this.markup() === other.markup()
  }

  toDOM(view: EditorView) {
    const element: HTMLElement = view.dom.ownerDocument.createElement(this.block ? 'div' : 'span')
    const isMath = this.token.type === 'courseDisplayMath' || this.token.type === 'courseInlineMath'
    element.className = this.block ? 'personal-note-block course-reader-markdown'
      : isMath ? 'personal-note-math' : 'personal-note-literal'
    element.innerHTML = sanitizeCourseMarkdown(this.markup())
    for (const control of element.querySelectorAll<HTMLElement>('a, input, [tabindex]')) control.tabIndex = -1
    const raw = this.token.raw.replace(/\n+$/, '')
    const fallback = isMath ? raw.match(/^\s*\${1,2}\s*/)?.[0].length ?? 1 : 1
    const syntax = courseMarkdownSourceSyntax(this.token)
    element.addEventListener('mousedown', event => {
      if (event.button !== 0) return
      event.preventDefault()
      const from = view.posAtDOM(element)
      const hit = renderedMarkdownCaret(element, raw, syntax, event,
        isMath ? 'math' : this.token.type) ?? fallback
      const offset = this.block ? hit : Math.max(1, Math.min(hit, raw.length - 1))
      const head = from + offset
      view.dispatch({
        selection: { anchor: event.shiftKey ? view.state.selection.main.anchor : head, head },
        effects: openBlock.of(this.block && (offset === 0 || offset === raw.length) ? from : null),
        scrollIntoView: true,
      })
      view.focus()
    })
    element.addEventListener('click', event => event.preventDefault())
    return element
  }
}

function inlineWidget(token: Token, from: number, markers: Span[]): InlinePreview {
  return { from, to: from + token.raw.length, markers, replacement: Decoration.replace({ widget: new MarkdownWidget(token, false) }) }
}

function collectInline(text: string, tokens: readonly Token[], from: number, end: number, output: InlinePreview[]) {
  let cursor = from
  for (const token of tokens) {
    const start = text.indexOf(token.raw, cursor)
    if (start < 0 || start + token.raw.length > end) continue
    const to = start + token.raw.length
    cursor = to
    if (token.type === 'courseInlineMath') {
      output.push(inlineWidget(token, start, [{ from: start, to: start + 1 }, { from: to - 1, to }]))
      continue
    }
    if (token.type === 'escape') {
      output.push(inlineWidget(token, start, [{ from: start, to: start + 1 }]))
      continue
    }
    if (token.type === 'image') {
      const labelEnd = linkLabelEnd(token.raw.slice(1)) + 1
      const markers = labelEnd > 1 ? [{ from: start, to: start + 2 }, { from: start + labelEnd, to }] : []
      output.push(inlineWidget(token, start, markers))
      continue
    }
    if (token.type === 'text' && !('tokens' in token && Array.isArray(token.tokens))) {
      for (const match of token.raw.matchAll(markdownEntity)) {
        const entity = match[0]
        const from = start + match.index
        output.push(inlineWidget({ type: 'text', raw: entity, text: entity }, from, [{ from, to: from + entity.length }]))
      }
    }

    const before = token.type === 'link' && token.raw.startsWith('[') ? 1 : 0
    const labelEnd = before ? linkLabelEnd(token.raw) : -1
    let opening = 0, closing = 0
    if (labelEnd > 1) {
      opening = 1
      closing = token.raw.length - labelEnd
      const link = token.raw[labelEnd + 1] === '(' && token.raw.endsWith(')')
        ? { from: start + labelEnd + 2, to: to - 1 } : undefined
      output.push({ from: start, to, opening, closing, link, mark: Decoration.mark({ class: 'personal-note-link' }) })
    } else if (['strong', 'em', 'del', 'codespan'].includes(token.type)) {
      opening = closing = token.raw.match(/^(?:\*+|_+|~+|`+)/)?.[0].length ?? 0
      // Emphasis may begin with three repeated delimiters, where the innermost ones belong to a child.
      if (token.type === 'strong') opening = closing = 2
      if (token.type === 'em') opening = closing = 1
      if (opening && start + opening < to - closing) {
        const tagName = token.type === 'codespan' ? 'code' : token.type === 'del' ? 's' : token.type
        const format = token.type === 'strong' || token.type === 'em' ? token.type : undefined
        output.push({ from: start, to, opening, closing, format, mark: Decoration.mark({ tagName }) })
      }
    }

    if (token.type === 'list') collectInline(text, token.items, start, to, output)
    else if ('tokens' in token && Array.isArray(token.tokens)) {
      collectInline(text, token.tokens, start + opening, to - closing, output)
    }
  }
}

function blockMarkers(token: Token, text: string, from: number, to: number): Span[] {
  const source = text.slice(from, to)
  if (token.type === 'list') {
    let cursor = from
    return (token as Tokens.List).items.flatMap(item => {
      const raw = item.raw.trimEnd()
      const at = text.indexOf(raw, cursor)
      if (at < 0 || at >= to) return []
      cursor = at + raw.length
      const marker = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)(?:[ \t]+\[[ xX]\](?=[ \t]|$))?/.exec(raw)
      return marker ? [{ from: at, to: at + marker[0].length }] : []
    })
  }
  if (token.type === 'blockquote') {
    return Array.from(source.matchAll(/^ {0,3}(?:>[ \t]*)+/gm), match =>
      ({ from: from + match.index, to: from + match.index + match[0].trimEnd().length }))
  }
  if (token.type === 'courseDisplayMath') {
    const opening = source.indexOf('$$'), closing = source.lastIndexOf('$$')
    return closing > opening ? [opening, closing].map(at => ({ from: from + at, to: from + at + 2 })) : []
  }
  if (token.type === 'hr') return [{ from, to }]

  const last = source.lastIndexOf('\n') + 1
  if (token.type === 'heading' && last > 0) return [{ from: from + last, to }]
  if (token.type !== 'code') return []
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(source)
  if (!opening) return []
  const markers = [{ from, to: from + opening[0].length }]
  const closing = last > 0 ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(source.slice(last)) : null
  if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length) {
    markers.push({ from: from + last, to })
  }
  return markers
}

function noteMarkup(text: string): BlockPreview[] {
  try {
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0
    let cursor = start
    return lexCourseMarkdown(text.slice(start)).flatMap<BlockPreview>(token => {
      // An empty last list item may give Marked a synthetic newline and omit spaces that are still editable.
      const kind = token.type
      const source = kind === 'list' ? token.raw.trimEnd() : token.raw
      const from = text.indexOf(source, cursor)
      if (from < 0) return []
      cursor = from + source.length
      const end = from + source.replace(/\n+$/, '').length
      const to = kind === 'list' ? end + (text.slice(end).match(/^[ \t]+/)?.[0].length ?? 0) : end
      const inline: InlinePreview[] = []
      if (kind === 'list') collectInline(text, (token as Tokens.List).items, from, to, inline)
      else collectInline(text, [token], from, cursor, inline)
      const blockStart = from === 0 || text[from - 1] === '\n'
      const prefix = blockStart && kind === 'heading' ? /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(token.raw) : null
      if (prefix) {
        const level = Math.min((token as Tokens.Heading).depth + 2, 6)
        const line = Decoration.line({ attributes: { class: `personal-note-heading personal-note-heading-${level}`,
          role: 'heading', 'aria-level': String(level) } })
        const markers: Span[] = []
        const start = from + prefix[0].length
        if (start < to) {
          markers.push({ from, to: start })
          const closing = /[ \t]+#+[ \t]*$/.exec(text.slice(start, to))
          if (closing) markers.push({ from: start + closing.index, to })
        }
        return [{ from, to, kind, inline, heading: line, markers }]
      }
      const widget = to - from > 1 && blockStart && (kind === 'table' ? new PersonalNoteTable(token as Tokens.Table)
        : renderedBlocks.has(token.type) ? new MarkdownWidget(token, true) : null)
      const allowEnd = kind === 'table' || kind === 'courseDisplayMath' || kind === 'hr'
      const replacement = widget ? Decoration.replace({ widget, block: true, inclusiveEnd: !allowEnd }) : undefined
      const markers = kind === 'table' || !widget ? [] : blockMarkers(token, text, from, to)
      return replacement || inline.length ? [{ from, to, kind, replacement, inline, markers }] : []
    })
  } catch {
    return []
  }
}

function liveDecorations(blocks: readonly BlockPreview[], selections: readonly SelectionRange[], opened: number | null = null) {
  const ranges: Range<Decoration>[] = []
  const touches = (from: number, to: number) => selections.some(range => range.from < to && range.to > from)
  const editsInside = (from: number, to: number) => selections.some(({ head, anchor }) =>
    (head > from && head < to) || (anchor > from && anchor < to))
  for (const block of blocks) {
    // At the end of a list, quote, or fence, typing still belongs to its final line.
    const editingEnd = block.kind !== 'courseDisplayMath' && block.kind !== 'hr'
      && selections.some(range => range.empty && range.head === block.to)
    if (block.replacement && (block.kind === 'table' || (!editingEnd && opened !== block.from && !touches(block.from, block.to)))) {
      ranges.push(block.replacement.range(block.from, block.to))
      continue
    }
    if (block.heading) {
      ranges.push(block.heading.range(block.from))
      const syntax = editsInside(block.from, block.to) || editingEnd ? visibleSyntax : hiddenSyntax
      for (const marker of block.markers ?? []) ranges.push(syntax.range(marker.from, marker.to))
    } else {
      for (const marker of block.markers ?? []) ranges.push(visibleSyntax.range(marker.from, marker.to))
    }
    for (const span of block.inline) {
      const active = editsInside(span.from, span.to)
      if ('replacement' in span) {
        if (!active) ranges.push(span.replacement.range(span.from, span.to))
        else for (const marker of span.markers) ranges.push(visibleSyntax.range(marker.from, marker.to))
      } else {
        const start = span.from + span.opening, end = span.to - span.closing
        const syntax = active ? visibleSyntax : hiddenSyntax
        ranges.push(span.mark.range(start, end))
        ranges.push(syntax.range(span.from, start), syntax.range(end, span.to))
      }
    }
  }
  return Decoration.set(ranges, true)
}

const livePreview = StateField.define({
  create(state) {
    const blocks = noteMarkup(state.doc.toString())
    return { blocks, opened: null as number | null, focused: false, decorations: liveDecorations(blocks, []) }
  },
  update(value, transaction) {
    const click = transaction.effects.find(effect => effect.is(openBlock))
    const focus = transaction.effects.find(effect => effect.is(editorFocus))
    if (!transaction.docChanged && !transaction.selection && !click && !focus) return value
    const blocks = transaction.docChanged ? noteMarkup(transaction.state.doc.toString()) : value.blocks
    const ranges = transaction.state.selection.ranges
    const previous = value.opened === null ? null : transaction.changes.mapPos(value.opened, -1)
    const opened = click ? click.value : blocks.some(block => block.replacement && block.from === previous
      && ranges.some(range => range.from <= block.to && range.to >= block.from)) ? previous : null
    const focused = focus?.value ?? value.focused
    return { blocks, opened, focused, decorations: liveDecorations(blocks, focused ? ranges : [], focused ? opened : null) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

function insertMarkdownLine(view: EditorView) {
  const { state } = view
  const { main, ranges } = state.selection
  if (state.readOnly || view.compositionStarted || ranges.length !== 1 || !main.empty) return false
  const line = state.doc.lineAt(main.head)
  const block = state.field(livePreview).blocks.find(block => block.from <= line.from && block.to >= line.from)
  if (block?.kind === 'code' || block?.kind === 'courseDisplayMath' || block?.kind === 'table') return false

  const columns = main.head === line.to && (line.number === 1 || !state.doc.line(line.number - 1).text.trim())
    ? noteTableHeaderColumns(line.text) : 0
  if (columns) {
    view.dispatch({ changes: { from: line.to, insert: Text.of(['', '|' + ' --- |'.repeat(columns), emptyNoteTableRow(columns), '', '']) },
      selection: { anchor: line.from }, userEvent: 'input', scrollIntoView: true })
    focusNoteTableCell(view, line.from, columns)
    return true
  }

  const list = block?.kind === 'list' ? /^([ \t]*)([-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/.exec(line.text) : null
  const quote = block?.kind === 'blockquote' ? /^ {0,3}(?:>[ \t]?)+/.exec(line.text) : null
  const prefix = list?.[0] ?? quote?.[0]
  if (!prefix || main.head < line.from + prefix.length) return false
  if (!line.text.slice(prefix.length).trim()) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: Text.of(['', '']) },
      selection: { anchor: line.from + 1 }, userEvent: 'input', scrollIntoView: true })
    return true
  }
  const marker = list && /^\d/.test(list[2]) ? String(Number.parseInt(list[2], 10) + 1) + list[2].slice(-1) : list?.[2]
  const continuation = list ? `${list[1]}${marker} ${/\[[ xX]\]/.test(prefix) ? '[ ] ' : ''}` : prefix
  view.dispatch({ changes: { from: main.head, insert: Text.of(['', continuation]) },
    selection: { anchor: main.head + 1 + continuation.length }, userEvent: 'input', scrollIntoView: true })
  return true
}

function toggleInlineFormat(format: 'strong' | 'em', marker: string) {
  return (view: EditorView) => {
    const { state } = view
    const { main, ranges } = state.selection
    if (state.readOnly || view.compositionStarted || ranges.length !== 1 || state.doc.lineAt(main.from).to < main.to) return false
    const { from, to, anchor, head } = main
    const block = state.field(livePreview).blocks.find(block => block.from <= from && to <= block.to)
    const span = main.empty ? undefined : block?.inline.find(span =>
      'format' in span && span.format === format && span.from <= from && to <= span.to)
    if (span && 'mark' in span) {
      const changes = state.changes([
        { from: span.from, to: span.from + span.opening },
        { from: span.to - span.closing, to: span.to },
      ])
      view.dispatch({ changes, selection: { anchor: changes.mapPos(anchor), head: changes.mapPos(head) },
        userEvent: 'input', scrollIntoView: true })
      return true
    }
    const selected = state.doc.sliceString(from, to)
    view.dispatch({ changes: { from, to, insert: marker + selected + marker },
      selection: { anchor: anchor + marker.length, head: head + marker.length }, userEvent: 'input', scrollIntoView: true })
    return true
  }
}

function editInlineLink(view: EditorView) {
  const { state } = view
  const { main, ranges } = state.selection
  if (state.readOnly || view.compositionStarted || ranges.length !== 1 || state.doc.lineAt(main.from).to < main.to) return false
  const block = state.field(livePreview).blocks.find(block => block.from <= main.from && block.to >= main.to)
  const inline = block?.inline.find(span => 'link' in span && span.link && span.from <= main.from && span.to >= main.to)
  if (inline && 'link' in inline && inline.link) {
    view.dispatch({ selection: { anchor: inline.link.from, head: inline.link.to }, scrollIntoView: true })
    return true
  }
  const label = state.doc.sliceString(main.from, main.to).replace(/[\\[\]]/g, '\\$&')
  const caret = label ? main.from + label.length + 3 : main.from + 1
  view.dispatch({ changes: { from: main.from, to: main.to, insert: `[${label}]()` }, selection: { anchor: caret },
    userEvent: 'input', scrollIntoView: true })
  return true
}

const markdownKeys: KeyBinding[] = [
  { key: 'Enter', run: insertMarkdownLine },
  { key: 'Mod-b', run: toggleInlineFormat('strong', '**'), preventDefault: true },
  { key: 'Mod-i', run: toggleInlineFormat('em', '*'), preventDefault: true },
  { key: 'Mod-k', run: editInlineLink, preventDefault: true },
]

const editingAccess = new Compartment()
const access = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]

export type WorkspaceMarkdownEditorHandle = { readDraft: () => string | undefined }

export function WorkspaceMarkdownEditor({ initialText, ariaLabel, readOnly, onChange, autoFocus = false, ref }: {
  initialText: string; ariaLabel: string; readOnly: boolean; onChange: (text: string) => void;
  autoFocus?: boolean; ref?: Ref<WorkspaceMarkdownEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  const draft = useRef(initialText)
  useImperativeHandle(ref, () => ({
    readDraft() {
      const editor = view.current
      if (!editor) return undefined
      commitActiveNoteCell(editor)
      return draft.current
    },
  }), [])
  useEffect(() => {
    if (!host.current) return
    const separators = new Set(initialText.match(/\r\n|[\r\n]/g))
    const lineSeparator = separators.size === 1 ? EditorState.lineSeparator.of([...separators][0]) : []
    const bom = initialText.startsWith('\uFEFF') ? '\uFEFF' : ''
    const content = initialText.slice(bom.length)
    const initialDocument = Text.of(content.split(/\r\n|[\r\n]/))
    draft.current = initialText
    const editor = new EditorView({ parent: host.current, doc: initialDocument, extensions: [
      lineSeparator, livePreview, history(), keymap.of([...markdownKeys, ...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping,
      EditorView.focusChangeEffect.of((_, focused) => editorFocus.of(focused)),
      EditorView.atomicRanges.of(view => Decoration.set(view.state.field(livePreview).blocks.flatMap(block =>
        block.kind === 'table' && block.replacement ? [block.replacement.range(block.from, block.to)] : []))),
      EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: 'true' }), editingAccess.of([]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return
        draft.current = update.state.doc.eq(initialDocument) ? initialText : bom + update.state.sliceDoc()
        onChange(draft.current)
      }),
    ] })
    view.current = editor
    if (autoFocus) editor.focus()
    return () => { view.current = null; editor.destroy() }
  }, [initialText, ariaLabel, onChange, autoFocus])
  useEffect(() => { view.current?.dispatch({ effects: editingAccess.reconfigure(access(readOnly)) }) },
    [initialText, ariaLabel, onChange, autoFocus, readOnly])
  return <div className="personal-material-editor" ref={host} />
}
