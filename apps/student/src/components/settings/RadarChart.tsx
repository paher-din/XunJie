import { useId } from 'react'

/**
 * 能力雷达图（SVG）：网格用 chart-neut-1 描线，数据用 chart-blue-3 填充 + -4 描边，
 * 色值取自 DESIGN.md 图表用色五档。 dims 顺序即渲染顺序（从顶部顺时针）。
 */
export function RadarChart({ dims, size = 264 }: { dims: Array<{ dim: string; value: number }>; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 34 // 留出标签空间
  const n = dims.length
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2
  const point = (i: number, ratio: number) => ({
    x: cx + radius * ratio * Math.cos(angle(i)),
    y: cy + radius * ratio * Math.sin(angle(i)),
  })
  const ring = (ratio: number) =>
    dims.map((_, i) => {
      const p = point(i, ratio)
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`
    }).join(' ')
  const dataPoints = dims.map((d, i) => point(i, Math.max(0.08, d.value / 100)))
  const dataPoly = dataPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <svg
      className="st-radar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={'能力雷达图：' + dims.map((d) => `${d.dim} ${d.value}`).join('，')}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.20" />
          <stop offset="100%" style={{ stopColor: 'var(--accent)' }} stopOpacity="0.06" />
        </linearGradient>
      </defs>
      {[1 / 3, 2 / 3, 1].map((r) => (
        <polygon
          key={r}
          points={ring(r)}
          fill="none"
          style={{ stroke: 'var(--chart-neut-1)' }}
          strokeWidth="1"
        />
      ))}
      {dims.map((_, i) => {
        const p = point(i, 1)
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={p.x}
            y2={p.y}
            style={{ stroke: 'var(--chart-neut-1)' }}
            strokeWidth="1"
          />
        )
      })}
      <polygon
        points={dataPoly}
        fill={`url(#${id}-fill)`}
        style={{ stroke: 'var(--accent)' }}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {dataPoints.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          style={{ fill: 'var(--paper)', stroke: 'var(--accent-deep)' }}
          strokeWidth="1.5"
        />
      ))}
      {dims.map((d, i) => {
        const p = point(i, 1.17)
        return (
          <text
            key={d.dim}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="st-radar-label"
          >
            {d.dim}
          </text>
        )
      })}
    </svg>
  )
}
