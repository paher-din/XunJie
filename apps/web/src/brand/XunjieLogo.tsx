import type { SVGProps } from 'react'
import master from '../../public/brand/xunjie-logo/master.json'
import './logo.css'

type LogoFormat = 'mark' | 'horizontal' | 'stacked'
type LogoTone = 'color' | 'mono' | 'reverse'
type Props = Omit<SVGProps<SVGSVGElement>, 'format'> & {
  format?: LogoFormat
  tone?: LogoTone
  label?: string
}

/** Approved C artwork. Product instances and the asset library share the same master. */
export function XunjieLogo({ format = 'mark', tone = 'color', label, className = '', ...props }: Props) {
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
