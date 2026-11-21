/** Marked normalizes line endings. Preserve the source offsets used by saved references. */
export function markdownSource(text: string, start = 0, end = text.length) {
  const endings: number[] = []
  const normalized = text.slice(start, end).replace(/\r\n|\r/g, (ending, index: number) => {
    if (ending.length === 2) endings.push(index - endings.length)
    return '\n'
  })
  return {
    text: normalized,
    originalOffset(offset: number) {
      let low = 0, high = endings.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (endings[middle] < offset) low = middle + 1
        else high = middle
      }
      return start + offset + low
    },
  }
}

type TextRun = { node: Text; start?: number; end?: number; sourceOffset?: (offset: number) => number }
const textRuns = new WeakMap<Element, { text: string; runs: TextRun[] }>()
export const markdownEntity = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi

function renderedSource(source: ReturnType<typeof markdownSource>, syntax: string) {
  const hidden: [number, number][] = [], verbatim: [number, number][] = []
  for (const range of syntax.split(';')) {
    const [start, end, kind] = range.split(',')
    if (kind) (kind === 'hidden' ? hidden : verbatim).push([Number(start), Number(end)])
  }
  let raw = source.text
  for (const [start, end] of hidden) raw = raw.slice(0, start) + '\0'.repeat(end - start) + raw.slice(end)
  const offsets: { end: number; adjustment: number; start: number }[] = []
  const decoder = document.createElement('textarea')
  let adjustment = 0
  const text = raw.replace(markdownEntity, (entity, start: number) => {
    if (verbatim.some(([left, right]) => start >= left && start < right)) return entity
    decoder.innerHTML = entity
    const decoded = decoder.value
    if (decoded !== entity) {
      offsets.push({ start, end: start - adjustment + decoded.length, adjustment: adjustment + entity.length - decoded.length })
      adjustment += entity.length - decoded.length
    }
    return decoded
  })
  return { text, originalOffset(offset: number) {
    let low = 0, high = offsets.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (offsets[middle].end <= offset) low = middle + 1
      else high = middle
    }
    const mapped = offset + (offsets[low - 1]?.adjustment ?? 0)
    return source.originalOffset(offsets[low] ? Math.min(mapped, offsets[low].start) : mapped)
  } }
}

function visibleTextNodes(block: HTMLElement) {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.data.trim() && !node.parentElement?.closest('.katex-mathml')) nodes.push(node)
  }
  return nodes
}

function mapTextRuns(nodes: readonly Text[], source: ReturnType<typeof renderedSource>): TextRun[] {
  let cursor = 0
  const forward = nodes.map(node => {
    const index = source.text.indexOf(node.data, cursor)
    if (index >= 0) cursor = index + node.length
    return index
  })
  cursor = source.text.length
  const mapped: TextRun[] = []
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]
    const match = cursor >= node.length ? source.text.lastIndexOf(node.data, cursor - node.length) : -1
    if (match >= 0) cursor = match
    // A repeated spelling in hidden Markdown syntax must not substitute for the rendered occurrence.
    mapped.push(match < 0 || match !== forward[index] ? { node } : {
      node, start: source.originalOffset(match), end: source.originalOffset(match + node.length),
      sourceOffset: offset => source.originalOffset(match + offset),
    })
  }
  return mapped.reverse()
}

function markdownTextRuns(root: HTMLElement, text: string): TextRun[] {
  const preview = root.querySelector('.course-reader-markdown')
  if (!preview) return []
  const cached = textRuns.get(preview)
  if (cached?.text === text) return cached.runs
  const runs = Array.from(preview.querySelectorAll<HTMLElement>('[data-markdown-start]')).flatMap(block => {
    const start = Number(block.dataset.markdownStart), end = Number(block.dataset.markdownEnd)
    const source = renderedSource(markdownSource(text, start, end), block.dataset.markdownSyntax ?? '')
    return mapTextRuns(visibleTextNodes(block), source)
  })
  textRuns.set(preview, { text, runs })
  return runs
}

type ClientPoint = Pick<MouseEvent, 'clientX' | 'clientY'>

function distanceToRect({ clientX: x, clientY: y }: ClientPoint, rect: DOMRect) {
  return Math.max(rect.left - x, x - rect.right, 0) ** 2 + Math.max(rect.top - y, y - rect.bottom, 0) ** 2
}

