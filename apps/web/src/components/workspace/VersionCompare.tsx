import { VERSION_READ_ONLY_REASON, CompareDiff, CompareReadOnly } from './CompareText'
import type { VersionComparison, VersionFile, VersionRow } from '../../workspace/comparison'

/**
 * 05：只读版本比较视图（快照×快照、本机草稿×最近确认作品）。
 *
 * 它只渲染调用方算好的只读投影：不发请求、不写草稿或存储，也不改任何源数据。
 * 切换左右来源只把选择交回页面（`onSelect`），由页面重新投影后再传进来；这里不缓存、
 * 不自行合并两侧，也不把同名文件当作同一个实例——对齐与身份都在 `VersionComparison` 里。
 */

export interface VersionOption {
  id: string
  label: string
}

export interface VersionCompareProps {
  comparison: VersionComparison
  options: VersionOption[]
  leftId: string
  rightId: string
  onSelect: (side: 'left' | 'right', id: string) => void
  onReturn: () => void
}

export function VersionCompare({ comparison, options, leftId, rightId, onSelect, onReturn }: VersionCompareProps) {
  return (
    <div className="ws-compare" data-source={comparison.source}>
      {/* 每侧一个原生 select（直接选版本）加一个「换一版」按钮（一个 Tab 停靠点循环切换）：
          原生下拉在部分环境里不能只靠键盘改值，按钮保证纯键盘也能切换，切换只上报选择。 */}
      <div className="ws-compare-sources">
        <span className="ws-compare-side">
          <span className="ws-compare-side-label">左侧</span>
          <button type="button" className="ws-compare-cycle" aria-label="切换左侧来源"
            onClick={() => onSelect('left', cycleOption(options, leftId))}>换一版</button>
          <select aria-label="左侧来源" value={leftId} onChange={(event) => onSelect('left', event.target.value)}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </span>
        <span className="ws-compare-side">
          <span className="ws-compare-side-label">右侧</span>
          <button type="button" className="ws-compare-cycle" aria-label="切换右侧来源"
            onClick={() => onSelect('right', cycleOption(options, rightId))}>换一版</button>
          <select aria-label="右侧来源" value={rightId} onChange={(event) => onSelect('right', event.target.value)}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </span>
      </div>
      <p className="ws-compare-note">只读比较：这里对照两个版本的正文差异，不会修改你的作品。</p>
      <div className="ws-compare-files">
        {comparison.rows.map((row) => (
          <VersionRowView key={row.key} row={row} leftLabel={comparison.leftLabel} rightLabel={comparison.rightLabel} />
        ))}
      </div>
      <div className="ws-compare-actions">
        <button type="button" className="outline" onClick={onReturn}>
          返回编辑
        </button>
      </div>
    </div>
  )
}

/** 循环到下一个来源；只有一个来源时原地不动，不会把选择变成空。 */
function cycleOption(options: VersionOption[], current: string): string {
  const index = options.findIndex(option => option.id === current)
  return options[(index + 1 + options.length) % options.length]!.id
}

/** 一行 = 一个 fileId；两侧都有走 diff，只有一侧走只读正文并把缺的一侧说清楚。 */
function VersionRowView({ row, leftLabel, rightLabel }: { row: VersionRow; leftLabel: string; rightLabel: string }) {
  const present: VersionFile | null = row.left ?? row.right
  const missing: 'left' | 'right' = row.left === null ? 'left' : 'right'
  return (
    <section className="ws-compare-file" data-fileid={row.fileId} data-path={row.path}>
      <header className="ws-compare-file-head">
        <span className="ws-compare-file-path">{pathNote(row)}</span>
        <span className="ws-compare-file-id">实例 {row.fileId}</span>
        <span className="ws-compare-file-versions">{versionNote(row)}</span>
        {lifecycleNote(row) !== null && <span className="ws-compare-file-lifecycle">{lifecycleNote(row)}</span>}
      </header>
      {row.left && row.right ? (
        <div className="ws-compare-body">
          <p className="ws-compare-diff-legend">
            <span>左：{leftLabel}</span>
            <span>右：{rightLabel}</span>
          </p>
          <CompareDiff path={row.path} leftText={row.left.text} rightText={row.right.text}
            leftLabel={leftLabel} rightLabel={rightLabel} readOnlyReason={VERSION_READ_ONLY_REASON} />
        </div>
      ) : present ? (
        <div className="ws-compare-body" data-missing={missing}>
          <p className="ws-compare-missing">{missingNote(missing, missing === 'left' ? leftLabel : rightLabel)}</p>
          <CompareReadOnly path={present.path} text={present.text} readOnlyReason={VERSION_READ_ONLY_REASON}
            ariaLabel={`${missing === 'left' ? rightLabel : leftLabel} 正文 ${present.path}`} />
        </div>
      ) : null}
    </section>
  )
}

/** 同一 fileId 两侧路径不同时（例如文件改过路径）两侧路径都显示：路径不是身份。 */
function pathNote(row: VersionRow): string {
  if (row.left && row.right && row.left.path !== row.right.path) {
    return `左侧 ${row.left.path} · 右侧 ${row.right.path}`
  }
  return row.path
}

/** 版本读数：缺一侧时说明是哪一侧没有这个文件实例，不用「删除」「失败」这类结论。 */
function versionNote(row: VersionRow): string {
  return `${sideVersion('左侧', row.left)} · ${sideVersion('右侧', row.right)}`
}

/**
 * 回收状态：回收不是删除，实例仍在当前确认作品里，只是不再占用路径。
 * 只比「同一 fileId 两侧都有、正文还一样」，学生无法区分「没动过」和「被回收了」，所以单独写出来。
 */
function lifecycleNote(row: VersionRow): string | null {
  const marks: string[] = []
  if (row.left?.lifecycle === 'recycled') marks.push('左侧已回收')
  if (row.right?.lifecycle === 'recycled') marks.push('右侧已回收')
  return marks.length > 0 ? marks.join(' · ') : null
}

function sideVersion(side: string, file: VersionFile | null): string {
  if (file === null) return `${side}缺该文件`
  return file.documentVersion === null ? `${side}版本未知` : `${side} v${file.documentVersion}`
}

function missingNote(missing: 'left' | 'right', missingLabel: string): string {
  return `只有${missing === 'left' ? '右侧' : '左侧'}有这个文件实例（${missingLabel} 里没有）。`
}
