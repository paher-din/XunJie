import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import { PromptModelPicker, type PromptModelOption } from './PromptModelPicker'
export type { PromptModelOption } from './PromptModelPicker'
import { AttachmentTile, type PromptAttachment, type TileRect } from './AttachmentTile'

export interface PromptInputProps<Effort extends string = string> {
  value: string
  onChange: (value: string) => void
  onSend: () => void | Promise<void>
  canSend: boolean
  submitting?: boolean
  busy?: boolean
  onStop?: () => void
  autoFocus?: boolean
  attachments: readonly PromptAttachment[]
  /** 未接入附件的宿主可以移除入口和拖放行为。 */
  showAttachments?: boolean
  onAddFiles: (files: File[]) => void
  /** 退场动画完成后通知宿主移除；文件与 object URL 归宿主管理。 */
  onRemoveAttachment: (id: string) => void
  accept?: string
  attachmentTitle: string
  model: PromptModelOption
  models: readonly PromptModelOption[]
  onModelChange: (id: string) => void
  modelDisabled?: boolean
  effort: string
  efforts: readonly Effort[]
  onEffortChange: (modelId: string, effort: Effort) => void
  effortDisabled?: boolean
  showEffort?: boolean
  status?: { role: 'alert' | 'status'; text: string }
  /** 仅容纳上下文指示，不替代输入主体或模型菜单。容量事实由宿主提供。 */
  contextIndicator?: ReactNode
}