function renderedCaret(document: Document, nodes: Text[], point: ClientPoint) {
  const native = document.caretPositionFromPoint?.(point.clientX, point.clientY)
  if (native && nodes.includes(native.offsetNode as Text)) return { node: native.offsetNode as Text, offset: native.offset }
  const legacy = document.caretRangeFromPoint?.(point.clientX, point.clientY)
  if (legacy && nodes.includes(legacy.startContainer as Text)) return { node: legacy.startContainer as Text, offset: legacy.startOffset }

  // An editor's non-editable widgets can make native hit testing resolve outside the rendered text.
  const range = document.createRange()
  let nearest: { node: Text; rect: DOMRect; distance: number } | undefined
  for (const node of nodes) {
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue
      const distance = distanceToRect(point, rect)
      if (!nearest || distance < nearest.distance) nearest = { node, rect, distance }
    }
  }
  if (!nearest) return null
  const { node, rect } = nearest
  const row = { clientX: point.clientX, clientY: (rect.top + rect.bottom) / 2 }
  const measure = (offset: number) => {
    range.setStart(node, offset)
    range.collapse(true)
    return range.getBoundingClientRect()
  }
  let left = 0, right = node.length
  while (left < right) {
    const middle = (left + right) >>> 1
    const caret = measure(middle)
    if (caret.bottom < row.clientY || (caret.top <= row.clientY && caret.left < row.clientX)) left = middle + 1
    else right = middle
  }
  const previous = Math.max(0, left - 1)
  const offset = distanceToRect(row, measure(previous)) < distanceToRect(row, measure(left)) ? previous : left
  return { node, offset }
}

function withoutLinePrefixes(source: ReturnType<typeof renderedSource>, kind: 'blockquote' | 'list') {
  const prefixes = kind === 'blockquote' ? /^(?: {0,3}>[ \t]?)+/gm : /^[ \t]+/gm
  const removed: { at: number; total: number }[] = []
  let total = 0
  const text = source.text.replace(prefixes, (prefix, at: number) => {
    removed.push({ at: at - total, total: total + prefix.length })
    total += prefix.length
    return ''
  })
  return {
    text,
    originalOffset(offset: number) {
      let low = 0, high = removed.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (removed[middle].at <= offset) low = middle + 1
        else high = middle
      }
      return source.originalOffset(offset + (removed[low - 1]?.total ?? 0))
    },
  }
}

export function renderedMarkdownCaret(block: HTMLElement, text: string, syntax: string, point: ClientPoint, kind?: string) {
  const nodes = visibleTextNodes(block)
  const caret = renderedCaret(block.ownerDocument, nodes, point)
  if (!caret) return null
  const source = renderedSource(markdownSource(text), syntax)
  // TeX commands are not literal glyphs. Mask their names without changing the positions of the arguments.
  if (kind === 'math') source.text = source.text.replace(/\\(?:[a-zA-Z]+|.)/g, command => '\0'.repeat(command.length))
  const run = mapTextRuns(nodes, source).find(candidate => candidate.node === caret.node)
  if (run?.sourceOffset) return run.sourceOffset(caret.offset)
  if (kind === 'blockquote' || kind === 'list') {
    // Rendered paragraphs can span source lines whose Markdown prefixes are absent from the text node.
    const projected = withoutLinePrefixes(source, kind)
    const projectedRun = mapTextRuns(nodes, projected).find(candidate => candidate.node === caret.node)
    if (projectedRun?.sourceOffset) return projectedRun.sourceOffset(caret.offset)
  }
  if (kind === 'math') {
    // In a fraction the rendered text order can differ from the order of the arguments in TeX.
    const first = source.text.indexOf(caret.node.data)
    if (first >= 0 && first === source.text.lastIndexOf(caret.node.data)) return source.originalOffset(first + caret.offset)
  }
  return null
}

export function selectedMarkdownOffsets(root: HTMLElement, text: string, selection: Range) {
  const selected = markdownTextRuns(root, text).filter(({ node }) => selection.intersectsNode(node))
  const first = selected[0], last = selected.at(-1)
  if (!first?.sourceOffset || !last?.sourceOffset) return null
  const start = first.sourceOffset(selection.startContainer === first.node ? selection.startOffset : 0)
  const end = last.sourceOffset(selection.endContainer === last.node ? selection.endOffset : last.node.length)
  return { start, end }
}

function displayOffset(run: Required<TextRun>, sourceOffset: number) {
  let low = 0, high = run.node.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (run.sourceOffset(middle) < sourceOffset) low = middle + 1
    else high = middle
  }
  return low
}

export function renderedMarkdownRange(root: HTMLElement, text: string, start: number, end: number): Range | null {
  const selected = markdownTextRuns(root, text).filter((run): run is Required<TextRun> =>
    run.start !== undefined && run.end !== undefined && run.start < end && run.end > start)
  const first = selected[0], last = selected.at(-1)
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, displayOffset(first, start))
  range.setEnd(last.node, displayOffset(last, end))
  return range.collapsed ? null : range
}
