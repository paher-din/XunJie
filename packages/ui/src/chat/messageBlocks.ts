import type { Token } from 'marked'

/**
 * 消息内卡片挂在讲它的那一段之后；那段若引出列表 / 代码 / 表格，就一并跟到它们后面——
 * 卡片插进列表中间会把两条对照拆成两截。标题不停在这里：它开的是下一节，卡片不能压在节标题前面。
 * 缺省或超出段数则附在正文末尾。
 *
 * 这条落点规则有两个调用方：渲染器按它把卡片插进正文块序列，mock 剧本按它算出
 * 「讲到哪儿该开始画卡片」的字符偏移。两边共用一份，卡片才不会出现「正文讲完了才补一张」。
 */
export function insertIndex(blocks: Token[], afterPara?: number): number {
  let idx = -1
  let para = 0
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type !== 'paragraph') continue
    para++
    if (para === afterPara) idx = i
  }
  if (idx < 0) return blocks.length - 1
  const trailing = new Set(['list', 'code', 'table', 'blockquote', 'hr', 'space'])
  while (trailing.has(blocks[idx + 1]?.type)) idx++
  return idx
}
