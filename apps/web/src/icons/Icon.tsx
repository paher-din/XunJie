import { useId, type ReactNode, type SVGProps } from 'react'
import { iconCatalog, type IconName, type IconTone, type IconVariant } from './catalog'

const rawAssets = import.meta.glob<string>('./svg/*.svg', { query: '?raw', import: 'default', eager: true })

export const ICON_COLORS = {
  neutral: 'currentColor', blue: '#3268ca', green: '#25805c', orange: '#bc6424',
  violet: '#7752ba', rose: '#b64e79', teal: '#197f90', amber: '#a87519', emoji: 'currentColor',
} as const

/** 只读取随仓库提交的 SVG；没有远程请求，也不接受用户提供的 SVG 字符串。 */
export function getIconSvg(name: IconName, variant?: IconVariant): string {
  const entry = iconCatalog[name]
  const files: Partial<Record<IconVariant, string>> = entry.files
  const file = files[variant ?? entry.variant] ?? files[entry.variant]
  const svg = rawAssets['./svg/' + file]
  if (!svg) throw new Error(`Missing icon asset: ${name}`)
  return svg
}

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'children' | 'dangerouslySetInnerHTML'> {
  name: IconName
  size?: number
  tone?: IconTone
  variant?: IconVariant
  /** 有相邻文字或按钮 aria-label 时不传；独立有意义的图形才提供标签。 */
  label?: string
}

export function Icon({ name, size = 16, tone, variant, label, className = '', ...props }: IconProps) {
  const instance = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const svg = getIconSvg(name, variant)
  const root = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/)!
  const viewBox = root[1].match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 24 24'
  const attrs = root[1].replace(/\s*(?:xmlns|viewBox|width|height|aria-hidden)="[^"]*"/g, '')
  // 保留自绘 SVG 根节点的笔触；每次实例化重写 defs 引用，避免重复实例互相串色。
  let body = `<g${attrs}>${root[2]}</g>`
  const ids = Array.from(body.matchAll(/\bid="([^"]+)"/g), (m) => m[1])
  for (const id of ids) {
    body = body.replaceAll(`id="${id}"`, `id="${instance}-${id}"`)
      .replaceAll(`url(#${id})`, `url(#${instance}-${id})`)
      .replaceAll(`href="#${id}"`, `href="#${instance}-${id}"`)
  }
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      className={`ui-icon icon-tone-${tone ?? iconCatalog[name].tone} ${className}`.trim()}
      data-icon={name}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: body }}
    />
  )
}


interface IconTextProps extends Pick<IconProps, 'name' | 'size' | 'tone' | 'variant'> {
  children: ReactNode
  position?: 'start' | 'end'
  className?: string
}

/** 图标与文字共用居中行，避免字号 / CJK 字体改变内联 SVG 的基线。 */
export function IconText({ children, position = 'start', className = '', size, ...icon }: IconTextProps) {
  const iconNode = <Icon {...icon} size={size} className={size === undefined ? 'icon-text-auto-size' : undefined} />
  return (
    <span className={`icon-text ${className}`.trim()}>
      {position === 'start' && iconNode}
      <span className="icon-text-label">{children}</span>
      {position === 'end' && iconNode}
    </span>
  )
}