/** 完整受控输入 UI；不读取模型 store，不上传、读取文件或写入持久状态。 */
export function PromptInput<Effort extends string = string>({ value, onChange, onSend, canSend,
  submitting = false, busy = false, onStop, autoFocus, attachments, showAttachments = true, onAddFiles, onRemoveAttachment,
  accept, attachmentTitle, model, models, onModelChange, modelDisabled, effort, efforts,
  onEffortChange, effortDisabled, showEffort = true, status, contextIndicator }: PromptInputProps<Effort>) {
  const [leaving, setLeaving] = useState<Record<string, TileRect>>({})
  const [dragging, setDragging] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [effortClosing, setEffortClosing] = useState(false)
  /** 附件区内容实测高度（px）：容器高度过渡到这个值，长/缩才不是直接切换。 */
  const [attachHeight, setAttachHeight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const effortRef = useRef<HTMLDivElement>(null)
  const attachRowRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const effortCloseTimer = useRef<number | null>(null)
  const removeTimers = useRef<number[]>([])

  // 收起：标记 closing 并挂 140ms 定时器，播完退场动画再卸载
  const closeEffort = () => {
    if (!effortOpen || effortClosing) return
    setEffortClosing(true)
    effortCloseTimer.current = window.setTimeout(() => {
      setEffortOpen(false)
      setEffortClosing(false)
      effortCloseTimer.current = null
    }, 140)
  }
  // 打开：清掉进行中的收起定时器（退场动画中途再点 = 重新打开），
  // 并让另一枚按钮走退场动画收起
  const openEffort = () => {
    if (effortCloseTimer.current !== null) {
      clearTimeout(effortCloseTimer.current)
      effortCloseTimer.current = null
    }
    setEffortClosing(false)
    setEffortOpen(true)
    setModelOpen(false)
  }
  const toggleEffort = () => (effortOpen && !effortClosing ? closeEffort() : openEffort())

  useEffect(
    () => () => {
      if (effortCloseTimer.current !== null) clearTimeout(effortCloseTimer.current)
      removeTimers.current.forEach((t) => clearTimeout(t))
    },
    [],
  )

  // 点击选择器外部或按 Esc 收起模型 / 思考强度菜单
  useEffect(() => {
    if (!effortOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!effortRef.current?.contains(target)) closeEffort()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModelOpen(false)
        closeEffort()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [effortOpen, effortClosing])

  // 输入区自动增高，上限约 8 行。
  // 高度值写 inline style、变化由 CSS transition 播，所以不能沿用「直接置 0 再读 scrollHeight」：
  // 有过渡时置 0 不会立刻生效，scrollHeight 被当前 clientHeight 垫高，量回来还是旧高度（删内容就收不回去）。
  // 改法：量的时候临时关过渡 → 置 0 量出内容高 → 先还原成当前渲染高度（不闪）→ 恢复过渡再写目标值，
  // 于是这次高度变化会从旧高度平滑播到新高度，增和减都成立。
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const current = el.getBoundingClientRect().height
    el.style.transition = 'none'
    el.style.height = '0'
    const next = Math.min(el.scrollHeight, 200)
    el.style.height = current + 'px'
    void el.offsetHeight // 提交「无过渡 + 旧高度」，下面这次改动才会被过渡接住
    el.style.transition = ''
    el.style.height = next + 'px'
  }, [value])

  // 附件区：外层容器高度 = 内层内容实测高度，增减瓦片（含换行、窗口变窄重排）都过渡过去。
  // 用 ResizeObserver 而不是按瓦片数量算：内容高度由 flex-wrap 决定，量出来最稳。
  useLayoutEffect(() => {
    const row = attachRowRef.current
    if (!row) return
    const sync = () => setAttachHeight(row.offsetHeight)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  /** 移除：瓦片立刻转成 fixed 定在原位播 280ms 出场动效，腾出的空间当帧就开始收；280ms 后卸载并释放缩略图。 */
  const removeAttachment = (id: string, rect: TileRect) => {
    setLeaving((prev) => (prev[id] ? prev : { ...prev, [id]: rect }))
    const timer = window.setTimeout(() => {
      onRemoveAttachment(id)
      setLeaving((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }, 280)
    removeTimers.current.push(timer)
  }

  const submit = () => { if (canSend) void onSend() }
  const activeId = attachments.find(a => a.progress !== undefined)?.id ?? null
  const visible = attachments.filter(a => a.progress === undefined || a.id === activeId || leaving[a.id] !== undefined)
  const inFlowCount = visible.filter(a => leaving[a.id] === undefined).length
  useEffect(() => { if (autoFocus) textareaRef.current?.focus() }, [autoFocus])
  // 发送或宿主移除后丢弃对应退场标记；不持有附件资源或上传状态。
  useEffect(() => {
    setLeaving(previous => {
      const next = Object.fromEntries(Object.entries(previous).filter(([id]) => attachments.some(a => a.id === id)))
      return Object.keys(next).length === Object.keys(previous).length ? previous : next
    })
  }, [attachments])
  return (
    <form
      className={dragging ? 'prompt-input dragging' : 'prompt-input'}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragEnter={(e) => {
        e.preventDefault()
        if (!showAttachments) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        if (showAttachments) onAddFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {/* 附件区常挂载：高度在 0 与内容实测高度之间过渡（CSS transition），
          空时也占 0 高度，所以长/缩都是动画而不是挂载切换 */}
      <div
        className="prompt-attachments"
        style={{ height: inFlowCount > 0 ? attachHeight : 0 }}
      >
        <div className="prompt-attachments-row" ref={attachRowRef}>
          {visible.map((a) => (
            <AttachmentTile
              key={a.id}
              attachment={a}
              leavingRect={leaving[a.id]}
              onRemove={(rect) => removeAttachment(a.id, rect)}
            />
          ))}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        disabled={submitting}
        rows={1}
        aria-label="向 Agent 提问"
        placeholder="输入问题或探讨任务思路…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="prompt-toolbar">
        {showAttachments && <button
          type="button"
          className="prompt-attach"
          aria-label="添加附件"
          title={attachmentTitle}
          disabled={submitting}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="paperclip" size={16} />
        </button>}
        <div className="prompt-actions">
          {contextIndicator}
          {status && <span role={status.role}>{status.text}</span>}
          <PromptModelPicker model={model} models={models} onChange={onModelChange} disabled={modelDisabled}
            open={modelOpen} onOpenChange={value => { setModelOpen(value); if (value) closeEffort() }} />
          {showEffort && <div className="prompt-effort" ref={effortRef}>
            <button
              type="button"
              className={effortOpen ? 'prompt-model-btn open' : 'prompt-model-btn'}
              aria-label="切换思考强度"
              disabled={effortDisabled}
              aria-expanded={effortOpen}
              aria-haspopup="menu"
              onClick={() => toggleEffort()}
            >
              {/* key 驱动换强度时的内容切换微动效 */}
              <span className="prompt-model-swap" key={effort}>
                <Icon name="brain" size={16} className="prompt-effort-icon" />
                <span className="prompt-effort-label">{effort}</span>
              </span>
              <Icon name="alt-arrow-down" size={12} className="caret" />
            </button>
            {effortOpen && (
              <div
                className={
                  effortClosing ? 'prompt-model-menu effort closing' : 'prompt-model-menu effort'
                }
                role="menu"
              >
                <span className="mi-effort-title">思考强度</span>
                {efforts.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={level === effort}
                    className={level === effort ? 'mi-effort-option on' : 'mi-effort-option'}
                    onClick={() => {
                      onEffortChange(model.id, level)
                      closeEffort()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onEffortChange(model.id, level)
                        closeEffort()
                      }
                    }}
                  >
                    <span>{level}</span>
                    <span className="mi-effort-check">{level === effort && <Icon name="check" size={14} />}</span>
                  </button>
                ))}
              </div>
            )}
          </div>}
          {busy ? (
            <button
              type="button"
              className="prompt-send stop"
              aria-label="停止生成"
              title="停止生成"
              onClick={onStop}
            >
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button type="submit" className="prompt-send" aria-label="发送消息" disabled={!canSend}>
              <Icon name="arrow-up" size={20} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          if (showAttachments && e.target.files) onAddFiles(Array.from(e.target.files))
          e.target.value = ''
        }}
      />
    </form>
  )
}
