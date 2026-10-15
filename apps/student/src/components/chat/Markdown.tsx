import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { lexer, type Token, type Tokens } from 'marked'
import remend, { isWithinCodeBlock } from 'remend'
import { insertIndex } from '../../lib/messageBlocks'
import { Icon } from '../../icons'

/**
 * 正文 markdown 渲染：marked 词法切块 + 自写 React 渲染（不走 HTML 注入，未知结构按纯文本兜底）。
 *
 * 流式形态（docs/agent-page-design.md「未闭合 markdown」的口径）：
 * - 未闭合加粗 / 行内代码 / 链接：remend 在文本尾部补齐，中途即按目标样式渲染；
 * - 刚落下、正文还没跟到的成对开标记（`**` / 反引号）先不画，正文到达那一拍才连着它一起上屏（见 stripTailOpener）；
 * - 未闭合代码围栏：marked 按 CommonMark 切到文末，从围栏第一行起就是 code 块，不闪回行内代码；
 * - 表格：分隔行打全前整块不渲染（那 1 秒 marked 只把它当裸文本，照原样画就是满屏 `|`），打全那一拍整张成形；
 * - 只有标记、还没有内容的那一拍不渲染（见 realBlocks），正文里不会闪过空子弹 / 空代码盒 / 空标题；
 * - 消息内卡片（概念讲解卡）在它依附的那一段真的流完之后才挂上，不会先钉在当时的正文末尾再换位；
 * - 尾块逐字淡入（Chars）：新字挂载时各自淡一次，屏上留一条软尾，已上屏的字不重播。
 *
 * 被截断的落定态（已停止 / 中途失败）走同一套语法自愈（truncated），只是没有光标、不逐字淡入：
 * 停在半路的 `**` 不该永久留在会话记录里。
 *
 * 每帧只有尾块重渲染：块按 raw 记忆（Block 的比较器），前面的块内容没变就不重来。
 *
 * 内容口径：教学回复是受控输出——段落 / 加粗 / 行内代码 / 代码块（语言标签）/ 列表 / 表格 /
 * 引用 / 标题（消息内 h3–h4）；无公式、无 mermaid、不渲染原始 HTML 与图片。
 */
