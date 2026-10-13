import { Fragment, type ReactNode } from 'react'
import { lexer, type Token, type Tokens } from 'marked'
import remend from 'remend'

/**
 * 正文 markdown 渲染：marked 词法切块 + 自写 React 渲染（不走 HTML 注入，未知结构按纯文本兜底）。
 *
 * 流式形态（docs/agent-page-design.md「未闭合 markdown」的口径）：
 * - 未闭合加粗 / 行内代码 / 链接：remend 在文本尾部补齐，中途即按目标样式渲染；
 * - 未闭合代码围栏：marked 按 CommonMark 切到文末，从围栏第一行起就是 code 块，不闪回行内代码；
 * - 表格：分隔行打全前按段落渲染，打全后翻成表格（一次性跳变，可接受）。
 *
 * 内容口径：教学回复是受控输出——段落 / 加粗 / 行内代码 / 代码块 / 列表 / 表格 / 引用 / 标题；
 * 无公式、无 mermaid、不渲染原始 HTML 与图片。
 */
export function Markdown({
  text,
  live,
  insert,
  insertAfterPara,
}: {
  text: string
  /** 流式中：自愈未闭合语法，并在最后一个块的内容末尾跟闪烁光标。 */
  live?: boolean
  /** 落定挂载的消息内块（概念讲解卡），嵌在第 insertAfterPara 段之后。 */
  insert?: ReactNode
  /** 插入位置：第 N 个段落（1 起，只数段落块）之后；缺省或超出则附在正文末尾。 */
  insertAfterPara?: number
}) {
  const tokens = lexer(live ? remend(text) : text)
  const caret = live ? <span className="turn-caret" /> : undefined
  const paraTotal = tokens.reduce((n, t) => n + (t.type === 'paragraph' ? 1 : 0), 0)
  const at =
    insert && insertAfterPara && insertAfterPara >= 1 && insertAfterPara <= paraTotal
      ? insertAfterPara
      : paraTotal
  let para = 0
  return (
    <div className="turn-body">
      {tokens.map((token, i) => {
        if (token.type === 'paragraph') para++
        const insertHere =
          insert &&
          ((token.type === 'paragraph' && para === at) ||
            (at === paraTotal && i === tokens.length - 1))
        return (
          <Fragment key={i}>
            <Block token={token} caret={i === tokens.length - 1 ? caret : undefined} />
            {insertHere && insert}
          </Fragment>
        )
      })}
    </div>
  )
}

/** 块级渲染；caret 只透传进能内联收光标的块（段落 / 标题 / 代码 / 列表末项）。 */
function Block({ token, caret }: { token: Token; caret?: ReactNode }) {
  switch (token.type) {
    case 'space':
      return null
    case 'paragraph': {
      const t = token as Tokens.Paragraph
      return (
        <p>
          <Inline tokens={t.tokens} />
          {caret}
        </p>
      )
    }
    case 'heading': {
      const t = token as Tokens.Heading
      // 消息内标题从 h3 起、压到 h4 封顶：不盖过页面自身的标题层级
      const depth = Math.min(Math.max(t.depth + 2, 3), 4)
      const Tag = `h${depth}` as 'h3'
      return (
        <Tag className="md-h">
          <Inline tokens={t.tokens} />
          {caret}
        </Tag>
      )
    }
    case 'code': {
      const t = token as Tokens.Code
      const lang = (t.lang ?? '').toLowerCase()
      const body =
        lang === 'verilog' || lang === 'systemverilog' || lang === 'sv' || lang === 'v'
          ? highlightVerilog(t.text)
          : t.text
      return (
        <div className="md-pre">
          {t.lang && <span className="md-pre-lang">{t.lang}</span>}
          <pre>
            <code>
              {body}
              {caret}
            </code>
          </pre>
        </div>
      )
    }
    case 'list':
      return <ListBlock token={token as Tokens.List} caret={caret} />
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      return (
        <blockquote className="md-quote">
          {t.tokens.map((sub, i) => (
            <Block key={i} token={sub} caret={i === t.tokens.length - 1 ? caret : undefined} />
          ))}
        </blockquote>
      )
    }
    case 'table':
      return <TableBlock token={token as Tokens.Table} />
    case 'hr':
      return <hr className="md-hr" />
    default:
      // html / def / 未知块：不渲染原始 HTML，按纯文本兜底
      return 'raw' in token && token.raw.trim() ? <p>{token.raw}</p> : null
  }
}

