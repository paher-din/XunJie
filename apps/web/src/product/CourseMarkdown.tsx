import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { Marked, Renderer, Tokenizer } from 'marked'
import 'katex/dist/katex.min.css'
import { markdownSource } from './courseMarkdownSelection'

const inlineFormula = /^\$(?![\s$])((?:\\[^\r\n]|[^\\$\r\n])+)\$(?![\d$])/
const displayFormula = /^ {0,3}\$\$[ \t]*\n([\s\S]*?)\n {0,3}\$\$[ \t]*(?:\n|$)/
const shortDisplayFormula = /^ {0,3}\$\$((?:\\[^\r\n]|[^\\$\r\n])+)\$\$[ \t]*(?:\n|$)/
const boldSpan = /^\*\*(?!\*)((?:\\[^\r\n]|[^*\\\r\n])+)\*\*(?!\*)/
const hanText = /\p{Script=Han}/u
const outerPunctuation = /^\p{P}|\p{P}$/u

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function formula(text: string, raw: string, displayMode: boolean) {
  try {
    if (text.length <= 8192) {
      return katex.renderToString(text, {
        displayMode, trust: false, maxExpand: 500, maxSize: 40, throwOnError: true, strict: 'ignore',
      })
    }
  } catch { /* Keep unsupported syntax readable as source. */ }
  return '<code>' + escapeHtml(raw.trim()) + '</code>'
}

const markdown = new Marked({
  gfm: true,
  tokenizer: {
    emStrong(source, maskedSource, previous) {
      const span = boldSpan.exec(source)
      if (!span) return false
      const [raw, text] = span
      // Chinese quotes and brackets can touch the surrounding sentence without spaces.
      const surroundingText = (previous ?? '') + text + source.charAt(raw.length)
      if (text.trim() !== text || !outerPunctuation.test(text) || !hanText.test(surroundingText)
        || !maskedSource.slice(-source.length).slice(0, raw.length).endsWith('**')) return false
      return Tokenizer.prototype.emStrong.call(this, source, maskedSource, previous)
        ?? { type: 'strong', raw, text, tokens: this.lexer.inlineTokens(text) }
    },
  },
  extensions: [{
    name: 'courseInlineMath',
    level: 'inline',
    start(source) { return source.indexOf('$') },
    tokenizer(source) {
      const match = inlineFormula.exec(source)
      if (match && !/\s$/.test(match[1]))
        return { type: 'courseInlineMath', raw: match[0], text: match[1] }
    },
    renderer(token) { return formula(token.text, token.raw, false) },
  }, {
    name: 'courseDisplayMath',
    level: 'block',
    start(source) {
      const line = /\n {0,3}\$\$/.exec(source)
      return line ? line.index + 1 : undefined
    },
    tokenizer(source) {
      const match = displayFormula.exec(source) ?? shortDisplayFormula.exec(source)
      if (match?.[1].trim()) return { type: 'courseDisplayMath', raw: match[0], text: match[1].trim() }
    },
    renderer(token) {
      return '<div class="course-reader-math-block">' + formula(token.text, token.raw, true) + '</div>'
    },
  }],
  renderer: {
    heading({ depth, tokens }) {
      const tag = 'h' + Math.min(6, depth + 2)
      return '<' + tag + '>' + this.parser.parseInline(tokens) + '</' + tag + '>'
    },
    html(token) { return escapeHtml(token.raw) },
    image(token) { return escapeHtml(token.text) },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (!/^https?:\/\//i.test(href)) return label
      try {
        const url = new URL(href)
        if (!url.username && !url.password)
          return '<a href="' + escapeHtml(url.href) + '" target="_blank" rel="noopener noreferrer" draggable="false">' + label + '</a>'
      } catch { /* Malformed links remain readable as text. */ }
      return label
    },
    table(token) {
      return '<div class="course-reader-table" role="region" aria-label="表格" tabindex="0">'
        + Renderer.prototype.table.call(this, token) + '</div>'
    },
  },
})

export default function CourseMarkdown({ text, preservePlainText = false }: { text: string; preservePlainText?: boolean }) {
  const html = useMemo(() => {
    try {
      if (!DOMPurify.isSupported) return null
      const source = markdownSource(text, text.startsWith('\uFEFF') ? 1 : 0)
      const tokens = markdown.lexer(source.text)
      if (preservePlainText && tokens.every(token => token.type === 'space'
        || (token.type === 'paragraph' && token.tokens?.every(part => part.type === 'text')))) return null
      let cursor = 0
      const blocks = tokens.map(token => {
        const start = source.text.indexOf(token.raw, cursor)
        const block = markdown.parser([token])
        if (start < 0) return block
        cursor = start + token.raw.length
        return block && `<div data-markdown-start="${source.originalOffset(start)}" data-markdown-end="${source.originalOffset(cursor)}">${block}</div>`
      })
      return DOMPurify.sanitize(blocks.join(''), {
        ADD_ATTR: ['target', 'draggable', 'data-markdown-start', 'data-markdown-end'],
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['img', 'audio', 'video', 'iframe', 'object', 'embed', 'style', 'form'],
      })
    } catch { return null }
  }, [text, preservePlainText])
  if (html === null) return preservePlainText ? <>{text}</> : <pre className="course-reader-plain">{text}</pre>
  return <article className="course-reader-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
