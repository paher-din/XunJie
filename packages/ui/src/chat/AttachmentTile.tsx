import { useRef, useState } from 'react'
import { Icon, type IconName } from '../icons'

export type PromptAttachmentKind =
  | 'image'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'code'
  | 'video'

export interface PromptAttachment {
  id: string
  name: string
  /** 字节数。 */
  size: number
  /** 瓦片形态：图片显示缩略图，其余显示对应插件图标 + 文件名。 */
  kind: PromptAttachmentKind
  /** 图片缩略图的 object URL，仅 kind === 'image'。 */
  src?: string
  /** 0–100 表示上传中（队列动画驱动）；undefined 表示已落位。 */
  progress?: number
  file?:File
}

/** 瓦片移除瞬间的视口矩形：退场期瓦片固定在这块位置上播完动效。 */
export type TileRect = { left: number; top: number; width: number; height: number }

const KIND_ICONS: Record<PromptAttachmentKind, IconName> = {
  document: 'file-text', spreadsheet: 'file-spreadsheet', presentation: 'file-presentation',
  code: 'file-code', video: 'file-video-camera', image: 'file-image',
}

/** 瓦片描边环路径：56×56 圆角方形（r=11），自顶边中点顺时针。 */
const RING_PATH = [
  'M 28 1',
  'H 44',
  'A 11 11 0 0 1 55 12',
  'V 44',
  'A 11 11 0 0 1 44 55',
  'H 12',
  'A 11 11 0 0 1 1 44',
  'V 12',
  'A 11 11 0 0 1 12 1',
  'Z',
].join(' ')

/** 单个附件瓦片（56px）：图片缩略图或插件图标 + 文件名，上传时画环、跳百分比。 */
export interface AttachmentTileProps {
  attachment: PromptAttachment
  /** 已移除、退场中：瓦片固定在移除瞬间的视口矩形上播完动效（leaving 期间 CSS 给它 position: fixed） */
  leavingRect?: TileRect
  onRemove: (rect: TileRect) => void
}

export function AttachmentTile({
  attachment,
  leavingRect,
  onRemove,
}: AttachmentTileProps) {
  const tileRef = useRef<HTMLDivElement>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const progress = attachment.progress
  const uploading = progress !== undefined
  const src = attachment.kind === 'image' && !imageFailed ? attachment.src : undefined
  const icon = KIND_ICONS[attachment.kind]
  // pathLength=100：dash 数值即百分比；落位时补到 102（整圈），随透明度一起淡出
  const dash = uploading ? (progress >= 100 ? 102 : progress) : 102
  const className = [
    'prompt-tile',
    uploading ? 'uploading' : '',
    src ? 'image' : '',
    leavingRect ? 'leaving' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={tileRef}
      className={className}
      title={attachment.name}
      style={
        leavingRect
          ? {
              left: leavingRect.left,
              top: leavingRect.top,
              width: leavingRect.width,
              height: leavingRect.height,
            }
          : undefined
      }
    >
      {src ? (
        <img className="pt-img" src={src} alt={attachment.name} onError={() => setImageFailed(true)} />
      ) : (
        <div className="pt-body">
          <Icon className="pt-icon" name={icon} size={24} />
          <span className="pt-name">{attachment.name}</span>
        </div>
      )}
      <svg className="pt-ring" viewBox="0 0 56 56" aria-hidden="true">
        <path
          d={RING_PATH}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${dash} 200`}
        />
      </svg>
      <span className="pt-pct" aria-hidden="true">
        {uploading ? progress : 100}%
      </span>
      <button
        type="button"
        className="pt-dismiss"
        aria-label={'移除附件 ' + attachment.name}
        onClick={() => {
          const el = tileRef.current
          if (!el) return
          const r = el.getBoundingClientRect()
          // 尺寸用 offsetWidth/Height：避开入场 scale(0.8) 期间量到被缩小的宽高
          onRemove({ left: r.left, top: r.top, width: el.offsetWidth, height: el.offsetHeight })
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
