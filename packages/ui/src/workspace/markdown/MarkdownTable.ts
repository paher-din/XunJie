import { Text, type ChangeDesc } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import type { Tokens } from 'marked'
import { courseMarkdownSourceSyntax, renderCourseMarkdownToken, sanitizeCourseMarkdown } from './markup'
import { renderedMarkdownCaret } from './selection'

type CellSpan = { from: number; to: number }
type TableRow = { raw: string; offset: number; cells: CellSpan[]; leadingPipe: boolean; trailingPipe: boolean }

function tableRow(raw: string, offset: number): TableRow {
  const cells: CellSpan[] = []
  let from = 0, slashCount = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '|' && slashCount % 2 === 0) {
      cells.push({ from, to: i })
      from = i + 1
    }
    slashCount = raw[i] === '\\' ? slashCount + 1 : 0
  }
  const leadingPipe = cells.length > 0 && !raw.slice(0, cells[0].to).trim()
  const trailingPipe = cells.length > 0 && !raw.slice(from).trim()
  if (leadingPipe) cells.shift()
  if (!trailingPipe) cells.push({ from, to: raw.length })
  return { raw, offset, cells, leadingPipe, trailingPipe }
}

function replaceCell(row: TableRow, column: number, value: string) {
  const cell = row.cells[column]
  const body = value.replace(/\r\n?|\n/g, ' ').trim().replace(/(\\*)\|/g, (_, slashes: string) =>
    slashes + (slashes.length % 2 === 0 ? '\\|' : '|'))
  // Frame the edited row so an empty edge cell or a pasted Markdown marker stays in the table.
  const start = row.leadingPipe ? '' : '| ', end = row.trailingPipe ? '' : ' |'
  if (!cell) return start + row.raw + end + '|'.repeat(column - row.cells.length) + ` ${body} |`
  return start + row.raw.slice(0, cell.from) + ` ${body} ` + row.raw.slice(cell.to) + end
}

type FinishCell = (commit: boolean) => ChangeDesc | undefined
type OpenCell = (index: number, point?: MouseEvent) => void
const activeCells = new WeakMap<EditorView, FinishCell>()
const tableCells = new WeakMap<HTMLElement, OpenCell>()

export function commitActiveNoteCell(view: EditorView) {
  return activeCells.get(view)?.(true)
}

export function emptyNoteTableRow(columns: number) {
  return '|' + '   |'.repeat(columns)
}

export function noteTableHeaderColumns(text: string) {
  if (!/^ {0,3}\|/.test(text)) return 0
  const row = tableRow(text, 0)
  if (!row.trailingPipe || row.cells.length < 2) return 0
  return row.cells.some(cell => !/^\s*:?-{3,}:?\s*$/.test(text.slice(cell.from, cell.to))) ? row.cells.length : 0
}

export function focusNoteTableCell(view: EditorView, start: number, index: number, point?: MouseEvent) {
  const table = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.personal-note-table'))
    .find(element => view.posAtDOM(element) === start)
  if (table) tableCells.get(table)?.(index, point)
}

function openCellAfterCommit(view: EditorView, table: HTMLElement, index: number, point?: MouseEvent) {
  const start = view.posAtDOM(table)
  const changes = commitActiveNoteCell(view)
  focusNoteTableCell(view, changes?.mapPos(start, -1) ?? start, index, point)
}

export class PersonalNoteTable extends WidgetType {
  private rendered?: string
  private readonly raw: string

  constructor(private readonly token: Tokens.Table) {
    super()
    this.raw = token.raw.replace(/\n+$/, '')
  }

  private markup() { return this.rendered ??= renderCourseMarkdownToken(this.token) }

  eq(other: PersonalNoteTable) { return this.raw === other.raw && this.markup() === other.markup() }

  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument
    const element = doc.createElement('div')
    element.className = 'personal-note-block personal-note-table course-reader-markdown'
    element.innerHTML = sanitizeCourseMarkdown(this.markup())
    const region = element.querySelector<HTMLElement>('.course-reader-table')!
    const cells = Array.from(element.querySelectorAll<HTMLTableCellElement>('th,td'))
    for (const control of element.querySelectorAll<HTMLElement>('a,input')) control.tabIndex = -1
    const columns = this.token.header.length
    const markdownCells = [this.token.header, ...this.token.rows]
    let offset = 0
    const rows = this.raw.split('\n').flatMap((raw, index) => {
      const rowOffset = offset
      offset += raw.length + 1
      return index === 1 ? [] : [tableRow(raw, rowOffset)]
    })