export function Markdown({
  text,
  live,
  truncated,
  insert,
  insertAfterPara,
}: {
  text: string
  /** 流式中：自愈未闭合语法，尾块逐字淡入，并在最后一个块的内容末尾跟闪烁光标。 */
  live?: boolean
  /** 文本是被截断的半成品（已停止 / 中途失败）：语法照样自愈，但没有光标、也不逐字淡入。 */
  truncated?: boolean
  /** 消息内块（概念讲解卡）；流式中会在它依附的那一段流完之后挂上，落定后按落点规则就位。 */
  insert?: ReactNode
  /** 插入位置：第 N 个段落（1 起，只数段落块）之后，那段引出的列表 / 代码一并带上；缺省或超出则附在正文末尾。 */
  insertAfterPara?: number
}) {
  const blocks = blocksOf(text, live, truncated)
  const caret = live ? <span className="turn-caret" /> : undefined
  const at = insert ? anchorIndex(blocks, insertAfterPara, live) : -1
  return (
    <div className="turn-body">
      {blocks.map((token, i) => (
        <Fragment key={i}>
          <Block token={token} caret={i === blocks.length - 1 ? caret : undefined} tail={live && i === blocks.length - 1} />
          {i === at && insert}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * 流式中卡片要等它依附的那一段真的上了屏才挂：早半拍会先钉在当时的正文末尾，
 * 等段落数够再跳回正确位置——读者看到的是一次换位，不是一段连续的输出。
 * 没写 afterPara 的卡片依附「正文讲完」这件事，所以仍按老规矩等落定（live 为假时挂）。
 */
function anchorIndex(blocks: Token[], afterPara: number | undefined, live?: boolean): number {
  if (live) {
    if (!afterPara) return -1
    if (blocks.filter((t) => t.type === 'paragraph').length < afterPara) return -1
  }
  return insertIndex(blocks, afterPara)
}

/**
 * 一拍文本会渲染成哪几个块：流式中与停在半路时走同一套自愈管线（测试也走这里，
 * 免得测试自己拼的那条路与组件越拼越远）。
 */
export function blocksOf(text: string, live?: boolean, truncated?: boolean): Token[] {
  if (!live && !truncated) return realBlocks(lexer(text))
  return realBlocks(lexer(remend(stripTailOpener(text))), live, truncated)
}

/**
 * 只留真会渲染的块：空行不进 DOM；流式中与停在半路的回复里，「标记刚起头、内容还没来」的尾块先当不存在。
 * 那一拍 marked 会把 `*`（正文首拍的加粗前导）判成一条空列表、把 ``` 判成一只空代码盒、
 * 把 `#` 判成一行空标题、把 `>` 判成一只空引用盒，下一拍就有内容——按着渲染就是正文流里
 * 闪过一枚空子弹 / 一只空盒子 / 一行只挂着光标的空标题，实测每条回复 1–2 次；而按下「停止」
 * 正好停在那一拍时，那枚空子弹会永久留在会话记录里（实测三次停止中的一次）。
 * 表格另说：分隔行打全前 marked 只会把它判成一段裸文本，照原样渲染就是满屏 `|` 与 `---`，
 * 这一段（约 1 秒）先不渲染，打全那一拍整张表一次成形。但停在半路的表没有「下一拍」——
 * 那半截 `| 状态 | 任务` 就是它的全部内容，不能跟着空子弹一起藏掉。落定后一块不少。
 */
export function realBlocks(tokens: Token[], live?: boolean, truncated?: boolean): Token[] {
  const out = tokens.filter((t) => t.type !== 'space')
  const tail = out[out.length - 1]
  if (!tail || !(live || truncated)) return out
  if (tail.type === 'paragraph' && (tail as Tokens.Paragraph).text.trim().startsWith('|'))
    return live ? out.slice(0, -1) : out
  return isMarkerOnly(tail) ? out.slice(0, -1) : out
}

const MARKER_ONLY = /^[*_~`]{1,3}$/

function isMarkerOnly(token: Token): boolean {
  switch (token.type) {
    case 'code':
      return !(token as Tokens.Code).text.trim()
    case 'heading':
      // `#` 刚落下：marked 已经把它当标题块，渲染出来是一行只有光标的空标题
      return !(token as Tokens.Heading).text.trim()
    case 'list':
      return (token as Tokens.List).items.every((it) => !it.text.trim())
    case 'blockquote':
      // `>` 同理：引用里还没有字，那一拍它是个空盒子（tokens 为空数组也算）
      return (token as Tokens.Blockquote).tokens.every(isMarkerOnly)
    case 'paragraph':
      return MARKER_ONLY.test((token as Tokens.Paragraph).text.trim())
    default:
      return false
  }
}

/** 块级渲染；caret 与逐字淡入只给能内联收住它们的块（段落 / 标题 / 列表末项 / 引用末块）。 */
const Block = memo(
  function Block({ token, caret, tail }: { token: Token; caret?: ReactNode; tail?: boolean }) {
    switch (token.type) {
      case 'space':
        return null
      case 'paragraph': {
        const t = token as Tokens.Paragraph
        return (
          <p>
            <Inline tokens={t.tokens} tail={tail} />
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
            <Inline tokens={t.tokens} tail={tail} />
            {caret}
          </Tag>
        )
      }
      case 'code':
        // 代码块不逐字淡入：高亮 span 的行内结构不该被拆开重排
        return <CodeBlock token={token as Tokens.Code} caret={caret} />
      case 'list':
        return <ListBlock token={token as Tokens.List} caret={caret} tail={tail} />
      case 'blockquote': {
        const t = token as Tokens.Blockquote
        return (
          <blockquote className="md-quote">
            {t.tokens.map((sub, i) => (
              <Block
                key={i}
                token={sub}
                caret={i === t.tokens.length - 1 ? caret : undefined}
                tail={tail && i === t.tokens.length - 1}
              />
            ))}
          </blockquote>
        )
      }
      case 'table':
        return <TableBlock token={token as Tokens.Table} caret={caret} />
      case 'hr':
        return <hr className="md-hr" />
      default:
        // html / def / 未知块：不渲染原始 HTML，按纯文本兜底
        return 'raw' in token && token.raw.trim() ? <p>{token.raw}</p> : null
    }
  },
  // 内容等价即不重渲染：每帧只有尾块的 raw 在长，前面的块一律跳过
  (a, b) => a.token.raw === b.token.raw && a.tail === b.tail && !!a.caret === !!b.caret,
)

/** 代码块：一条顶栏放语言与复制键；正文按语言走迷你高亮，无语言时按纯文本。 */
function CodeBlock({ token, caret }: { token: Tokens.Code; caret?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const [copyError,setCopyError]=useState(false)
  const lang = (token.lang ?? '').toLowerCase()
  // 光标还落在这一块 = 还在写；但围栏一闭合就该高亮，不必等下一块开始
  const open = !!caret && !FENCE_CLOSED.test(token.raw)
  // 还在写就先出纯文本：每帧重扫整段代码会把高亮 span 全部重建（成本随已到达长度线性增长），
  // 而中途的判词边界下一拍就会被改判——闭合那一拍扫一次就够。Streamdown 同一条口径。
  // 收尾的 ``` 是一拍一拍敲进来的：围栏还没闭合时，先敲下的 1–2 个反引号会被 marked 当成
  // 代码内容画在末尾，削掉（停在半路的回复同理，那半截 ``` 会永久留在记录里）。
  const code = FENCE_CLOSED.test(token.raw) ? token.text : token.text.replace(/`{1,2}$/, '')
  const body = VERILOG_LANGS.has(lang) && !open ? highlightVerilog(code) : code
  // 光标还落在这一块 = 围栏没闭合，复制出去是半截代码，先不给按
  const pending = !!caret
  const pre = useGrowPin<HTMLPreElement>(pending, token.text)
  return (
    <div className="md-pre">
      <div className="md-pre-bar">
        <span className="md-pre-lang">{lang || 'text'}</span>
        <button
          type="button"
          disabled={pending}
          aria-label={pending ? '代码生成中' : copied ? '已复制代码' : '复制代码'}
          title={pending ? '生成中' : copied ? '已复制' : '复制代码'}
          onClick={async () => {
            setCopied(false);setCopyError(false)
            try { await navigator.clipboard.writeText(token.text);setCopied(true);window.setTimeout(() => setCopied(false), 1500) }
            catch { setCopyError(true) }
          }}
        >
          <Icon className={copied ? 'copied' : ''} name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      {copyError&&<span role="status">复制失败，请选择代码手动复制</span>}
      <pre ref={pre} className={pending ? 'growing' : undefined}>
        <code>
          {body}
          {caret}
        </code>
      </pre>
    </div>
  )
}

/** 围栏的收尾那一拍：``` 已经落下，代码块可以按成品对待（高亮、复制）。 */
const FENCE_CLOSED = /```[ \t]*\r?\n?$/

/**
 * 流式中还在长高的块关进限高的盒子、内部贴底：生长发生在盒子内部，页面上正在读的那行
 * 不被一行一行顶走（Streamdown 给表格、CodePilot 给代码块各做过一次，我们两种都上）。
 * 块不再是尾块时 class 撤掉，盒子放开到完整高度——那一下是上方插入，交给当帧补偿。
 */
function useGrowPin<T extends HTMLElement>(growing: boolean, content: string) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (el && growing) el.scrollTop = el.scrollHeight
  }, [growing, content])
  return ref
}

function ListBlock({
  token,
  caret,
  tail,
}: {
  token: Tokens.List
  caret?: ReactNode
  tail?: boolean
}) {
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
                    <Inline tokens={(sub as Tokens.Text).tokens ?? []} tail={tail && lastItem} />
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

/**
 * 表格：顶栏一枚「复制为 Markdown」（取 token.raw，不从 DOM 反拼），下面套一层滚动盒。
 * 分隔行打全后它一次成形，之后一行一行长——流式中先关进限高的盒子里贴底生长，
 * 窄屏下横向溢出也只发生在表格里。
 */
function TableBlock({ token, caret }: { token: Tokens.Table; caret?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const pending = !!caret
  const box = useGrowPin<HTMLDivElement>(pending, token.raw)
  const align = (i: number): CSSProperties => ({
    textAlign:
      token.align[i] === 'center' ? 'center' : token.align[i] === 'right' ? 'right' : 'left',
  })
  return (
    <div className="md-tablecard">
      <div className="md-table-bar">
        <button
          type="button"
          disabled={pending}
          aria-label={pending ? '表格生成中' : copied ? '已复制表格' : '复制表格为 Markdown'}
          title={pending ? '生成中' : copied ? '已复制' : '复制表格为 Markdown'}
          onClick={() => {
            navigator.clipboard.writeText(token.raw).catch(() => {})
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
        >
          <Icon className={copied ? 'copied' : ''} name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      <div className={pending ? 'md-tablebox growing' : 'md-tablebox'} ref={box}>
        <table className="md-table">
          <thead>
            <tr>
              {token.header.map((cell, i) => (
                <th key={i} style={align(i)}>
                  <Inline tokens={cell.tokens} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {token.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} style={align(j)}>
                    <Inline tokens={cell.tokens} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 行内渲染：只认受控子集；text / escape / 行内 html 一律按纯文本输出（React 天然转义）。 */
function Inline({ tokens, tail }: { tokens: Token[]; tail?: boolean }) {
  return (
    <>
      {tokens.map((token, i) => {
        const atTail = tail && i === tokens.length - 1
        switch (token.type) {
          case 'strong':
            return (
              <strong key={i}>
                <Inline tokens={(token as Tokens.Strong).tokens} tail={tail} />
              </strong>
            )
          case 'em':
            return (
              <em key={i}>
                <Inline tokens={(token as Tokens.Em).tokens} tail={tail} />
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
              <a
                key={i}
                className="md-link"
                href={t.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Inline tokens={t.tokens} tail={tail} />
              </a>
            ) : (
              <Inline key={i} tokens={t.tokens} tail={tail} />
            )
          }
          case 'del':
            return (
              <del key={i}>
                <Inline tokens={(token as Tokens.Del).tokens} tail={tail} />
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
            if (t.tokens?.length) return <Inline key={i} tokens={t.tokens} tail={tail} />
            return atTail ? (
              <Chars key={i} text={t.text} />
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
 * 尾拍刚落下、正文还没跟到的标记：成对开标记（`先看**`、`写` + 一个反引号）与空子弹行
 * （`…门外。\n-`）。remend 只补「后面已有内容」的成对语法，光有开标记时它原样留着，于是光标前
 * 闪一下 `**` / 反引号、下一拍正文到了又被吃掉（实测 8 条 mock 回复 467 帧里 6 帧）；列表的
 * `-` 一落、字还没到时，remend 会在它后面补一个零宽空格防 setext 误判，marked 于是报出一条
 * 「末项为空」的列表——整条不空，按块判「只有标记」判不到它，画出来是一枚没有正文的子弹
 * （逐字扫一条两段式回复 268 拍扫出 11 个）。学生按下「停止」正好停在这两拍上时，它会永久
 * 留在会话记录里（实测三次停止一次）。交给 remend 之前削掉，正文到达那一拍原样接上——
 * 顺序不能反过来：先补再削会把 remend 刚补上的那个闭标记（`写`rst_n` 的收尾反引号）当成尾标记吃掉。
 * `_` 不在成对标记内——`rst_n` 这类标识符中间就有它，削一下会闪掉真实字符而不是标记。
 * 代码围栏里不削：那里的 `*` / `~` / `-` 是代码本身（未闭合的 ``` 由 CodeBlock 自己收尾）。
 */
function stripTailOpener(text: string): string {
  if (isWithinCodeBlock(text, text.length - 1)) return text
  return text
    .replace(/(?:^|\n)(?:(?:[*+-]|\d+[.)])[ \t]*(?:\n|$))+$/, '')
    .replace(/[*~`]{1,3}$/, '')
}

/**
 * 流式尾段逐字淡入：每个字挂载时各自淡一次（240ms 透明度），屏上留下约六字的软尾。
 * 键取字在 token 内的下标——token 只在末尾变长，已上屏的字不重挂载，因此不重播动画。
 */
function Chars({ text }: { text: string }) {
  return (
    <>
      {[...text].map((ch, i) => (
        <span className="turn-ch" key={i}>
          {ch}
        </span>
      ))}
    </>
  )
}

/**
 * Verilog/SystemVerilog 迷你高亮：单趟词法扫描，直接输出 React span，不引高亮库。
 * 课程代码几乎只有这一种语言；流式中途也安全——未闭合注释 / 字符串按到文末处理。
 */
const VERILOG_LANGS = new Set(['verilog', 'systemverilog', 'sv', 'v'])

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
