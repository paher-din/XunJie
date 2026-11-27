import type { SVGProps } from 'react'
import master from '../assets/brand/xunjie-logo/master.json'
import './logo.css'

export type LogoFormat = 'mark' | 'horizontal' | 'stacked'
export type LogoTone = 'color' | 'mono' | 'reverse'
export type XunjieLogoProps = Omit<SVGProps<SVGSVGElement>, 'format'> & {
  format?: LogoFormat
  tone?: LogoTone
  label?: string
}

/** Approved C artwork. Product instances and the asset library share the same master. */
export function XunjieLogo({ format = 'mark', tone = 'color', label, className = '', ...props }: XunjieLogoProps) {
  const layout = master.formats[format]
  const textColor = tone === 'reverse' ? '#ffffff' : 'currentColor'
  const colors = tone === 'color' ? [master.palette.purple, master.palette.mint] : [textColor, textColor]
  const mark = <g transform={master.transform}>{master.paths.map((d, i) => <path key={i} d={d} fill={colors[i]} />)}</g>
  const combination = format === 'mark' ? null : master.formats[format]
  const top = Math.max(...master.lettering.glyphs.map(g => g.bounds[3]))
  let cursor = 0

  return (
    <svg
      {...props}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      className={`xunjie-logo ${className}`.trim()}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {combination ? <>
        <g transform={`translate(${combination.mark.x} ${combination.mark.y}) scale(${combination.mark.size / 96})`}>{mark}</g>
        <g fill={textColor} transform={`translate(${combination.wordmark.x} ${combination.wordmark.y + top * combination.wordmark.size / master.lettering.units}) scale(${combination.wordmark.size / master.lettering.units} ${-combination.wordmark.size / master.lettering.units})`}>
          {master.lettering.glyphs.map(g => {
            const x = cursor
            cursor += g.advance + master.lettering.units * .02
            return <path key={g.char} d={g.path} transform={`translate(${x} 0)`} />
          })}
        </g>
      </> : mark}
    </svg>
  )
}

/** 独立的「循阶」字标，复用母版转曲路径；用于需要在字标下加副标题的组合。 */
export function XunjieWordmark({ label, className = '', ...props }: Omit<SVGProps<SVGSVGElement>, 'children'> & { label?: string }) {
  const units = master.lettering.units
  let cursor = 0
  const placed = master.lettering.glyphs.map(glyph => {
    const x = cursor
    cursor += glyph.advance + units * .02
    return { ...glyph, x }
  })
  const left = Math.min(...placed.map(g => g.x + g.bounds[0]))
  const right = Math.max(...placed.map(g => g.x + g.bounds[2]))
  const bottom = Math.min(...placed.map(g => g.bounds[1]))
  const top = Math.max(...placed.map(g => g.bounds[3]))
  // 字形路径是 y 向上的坐标，渲染时翻转并平移到 0…923；viewBox 必须按翻转后的墨迹裁。
  const pad = 40
  const width = right - left + pad * 2
  const height = top - bottom + pad * 2
  return (
    <svg
      {...props}
      viewBox={`${left - pad} ${-pad} ${width} ${height}`}
      width={width}
      height={height}
      className={`xunjie-wordmark ${className}`.trim()}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g fill="currentColor" transform={`translate(0 ${top}) scale(1 -1)`}>
        {placed.map(g => <path key={g.char} d={g.path} transform={`translate(${g.x} 0)`} />)}
      </g>
    </svg>
  )
}
