import { useState } from 'react'
import { Icon, IconText, iconCatalog, type IconName, type IconVariant } from '@xunjie/ui/icons'
import type { CatalogEntry } from '../types'

function IconGallery({ allVariants }: { allVariants: boolean }) {
  const [search, setSearch] = useState('')
  const names = Object.keys(iconCatalog) as IconName[]
  const items = names.flatMap(name => {
    const variants = allVariants ? Object.keys(iconCatalog[name].files) as IconVariant[] : [undefined]
    return variants.map(variant => ({ name, variant }))
  }).filter(({ name, variant }) => `${name} ${iconCatalog[name].label} ${variant ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="demo-icon-gallery"><div className="demo-icon-toolbar"><label>筛选图标
    <input value={search} onChange={event => setSearch(event.target.value)} placeholder="名称、用途或变体" /></label>
    <span>{items.length} 项</span></div>
    <div className="demo-icon-grid">{items.map(({ name, variant }) => <div className="demo-icon-cell" key={`${name}-${variant ?? 'default'}`}>
      <Icon name={name} variant={variant} size={24} /><span>{name}</span><small>{variant ?? iconCatalog[name].label}</small>
    </div>)}</div>
    {items.length === 0 && <p className="demo-icon-empty">没有匹配的图标。</p>}
  </div>
}
function IconCatalog() { return <IconGallery allVariants={false} /> }
function IconVariants() { return <IconGallery allVariants /> }
function IconTones() {
  return <div className="demo-row">{(['neutral', 'blue', 'green', 'orange', 'violet', 'rose', 'teal', 'amber'] as const).map(tone =>
    <div className="demo-icon-tone" key={tone}><Icon name="star" tone={tone} size={24} label={`${tone} 星形图标`} /><span>{tone}</span></div>)}</div>
}
function IconTextPositions() {
  return <div className="demo-stack"><IconText name="home-2">图标在前</IconText><IconText name="alt-arrow-right" position="end">图标在后</IconText><IconText name="check-circle" size={20} tone="green">指定尺寸与颜色</IconText></div>
}

const source = 'apps/web/src/ui-catalog/examples/icons.tsx'
export const iconEntries: CatalogEntry[] = [
  { id: 'icon', name: 'Icon', description: '正式图标目录中的 SVG，支持已登记的变体与语义色。', importPath: '@xunjie/ui/icons', source: 'packages/ui/src/icons/Icon.tsx', exampleSource: source, props: ['name: IconName', 'size?, tone?, variant?, label?', '原生 SVG 属性'], dependencies: ['图形与名称由同包 iconCatalog 提供'], searchTerms: Object.entries(iconCatalog).flatMap(([name, item]) => [name, item.label, ...Object.keys(item.files)]), states: [
    { id: 'catalog', name: '全部图标', component: IconCatalog }, { id: 'variants', name: '全部登记变体', component: IconVariants }, { id: 'tones', name: '语义色', component: IconTones },
  ] },
  { id: 'icon-text', name: 'IconText', description: '图标与文字的对齐组合。', importPath: '@xunjie/ui/icons', source: 'packages/ui/src/icons/Icon.tsx', exampleSource: source, props: ['name, children', 'position?: start | end', 'size?, tone?, variant?'], dependencies: [], states: [{ id: 'positions', name: '前置 / 后置', component: IconTextPositions }] },
]
