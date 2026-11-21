import { useMemo } from 'react'
import { courseMarkdownSourceSyntax, courseMarkdownSupported, lexCourseMarkdown, markdownSource,
  renderCourseMarkdownToken, sanitizeCourseMarkdown } from '@xunjie/ui/workspace/markdown'

export default function CourseMarkdown({ text, preservePlainText = false }: { text: string; preservePlainText?: boolean }) {
  const html = useMemo(() => {
    try {
      if (!courseMarkdownSupported()) return null
      const source = markdownSource(text, text.startsWith('\uFEFF') ? 1 : 0)
      const tokens = lexCourseMarkdown(source.text)
      if (preservePlainText && tokens.every(token => token.type === 'space'
        || (token.type === 'paragraph' && token.tokens?.every(part => part.type === 'text')))) return null
      let cursor = 0
      const blocks = tokens.map(token => {
        const start = source.text.indexOf(token.raw, cursor)
        const block = renderCourseMarkdownToken(token)
        if (start < 0) return block
        cursor = start + token.raw.length
        return block && `<div data-markdown-start="${source.originalOffset(start)}" data-markdown-end="${source.originalOffset(cursor)}" data-markdown-syntax="${courseMarkdownSourceSyntax(token)}">${block}</div>`
      })
      return sanitizeCourseMarkdown(blocks.join(''))
    } catch { return null }
  }, [text, preservePlainText])
  if (html === null) return preservePlainText ? <>{text}</> : <pre className="course-reader-plain">{text}</pre>
  return <article className="course-reader-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