function ListBlock({ token, caret }: { token: Tokens.List; caret?: ReactNode }) {
  const Tag = token.ordered ? 'ol' : 'ul'
  const start = typeof token.start === 'number' && token.start > 1 ? token.start : undefined
  return (
    <Tag className="md-list" start={start}>
      {token.items.map((item, j) => {
        const lastItem = j === token.items.length - 1
        return (
          <li key={j}>
            {item.tokens.map((sub, k) => {
              if (sub.type === 'text' || sub.type === 'paragraph') {
                // 紧凑列表项是 text token，松散列表项是 paragraph；都按行内渲染
                return (
                  <Fragment key={k}>
                    <Inline tokens={(sub as Tokens.Text).tokens ?? []} />
                    {lastItem && k === item.tokens.length - 1 ? caret : undefined}
                  </Fragment>
                )
              }
              return <Block key={k} token={sub} />
            })}
          </li>
        )
      })}
    </Tag>
  )
}

function TableBlock({ token }: { token: Tokens.Table }) {
  return (
    <table className="md-table">
      <thead>
        <tr>
          {token.header.map((cell, i) => (
            <th key={i}>
              <Inline tokens={cell.tokens} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {token.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>
                <Inline tokens={cell.tokens} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 行内渲染：只认受控子集；text / escape / 行内 html 一律按纯文本输出（React 天然转义）。 */
function Inline({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'strong':
            return (
              <strong key={i}>
                <Inline tokens={(token as Tokens.Strong).tokens} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inline tokens={(token as Tokens.Em).tokens} />
              </em>
            )
          case 'codespan':
            return (
              <code key={i} className="md-code">
                {(token as Tokens.Codespan).text}
              </code>
            )
          case 'link': {
            const t = token as Tokens.Link
            const safe = /^https?:\/\//i.test(t.href) || t.href.startsWith('mailto:')
            return safe ? (
              <a key={i} className="md-link" href={t.href} target="_blank" rel="noreferrer noopener">
                <Inline tokens={t.tokens} />
              </a>
            ) : (
              <Inline key={i} tokens={t.tokens} />
            )
          }
          case 'del':
            return (
              <del key={i}>
                <Inline tokens={(token as Tokens.Del).tokens} />
              </del>
            )
          case 'br':
            return <br key={i} />
          case 'image':
            // 教学回复不内嵌图片；显示 alt 文本兜底
            return <Fragment key={i}>{(token as Tokens.Image).text}</Fragment>
          default: {
            // text / escape / 行内 html：纯文本输出
            const t = token as Tokens.Text
            return t.tokens?.length ? (
              <Inline key={i} tokens={t.tokens} />
            ) : (
              <Fragment key={i}>{t.text}</Fragment>
            )
          }
        }
      })}
    </>
  )
}

/**
 * Verilog/SystemVerilog 迷你高亮：单趟词法扫描，直接输出 React span，不引高亮库。
 * 课程代码几乎只有这一种语言；流式中途也安全——未闭合注释 / 字符串按到文末处理。
 */
const SV_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?)|(\d*'[bdhBDH][0-9a-fA-F_xXzZ?]+|'[01xXzZ?]\b|\b\d+(?:\.\d+)?\b)|(\$[a-zA-Z_]\w*)|\b(module|endmodule|always|always_ff|always_comb|always_latch|if|else|begin|end|case|casez|casex|endcase|default|for|while|repeat|forever|assign|input|output|inout|wire|reg|logic|bit|parameter|localparam|typedef|enum|struct|packed|interface|endinterface|package|endpackage|import|function|endfunction|task|endtask|return|initial|posedge|negedge|genvar|generate|endgenerate|unique|priority)\b/g

function highlightVerilog(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of code.matchAll(SV_TOKEN)) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const cls = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : m[4] ? 'tok-f' : 'tok-k'
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