    const openCell: OpenCell = (index, point) => {
      const cell = cells[index]
      if (!cell || view.state.readOnly) return
      const rowIndex = Math.floor(index / columns), column = index % columns
      const row = rows[rowIndex], span = row?.cells[column]
      if (!row) return
      const value = span ? row.raw.slice(span.from, span.to).trim() : ''
      const token = { type: 'paragraph' as const, raw: value, text: value, tokens: markdownCells[rowIndex][column].tokens }
      const caret = point ? renderedMarkdownCaret(cell, value, courseMarkdownSourceSyntax(token), point) : null
      const contents = Array.from(cell.childNodes)
      const input = doc.createElement('textarea')
      input.className = 'personal-note-cell-editor'
      input.rows = 1
      input.value = value
      input.setAttribute('aria-label', rowIndex ? `第 ${rowIndex} 行第 ${column + 1} 列` : `第 ${column + 1} 列表头`)

      const start = view.posAtDOM(element)
      view.dispatch({ selection: { anchor: start } })
      const finish: FinishCell = commit => {
        if (activeCells.get(view) !== finish) return
        activeCells.delete(view)
        cell.replaceChildren(...contents)
        if (!commit || view.state.readOnly || input.value === value || !element.isConnected) return
        const from = view.posAtDOM(element)
        if (view.state.doc.sliceString(from, from + this.raw.length) !== this.raw) return
        const updated = replaceCell(row, column, input.value)
        if (updated === row.raw) return
        const change = view.state.changes({ from: from + row.offset, to: from + row.offset + row.raw.length, insert: updated })
        view.dispatch({ changes: change, userEvent: 'input' })
        return change
      }
      activeCells.set(view, finish)
      input.addEventListener('input', () => view.requestMeasure())
      input.addEventListener('blur', () => finish(true))
      const addRow = () => {
        const tableStart = view.posAtDOM(element)
        const rowEnd = rowIndex ? row.offset + row.raw.length : this.raw.indexOf('\n', row.raw.length + 1)
        const position = tableStart + (rowEnd < 0 ? this.raw.length : rowEnd)
        const changes = finish(true)
        const insertAt = changes?.mapPos(position, 1) ?? position
        view.dispatch({ changes: { from: insertAt, insert: Text.of(['', emptyNoteTableRow(columns)]) }, userEvent: 'input' })
        focusNoteTableCell(view, tableStart, (rowIndex + 1) * columns)
      }
      input.addEventListener('keydown', event => {
        if (event.isComposing) return
        if (event.key === 'Tab') {
          const next = index + (event.shiftKey ? -1 : 1)
          if (cells[next]) {
            event.preventDefault()
            openCellAfterCommit(view, element, next)
          } else if (!event.shiftKey && !view.state.readOnly) {
            event.preventDefault()
            addRow()
          }
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !view.state.readOnly) {
          event.preventDefault()
          addRow()
        } else if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          finish(event.key === 'Enter')
          view.focus()
        }
      })
      cell.replaceChildren(input)
      view.requestMeasure()
      input.focus({ preventScroll: true })
      input.setSelectionRange(caret ?? value.length, caret ?? value.length)
    }

    tableCells.set(element, openCell)
    region.addEventListener('keydown', event => {
      if (event.target === region && (event.key === 'Enter' || event.key === 'F2')) {
        event.preventDefault()
        openCellAfterCommit(view, element, 0)
      }
    })
    element.addEventListener('mousedown', event => {
      if (event.button !== 0 || !(event.target instanceof Element)) return
      if (event.target.closest('.personal-note-cell-editor')) return
      const cell = event.target.closest<HTMLTableCellElement>('th,td')
      const index = cell ? cells.indexOf(cell) : -1
      if (index < 0 || view.state.readOnly) return
      event.preventDefault()
      openCellAfterCommit(view, element, index, event)
    })
    element.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a')) event.preventDefault()
    })
    return element
  }

  destroy(element: HTMLElement) {
    tableCells.delete(element)
  }
}
