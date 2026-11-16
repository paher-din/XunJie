/** 兼容旧入口；实现由正式包提供。 */
import { Markdown as MarkdownView, type MarkdownProps } from '@xunjie/ui/chat'
import { useSmoothStreamText } from '@xunjie/ui/chat'
export { blocksOf, realBlocks, Block, CodeBlock, ListBlock, TableBlock, Inline, Chars } from '@xunjie/ui/chat'
export function Markdown(props: MarkdownProps) {
  const shown = useSmoothStreamText(props.text, !!props.live)
  return <MarkdownView {...props} text={props.variant === 'astryx' ? shown : props.text} />
}
export type { MarkdownProps, BlockProps, CodeBlockProps, ListBlockProps, TableBlockProps, InlineProps, CharsProps } from '@xunjie/ui/chat'
