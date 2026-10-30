import { Icon } from '../../icons'
import { useEffect, useRef, useState } from 'react'
import { formatMessageTime } from '../../lib/chatTime'
import type {ChatImage} from '../../bridge/types'

/**
 * 一条学生消息：气泡 + 消息级操作（复制 / 编辑，已确认 2026-10-11 第 24 条）。
 * 编辑就地改写：气泡隐掉、原位换成输入区，保存后由父级截掉其后内容并按新文本重新生成
 * （与第 9 条重试同一条语义）。原文留在 DOM 里，消息导航导轨的摘要不跟着断。
 */
export function UserMessage({
  text,
  at,
  onEdit,
  busy,
  images,
}: {
  text: string
  images?:ChatImage[]
  /** 这条说出来的时刻；有就标在操作键左侧。 */
  at?: string
  /** 保存改写；不传则不给编辑键。 */
  onEdit?: (next: string) => void
  /** 回合生成中：这一问正在被回答，编辑键先禁用。 */
  busy?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [copied, setCopied] = useState(false)
  const [copyError,setCopyError]=useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  // 编辑区跟内容长，不出内层滚动条
  const grow = () => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  const save = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== text) onEdit?.(next)
  }

  useEffect(() => {
    if (!editing) return
    const el = fieldRef.current
    if (!el) return
    grow()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  return (
    <div className={'chat-message user' + (editing ? ' editing' : '')}>
      {!!images?.length&&<div className="chat-user-images">{images.map((image,index)=><a key={index} href={image.dataUrl} download={image.name} title={`下载图片：${image.name}`}><img src={image.dataUrl} alt={image.name} /></a>)}</div>}
      {text&&<div className="bubble">{text}</div>}
      {editing ? (
        <div className="user-edit">
          <textarea
            ref={fieldRef}
            className="user-edit-field"
            rows={1}
            aria-label="修改这条消息"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              grow()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              }
            }}
          />
          <div className="user-edit-btns">
            <button className="outline" onClick={() => setEditing(false)}>
              取消
            </button>
            <button className="primary" disabled={!draft.trim()} onClick={save}>
              发送
            </button>
          </div>
        </div>
      ) : (
        <div className="turn-actions">
          {/* 学生侧时间戳在操作键左边：先看到这条是何时说，再看到能对它做什么 */}
          {at && (
            <time className="turn-time" dateTime={at}>
              {formatMessageTime(at)}
            </time>
          )}
          <button
            aria-label={copied ? '已复制' : '复制这条消息'}
            title={copied ? '已复制' : '复制'}
            onClick={async () => {
              setCopied(false);setCopyError(false)
              try {await navigator.clipboard.writeText(text);setCopied(true);window.setTimeout(() => setCopied(false), 1500)}
              catch {setCopyError(true)}
            }}
          >
            <Icon className={copied ? 'copied' : ''} name={copied ? 'check' : 'copy'} size={16} />
          </button>
          {copyError&&<span role="status">复制失败，请选择正文手动复制</span>}
          {onEdit && (
            <button
              aria-label="编辑这条消息"
              title={busy ? '生成中不能改' : '编辑'}
              disabled={busy}
              onClick={() => {
                setDraft(text)
                setEditing(true)
              }}
            >
              <Icon name="pen" size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
