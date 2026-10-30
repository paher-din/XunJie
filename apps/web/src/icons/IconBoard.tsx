import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon, IconText, getIconSvg, iconCatalog, ICON_COLORS, type IconName, type IconVariant } from './index'
import './icon-board.css'

const names = Object.keys(iconCatalog) as IconName[]
const sources = [...new Set(names.map((name) => iconCatalog[name].source))]

/** 资源看板与产品直接共享 catalog / SVG / Icon；不维护第二份展示用图标。 */
export default function IconBoardPage() {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [size, setSize] = useState(24)
  const [dark, setDark] = useState(false)
  const [selected, setSelected] = useState<IconName>('learning-space')
  const [variant, setVariant] = useState<IconVariant | undefined>()
  const [feedback, setFeedback] = useState('')
  const entry = iconCatalog[selected]
  const variants = Object.keys(entry.files) as IconVariant[]
  const filtered = names.filter((name) => {
    const item = iconCatalog[name]
    const text = [name, item.label, item.source, ...item.usages.map((use) => use.label + use.group)].join(' ')
    return (!source || item.source === source) && text.toLowerCase().includes(query.trim().toLowerCase())
  })
  const code = `<Icon name="${selected}"${variant && variant !== entry.variant ? ` variant="${variant}"` : ''} size={${size}} />`

  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text)
      setFeedback(message)
    } catch {
      setFeedback('复制未成功，可从下方文本框手动复制。')
    }
  }

  function download() {
    const svg = getIconSvg(selected, variant)
    // 明确导出颜色；原始 SVG 保留 currentColor，组件内则由语义色控制。
    const color = ICON_COLORS[entry.tone] === 'currentColor' ? '#303846' : ICON_COLORS[entry.tone]
    const data = svg.replaceAll('currentColor', color)
    const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${selected}-${variant ?? entry.variant}.svg`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback('SVG 已下载；来源与许可见本卡下方。')
  }

  return (
    <main className={'icon-board' + (dark ? ' dark' : '')}>
      <header className="ib-header">
        <div><div className="ib-eyebrow">LEARNING SPACE / ICON LIBRARY</div><h1>图标资源看板</h1><p>已定稿 · 2026.10.10 · 页面与看板共用本地 SVG</p></div>
        <Link className="ib-home" to="/"><IconText name="arrow-left">返回应用</IconText></Link>
      </header>
      <section className="ib-summary" aria-label="资源概览">
        <div><strong>{names.length}</strong><span>可复用图形</span></div>
        <div><strong>{names.filter((n) => iconCatalog[n].source === '项目自绘' || iconCatalog[n].source === 'Solar 衍生').length}</strong><span>专属与补绘</span></div>
        <div><strong>{names.filter((n) => iconCatalog[n].source === 'OpenMoji').length}</strong><span>手绘 Emoji</span></div>
        <p>操作保持单色，内容类型使用语义色。图表、真实缩略图与动画 IP 保留各自的表达。</p>
      </section>
      <div className="ib-controls">
        <label className="ib-search"><Icon name="minimalistic-magnifier" /><input aria-label="搜索图标" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称、用途或页面…" /></label>
        <label>来源<select aria-label="筛选来源" value={source} onChange={(e) => setSource(e.target.value)}><option value="">全部来源</option>{sources.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>尺寸<select aria-label="图标尺寸" value={size} onChange={(e) => setSize(Number(e.target.value))}>{[16, 20, 24, 32].map((s) => <option key={s} value={s}>{s} px</option>)}</select></label>
        <button aria-pressed={dark} onClick={() => setDark((v) => !v)}><IconText name={dark ? 'moon' : 'lightbulb'}>{dark ? '深色底' : '浅色底'}</IconText></button>
      </div>
      <div className="ib-workspace">
        <section aria-label="图标列表"><div className="ib-result">{filtered.length} 个图标 <span>点击查看用法、下载与来源</span></div><div className="ib-grid">
          {filtered.map((name) => {
            const item = iconCatalog[name]
            return <button key={name} className={'ib-tile' + (selected === name ? ' selected' : '')} aria-pressed={selected === name} onClick={() => { setSelected(name); setVariant(undefined); setFeedback('') }}>
              <span className={'ib-preview' + (item.source === 'OpenMoji' ? ' emoji' : '')}><Icon name={name} size={size} /></span>
              <strong>{item.label}</strong><code>{name}</code><span className="ib-source">{item.source}</span>
            </button>
          })}
        </div>{!filtered.length && <p className="ib-empty">没有匹配图标，试试更短的关键词。</p>}</section>
        <aside className="ib-detail" aria-label="图标详情">
          <div className="ib-detail-art"><Icon name={selected} variant={variant} size={64} /></div>
          <h2>{entry.label}</h2><code>{selected}</code>
          <div className="ib-variants">{variants.map((v) => <button key={v} aria-pressed={(variant ?? entry.variant) === v} onClick={() => { setVariant(v); setFeedback('') }}>{v}</button>)}</div>
          <div className="ib-size-row">{[16, 20, 24, 32].map((s) => <span key={s}><Icon name={selected} variant={variant} size={s} /><small>{s}px</small></span>)}</div>
          <label className="ib-code-label">React 用法<textarea readOnly aria-label="React 图标用法" value={code} rows={3} /></label>
          <div className="ib-actions"><button onClick={() => void copy(code, '用法已复制')}><IconText name="copy">复制用法</IconText></button><button onClick={download}><IconText name="archive-down">下载 SVG</IconText></button></div>
          <button className="ib-copy-name" onClick={() => void copy(selected, '图标名称已复制')}>复制名称</button>
          <p role="status" className="ib-feedback">{feedback || '从 ../icons 导入 Icon 即可使用。'}</p>
          <dl><dt>来源</dt><dd>{entry.sourceUrl ? <a href={entry.sourceUrl} target="_blank" rel="noreferrer">{entry.source}</a> : entry.source}</dd><dt>作者</dt><dd>{entry.author}</dd><dt>许可</dt><dd>{entry.license}</dd><dt>修改</dt><dd>{entry.modified ? '演示文件：沿用 Solar 文件轮廓，补绘内部演示框' : '原始图形 / 项目自绘'}</dd></dl>
          <h3>评审用途</h3><ul>{entry.usages.map((use, i) => <li key={i}>{use.label}<small>{use.group} · {use.scope}</small></li>)}</ul>
        </aside>
      </div>
      <footer>资源目录：app/src/icons/ · Solar / 480 Design / CC BY 4.0 · OpenMoji / HfG Schwäbisch Gmünd / CC BY-SA 4.0 · 品牌图形沿用既有资源。</footer>
    </main>
  )
}
