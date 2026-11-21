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
  const text = raw.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity, start: number) => {
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

function markdownTextRuns(root: HTMLElement, text: string): TextRun[] {
  const preview = root.querySelector('.course-reader-markdown')
  if (!preview) return []
  const cached = textRuns.get(preview)
  if (cached?.text === text) return cached.runs
  const runs = Array.from(preview.querySelectorAll<HTMLElement>('[data-markdown-start]')).flatMap(block => {
    const start = Number(block.dataset.markdownStart), end = Number(block.dataset.markdownEnd)
    const source = renderedSource(markdownSource(text, start, end), block.dataset.markdownSyntax ?? '')
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.data.trim() && !node.parentElement?.closest('.katex-mathml')) nodes.push(node)
    }
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
  })
  textRuns.set(preview, { text, runs })
  return runs
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
