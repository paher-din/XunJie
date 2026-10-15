import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'

/**
 * 正文受控子集渲染成什么：结构、类名，以及「不信任输入」那几条兜底。
 * 走 SSR 静态渲染（node 环境，不引 jsdom）——只断言落进 DOM 的结构与文本；
 * 高亮配色 / 逐字淡入这类运行时观感由实屏复验（docs/agent-page-design.md 第 27 条）。
 */
const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('正文受控子集', () => {
  it('段落 / 加粗 / 行内代码 / 列表 / 引用 / 分隔线各归其类', () => {
    expect(html('**复位**与`rst_n`')).toContain('<strong>复位</strong>')
    expect(html('`rst_n`')).toContain('<code class="md-code">rst_n</code>')
    expect(html('- 一\n- 二')).toContain('<ul class="md-list"><li>一</li><li>二</li>')
    expect(html('1. 一\n2. 二')).toContain('<ol class="md-list">')
    expect(html('> 注')).toContain('<blockquote class="md-quote"><p>注</p>')
    expect(html('---')).toContain('<hr class="md-hr"')
  })

  it('代码块带语言标签，Verilog 走自写高亮，其他语言按纯文本', () => {
    const v = html('```verilog\nalways_ff @(posedge clk)\n```')
    expect(v).toContain('<span class="md-pre-lang">verilog</span>')
    expect(v).toContain('<span class="tok-k">always_ff</span>')
    expect(html('```python\nprint(1)\n```')).toContain('<pre><code>print(1)</code></pre>')
  })

  it('表格套圆角容器，表头与表体分列', () => {
    const t = html('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toContain('<div class="md-tablebox"><table class="md-table"><thead>')
    expect(t.match(/<td\b/g)).toHaveLength(2)
    expect(t.match(/<th\b/g)).toHaveLength(2)
  })

  it('消息内标题压到 h3–h4：不盖过页面自身的层级', () => {
    expect(html('# 一级')).toContain('<h3 class="md-h">一级')
    expect(html('## 二级')).toContain('<h4 class="md-h">二级')
    expect(html('##### 五级')).toContain('<h4 class="md-h">五级')
  })
})

describe('不信任输入兜底', () => {
  it('链接只放行 http / https / mailto，其余退回纯文本', () => {
    const ok = html('[文档](https://example.com/a?b=1)')
    expect(ok).toContain('<a class="md-link" href="https://example.com/a?b=1" target="_blank"')
    expect(ok).toContain('rel="noreferrer noopener"')
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x']) {
      const out = html(`[点我](${bad})`)
      expect(out).not.toContain('<a')
      expect(out).toContain('<p>点我</p>')
    }
  })

  it('原始 HTML 按纯文本兜底，图片只留 alt 文本', () => {
    const raw = html('<img src=x onerror=alert(1)>')
    expect(raw).not.toContain('<img')
    expect(raw).toContain('&lt;img src=x onerror=alert(1)&gt;')
    const img = html('![示意图](https://example.com/a.png)')
    expect(img).not.toContain('<img')
    expect(img).toContain('示意图')
  })
})

/** 代码块与表格是正文里最长的两种块：流式途中它们怎么长、什么时候算成品。 */
describe('流式中的长块（代码 / 表格）', () => {
  const live = (text: string) => renderToStaticMarkup(<Markdown text={text} live />)

  it('代码块还在写时先出纯文本，围栏一闭合就高亮', () => {
    const open = live('```verilog\nalways_ff @(posedge clk)')
    expect(open).toContain('<pre class="growing">')
    expect(open).toContain('always_ff')
    expect(open).not.toContain('tok-k')
    // 闭合那一拍：还是尾块（光标仍在），但已经是成品代码
    const closed = live('```verilog\nalways_ff @(posedge clk)\n```')
    expect(closed).toContain('<span class="tok-k">always_ff</span>')
  })

  it('表格流式中限高贴底、复制键先禁用；不再是尾块就放开', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const growing = live(doc)
    expect(growing).toContain('md-tablebox growing')
    expect(growing).toContain('aria-label="表格生成中"')
    const done = html(doc)
    expect(done).toContain('<div class="md-tablebox">')
    expect(done).toContain('aria-label="复制表格为 Markdown"')
  })

  it('数学 / mermaid 不在受控子集里，一律按纯文本兜底', () => {
    const math = html('能量 $E=mc^2$ 守恒')
    expect(math).toContain('$E=mc^2$')
    expect(math).not.toContain('katex')
    const mmd = html('```mermaid\ngraph TD; A-->B\n```')
    expect(mmd).toContain('<span class="md-pre-lang">mermaid</span>')
    expect(mmd).toContain('graph TD')
  })

  it('围栏正在收尾时，那一两拍先敲下的 ``` 不算代码内容', () => {
    const closing = live('```verilog\nwire a;\n``')
    expect(closing).toContain('wire a;')
    expect(closing).not.toContain('`')
  })
})

