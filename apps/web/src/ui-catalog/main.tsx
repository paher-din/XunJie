import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '@xunjie/ui/styles.css'
import { Icon, IconText } from '@xunjie/ui/icons'
import { Toaster } from '@xunjie/ui/feedback'
import { catalog, findSelection, selectionPath, type CatalogSelection } from './registry'
import type { CatalogEntry } from './types'
import './catalog.css'

type Theme = 'light' | 'dark'

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return hash
}

function useTheme(initial: Theme) {
  const [theme, setTheme] = useState(initial)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])
  return [theme, setTheme] as const
}

function matches(entry: CatalogEntry, search: string) {
  const text = [entry.id, entry.name, entry.description, entry.importPath, entry.source, ...entry.props, ...(entry.searchTerms ?? []),
    ...entry.states.flatMap(state => [state.id, state.name, state.description ?? ''])].join(' ').toLowerCase()
  return search.trim().toLowerCase().split(/\s+/).every(term => text.includes(term))
}

function Preview({ selection }: { selection: CatalogSelection }) {
  const Component = selection.state.component
  return <div className="catalog-preview-root" data-catalog-preview={`${selection.group.id}/${selection.entry.id}/${selection.state.id}`}>
    <div className="catalog-preview-stage"><Component /></div>
    {selection.entry.name !== 'Toaster' && <Toaster />}
  </div>
}

function PreviewFrame({ selection, theme }: { selection: CatalogSelection; theme: Theme }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const path = selectionPath(selection.group, selection.entry, selection.state)
  const src = `?view=preview&theme=${theme}${path}`
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollLeft = selection.state.initialScroll === 'end' ? element.scrollWidth : 0
  }, [path, selection.state.initialScroll])
  return <>
    <div className="catalog-frame-scroll" ref={scrollRef}>
      <iframe className={selection.state.viewport === 'wide' ? 'catalog-frame wide' : 'catalog-frame'}
        title={`${selection.entry.name}：${selection.state.name}`} src={src} style={selection.state.height ? { height: selection.state.height } : undefined} />
    </div>
    {selection.state.viewport === 'wide' && <p className="catalog-frame-note">此状态使用 1200px 桌面视口，可横向滚动查看完整画面。</p>}
  </>
}

function MissingSelection() {
  const firstGroup = catalog[0]
  const firstEntry = firstGroup.entries[0]
  return <div className="catalog-missing"><h1>找不到这个示例</h1><p>检查链接中的分组、组件和状态 ID。</p>
    <a href={selectionPath(firstGroup, firstEntry, firstEntry.states[0])}>返回组件目录</a></div>
}

function CatalogApp() {
  const hash = useHash()
  const selection = findSelection(hash)
  const [theme, setTheme] = useTheme('light')
  const [search, setSearch] = useState('')
  const groups = catalog.map(group => ({ ...group, entries: group.entries.filter(entry => matches(entry, search)) }))
  const resultCount = groups.reduce((count, group) => count + group.entries.length, 0)
  return <div className="catalog-app">
    <aside className="catalog-sidebar">
      <a className="catalog-brand" href="./ui-catalog.html"><span>循阶</span><strong>组件目录</strong></a>
      <label className="catalog-search"><Icon name="minimalistic-magnifier" size={16} /><span className="catalog-visually-hidden">搜索组件</span>
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索组件、状态、属性" /></label>
      <nav aria-label="组件分组" className="catalog-nav">
        {groups.map(group => group.entries.length > 0 && <section key={group.id}><h2>{group.name}</h2>
          {group.entries.map(entry => <a key={entry.id} href={selectionPath(group, entry, entry.states[0])}
            className={selection?.group.id === group.id && selection.entry.id === entry.id ? 'active' : undefined}
            aria-current={selection?.group.id === group.id && selection.entry.id === entry.id ? 'page' : undefined}>
            <span>{entry.name}</span><span>{entry.states.length}</span></a>)}
        </section>)}
        {resultCount === 0 && <p className="catalog-empty">没有找到匹配的示例。</p>}
      </nav>
      <div className="catalog-sidebar-footer">仅收录已有示例的正式包组件</div>
    </aside>
    <main className="catalog-main">
      <div className="catalog-topbar"><span>开发验收</span><button type="button" className="catalog-theme" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
        <IconText name={theme === 'light' ? 'moon' : 'sun'}>{theme === 'light' ? '深色' : '浅色'}</IconText></button></div>
      {selection ? <div className="catalog-content">
        <header className="catalog-heading"><div><div className="catalog-breadcrumb">{selection.group.name} <span>/</span> {selection.entry.name}</div>
          <h1>{selection.entry.name}</h1><p>{selection.entry.description}</p></div>
          <a className="catalog-open" href={`?view=preview&theme=${theme}${selectionPath(selection.group, selection.entry, selection.state)}`} target="_blank" rel="noreferrer">独立打开 <Icon name="alt-arrow-right" size={15} /></a>
        </header>
        <section className="catalog-preview-section" aria-label="组件预览">
          <div className="catalog-state-bar"><span>示例状态</span><div className="catalog-state-list">{selection.entry.states.map(state => <a key={state.id}
            className={state.id === selection.state.id ? 'active' : undefined} aria-current={state.id === selection.state.id ? 'true' : undefined}
            href={selectionPath(selection.group, selection.entry, state)}>{state.name}</a>)}</div></div>
          <PreviewFrame selection={selection} theme={theme} />
          {selection.state.description && <p className="catalog-frame-note">{selection.state.description}</p>}
        </section>
        <section className="catalog-details" aria-label="组件接入信息"><div><h2>使用入口</h2><code>{selection.entry.importPath}</code>
          <h2>组件源码</h2><code>{selection.entry.source}</code><h2>示例源码</h2><code>{selection.entry.exampleSource}</code></div>
          <div><h2>主要属性</h2><ul>{selection.entry.props.map(prop => <li key={prop}><code>{prop}</code></li>)}</ul>
            <h2>依赖与接入</h2><ul><li><code>@xunjie/ui/styles.css</code></li>{selection.entry.dependencies.map(item => <li key={item}>{item}</li>)}</ul></div></section>
      </div> : <MissingSelection />}
    </main>
  </div>
}

function PreviewApp() {
  const hash = useHash()
  const selection = findSelection(hash)
  const theme: Theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
  useTheme(theme)
  return selection ? <Preview selection={selection} /> : <MissingSelection />
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing catalog root')
const appRoot: Root = import.meta.hot?.data.root ?? createRoot(root)
if (import.meta.hot) import.meta.hot.data.root = appRoot
appRoot.render(new URLSearchParams(window.location.search).get('view') === 'preview' ? <PreviewApp /> : <CatalogApp />)
