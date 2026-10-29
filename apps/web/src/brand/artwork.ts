/** Mascot context types and independent Logo drafts. The mascot identity comes only from approved PNG sources. */
export type SproutExpression = 'idle' | 'curious' | 'thinking' | 'encouraging' | 'happy'
export type SproutTool = 'none' | 'glasses' | 'pencil' | 'pointer' | 'chalk'
export type SproutMotion = 'none' | 'idle' | 'think' | 'invite' | 'celebrate' | 'equip'
export type LogoVariant = 'branch' | 'path'

export interface VectorNode {
  tag: 'g' | 'defs' | 'clipPath' | 'path' | 'ellipse' | 'circle' | 'rect'
  attrs: Record<string, string | number>
  children?: VectorNode[]
}

const node = (tag: VectorNode['tag'], attrs: VectorNode['attrs'], children?: VectorNode[]): VectorNode => ({ tag, attrs, children })
const path = (d: string, fill: string, attrs: VectorNode['attrs'] = {}) => node('path', { d, fill, ...attrs })
const group = (className: string, children: VectorNode[], attrs: VectorNode['attrs'] = {}) => node('g', { className, ...attrs }, children)

export function logoArtwork(variant: LogoVariant = 'branch', tone: 'color' | 'mono' | 'reverse' = 'color'): VectorNode[] {
  const primary = tone === 'reverse' ? '#ffffff' : tone === 'mono' ? '#3f3b59' : '#7b83c5'
  const secondary = tone === 'color' ? '#9bc7b8' : primary
  if (variant === 'path') {
    return [
      group('logo-path', [
        path('M14 52 C7 46 9 30 21 25 C34 20 44 32 49 42 C41 47 22 60 14 52 Z', primary),
        path('M48 34 C45 21 51 9 64 7 C75 5 84 11 84 20 C83 33 69 41 58 41 C54 38 51 35 48 34 Z', secondary),
        path('M36 59 C47 53 52 49 57 43', 'none', { stroke: primary, strokeWidth: 8, strokeLinecap: 'round' }),
      ], { transform: 'translate(0 12)' }),
    ]
  }
  return [
    path('M45 70 C39 54 32 45 20 43 C11 41 4 33 6 24 C8 18 22 19 31 23 C45 29 48 46 48 58 Z', primary),
    path('M48 61 C45 40 51 20 67 11 C75 7 84 5 85 11 C88 28 77 43 65 49 C57 53 52 61 49 70 Z', secondary),
    path('M46 60 C48 67 49 73 47 82', 'none', { stroke: primary, strokeWidth: 7, strokeLinecap: 'round' }),
  ]
}

/** Scoped IDs prevent collisions when several SVGs coexist. */
export function scopedAttributes(attrs: VectorNode['attrs'], prefix: string): VectorNode['attrs'] {
  return Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, key === 'id' ? `${prefix}-${value}` : typeof value === 'string' ? value.replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`) : value]))
}

const xmlEscape = (value: string | number) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
export function vectorMarkup(nodes: VectorNode[], prefix = 'sprout'): string {
  return nodes.map(({tag, attrs, children}) => {
    const attributes = Object.entries(scopedAttributes(attrs, prefix)).map(([key,value]) => {
      const name = key === 'className' ? 'class' : key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      return ` ${name}="${xmlEscape(value)}"`
    }).join('')
    return `<${tag}${attributes}>${children ? vectorMarkup(children, prefix) : ''}</${tag}>`
  }).join('')
}

export function logoSvg(variant: LogoVariant = 'branch', tone: 'color' | 'mono' | 'reverse' = 'color'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">${vectorMarkup(logoArtwork(variant, tone))}</svg>`
}