/**
 * 成对语法是「开标记先到、正文后到」：remend 只在正文已经跟上时才补齐，光有开标记的那一拍
 * 会原样留着，照原样上屏就是光标前闪一下 `**` / 反引号、下一拍又被吃掉。
 * 实测口径：8 条 mock 回复逐拍渲染，修前 467 帧里 6 帧漏标记，修后 0 帧。
 */
describe('流式尾拍不闪语法字符', () => {
  /** 尾段逐字淡入会把字拆进各自的 span，断言上屏文字要先脱标签。 */
  const live = (text: string) => renderToStaticMarkup(<Markdown text={text} live />)
  const shown = (text: string) => live(text).replace(/<[^>]*>/g, '')

  it('刚落下的开标记先不画', () => {
    expect(shown('先看**')).toBe('先看')
    expect(shown('写`')).toBe('写')
  })

  it('正文到达那一拍原样接上，已经写完的加粗不误伤', () => {
    expect(live('先看**同步')).toContain('<strong>')
    expect(shown('先看**同步')).toBe('先看同步')
    expect(shown('先看**同步**')).toBe('先看同步')
    expect(shown('先看**同步**，再看异步')).toBe('先看同步，再看异步')
  })

  it('标识符里的下划线不削：rst_n 的字要照常上屏', () => {
    expect(shown('标识符 rst_')).toBe('标识符 rst_')
    expect(shown('写`rst_')).toBe('写rst_')
  })

  it('落定态一个字不少', () => {
    expect(html('先看**同步**')).toContain('<strong>同步</strong>')
  })
})

/** 学生按「停止」或中途失败时，正文就是停在半路上的那一截：语法照样要自愈，但它是终态。 */
describe('被截断的回复（已停止 / 中途失败）', () => {
  const cut = (text: string) => renderToStaticMarkup(<Markdown text={text} truncated />)
  const shown = (text: string) => cut(text).replace(/<[^>]*>/g, '')

  it('半路的加粗按目标样式收，不留 **', () => {
    expect(cut('先看**同步')).toContain('<strong>同步</strong>')
    expect(shown('先看**')).toBe('先看')
    expect(shown('写`rst_n')).toBe('写rst_n')
  })

  it('没有光标、不逐字淡入：它不是还在流', () => {
    expect(cut('先看**同步')).not.toContain('turn-caret')
    expect(cut('先看**同步')).not.toContain('turn-ch')
  })

  it('没成形的表不藏起来——那是它全部内容了', () => {
    expect(shown('| 状态 | 任务')).toContain('| 状态 | 任务')
  })

  it('停在半路的空子弹不上屏', () => {
    expect(cut('甲\n\n- ')).not.toContain('<ul')
    expect(shown('甲\n\n- ')).toBe('甲')
  })
})

/** 概念讲解卡随正文画出：挂载时机与落点都要跟着已上屏的内容走，不能早半拍钉在正文末尾。 */
describe('消息内卡片在流式中的挂载时机', () => {
  const card = <div className="card-stub">卡片</div>
  const shown = (text: string, afterPara?: number) =>
    renderToStaticMarkup(<Markdown text={text} live insert={card} insertAfterPara={afterPara} />)

  it('依附的那一段还没讲完就不挂', () => {
    expect(shown('甲', 2)).not.toContain('card-stub')
    expect(shown('甲\n\n乙：\n\n- 一', 3)).not.toContain('card-stub')
  })

  it('讲到那一段就挂上，位置跟着落点规则（那段引出的列表一并带上）', () => {
    const out = shown('甲\n\n乙：\n\n- 一\n- 二', 2)
    expect(out).toContain('card-stub')
    expect(out.indexOf('</ul>')).toBeLessThan(out.indexOf('card-stub'))
  })

  it('卡片压在节标题前面时不越位：标题仍是下一节的开头', () => {
    const out = shown('甲\n\n乙：\n\n- 一\n- 二\n\n### 下一节\n\n丙', 2)
    expect(out.indexOf('card-stub')).toBeLessThan(out.indexOf('md-h'))
  })

  it('没写依附段号的卡片等正文讲完（落定那一拍才挂）', () => {
    expect(shown('甲\n\n乙')).not.toContain('card-stub')
    expect(renderToStaticMarkup(<Markdown text="甲\n\n乙" insert={card} />)).toContain('card-stub')
  })
})
