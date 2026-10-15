import { Icon, type IconName } from '../icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PREP_BUILD } from '../workspace/mode'
import { personalModelOptions, reasoningOptions, saveModelSettings, useModelSettings } from '../lib/modelSettings'
import { ContextRing } from './ContextRing'

/** 可选模型（Mock）：形态参考 MiMo 模型选择器，选择只影响展示，不接真实模型。 */
export const MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    note: '通用推理能力强，适合概念探究与复杂分析',
    icon: 'brand-deepseek' as const,
  },
  {
    id: 'mimo-v2.6-flash',
    name: 'MiMo V2.6 Flash',
    note: '响应低延迟，适合日常答疑与快速梳理',
    icon: 'brand-mimo' as const,
  },
]
/** 思考强度三档，按模型各自记忆。 */
const EFFORTS = ['低', '高', '最高'] as const
type Effort = (typeof EFFORTS)[number]
const DEFAULT_EFFORT: Effort = '高'
export const MODEL_KEY = 'agent.model'
const EFFORT_KEY = 'agent.model.effort'
/** 模型被外部切换（如失败卡的「换个模型」）时派发，让输入框按钮同步。 */
export const MODEL_CHANGE_EVENT = 'agent-model-change'

function readEfforts(): Record<string, Effort> {
  try {
    return JSON.parse(localStorage.getItem(EFFORT_KEY) ?? '{}') as Record<string, Effort>
  } catch {
    return {}
  }
}

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
type TileRect = { left: number; top: number; width: number; height: number }

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic']
const CODE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'py', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'v', 'vhd', 'sv', 'json', 'html', 'css']
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
const SHEET_EXTS = ['xls', 'xlsx', 'csv', 'numbers']
const SLIDE_EXTS = ['ppt', 'pptx', 'key']

function kindOf(file: File): PromptAttachmentKind {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.type.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image'
  if (SHEET_EXTS.includes(ext)) return 'spreadsheet'
  if (SLIDE_EXTS.includes(ext)) return 'presentation'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (CODE_EXTS.includes(ext)) return 'code'
  return 'document'
}

const KIND_ICONS: Record<PromptAttachmentKind, IconName> = {
  document: 'file-text', spreadsheet: 'file-spreadsheet', presentation: 'file-presentation',
  code: 'file-code', video: 'file-video-camera', image: 'file-image',
}

/** 模拟上传节奏（搬自 BoardUI Composer：单文件排队，逐个落位）。 */
const UPLOAD_DURATION = 1100
const UPLOAD_GAP = 240

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

interface PromptInputProps {
  value: string
  onChange: (value: string) => void
  onSend: (text: string, attachments: PromptAttachment[]) => void|boolean|Promise<void|boolean>
  autoFocus?: boolean
  /** 当前会话的上下文窗口已用 token 数（缺省 0），驱动模型按钮左侧的上下文环。 */
  contextTokens?: number
  /** 真实独立聊天不使用演示容量环；其他现有调用方保持原显示。 */
  showContextRing?: boolean
  /** 回合生成中：发送键变为停止键，输入保持可用（生成中再发送由父级排队）。 */
  busy?: boolean
  onStop?: () => void
}

/**
 * Agent 对话页输入框（布局参照 HeroUI Pro Prompt Input）：
 * 多行自动增高输入区 + 底部工具行（左附件、右发送）；
 * 支持点击添加与拖拽添加附件，拖入时显示虚线强调边框。
 * Enter 发送、Shift+Enter 换行；中文输入法组合输入期间不提交。
 * 附件瓦片动效搬自 BoardUI Composer Attachments：56px 瓦片（图片缩略图 / 插件图标 + 文件名），
 * 排队逐个「落位」——accent 描边环顺时针画进度、右上角 9px 百分比跳数，
 * 到 100% 后百分比模糊淡出、关闭按钮在同一位置模糊淡入。
 * 准备模式模拟附件进度；真实模式在显式发送时读取图片，随聊天命令保存并交给模型。
 * 高度动画（2026-10-10）：输入区换行与附件区增减瓦片引起的高度变化都走 CSS height 过渡
 * （0.24s / 0.3s，同一条弹簧曲线）——输入区高度由 JS 量 scrollHeight 写进 inline style，
 * 附件区外层容器高度取内层 flex 行的实测高度（ResizeObserver），空时为 0；
 * 移除瓦片时它立即脱流转 fixed 停在原位（TileRect）播 280ms 出场动效，空间当帧就开始收、与出场重叠；
 * 容器底部固定在工具行上沿，所以长高时是上缘抬起、内容从下缘「升起」，收缩时反向收回。
 * 发送键左侧为上下文环 + 两枚并列按钮（形态参考 MiMo / GLM 选择器）：上下文环（14px 进度圈，
 * 当前会话已用 / 30 万 token）悬停在圈上方弹出「上下文容量」卡片；模型按钮（图标 + 名称）向上
 * 弹出模型菜单（DeepSeek V4.1 Flash / MiMo V2.6 Flash 两个 Mock 模型）；思考强度按钮（脑图标 +
 * 档位，低 / 高 / 最高，默认高）独立弹出三档菜单，按模型各自记忆。两枚按钮共用同一套弹出 / 收起
 * 动效，打开一个会以退场动画收起另一个；模型与强度选择持久化 localStorage，仅作展示不接真实模型。
 */
export function PromptInput({
  value,
  onChange,
  onSend,
  autoFocus,
  contextTokens = 0,
  showContextRing = true,
  busy = false,
  onStop,
}: PromptInputProps) {
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const attachmentsRef=useRef(attachments)
  attachmentsRef.current=attachments
  useEffect(()=>()=>{attachmentsRef.current.forEach(attachment=>{if(attachment.src)URL.revokeObjectURL(attachment.src)})},[])
  const [reading,setReading]=useState(false)
  /** 退场动画进行中的附件：id → 移除瞬间的视口矩形。
      瓦片随即转成 position: fixed 停在那块位置上播 280ms 出场动效（脱离文档流），
      空间当帧就开始收，不用等出场播完——原地占位等 280ms 会被读成「先愣一下再收回」。 */
  const [leaving, setLeaving] = useState<Record<string, TileRect>>({})
  const [dragging, setDragging] = useState(false)
  const remoteModels = useModelSettings()
  const [modelError, setModelError] = useState('')
  const [prepModelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_KEY) ?? MODELS[0].id,
  )
  const [prepEfforts, setEfforts] = useState<Record<string, Effort>>(readEfforts)
  const modelId = PREP_BUILD ? prepModelId : remoteModels.data?.defaultModelId ?? ''
  const efforts = PREP_BUILD ? prepEfforts : remoteModels.data?.efforts ?? {}
  const availableEfforts = PREP_BUILD ? EFFORTS : reasoningOptions(remoteModels.data)
  const availableModels = PREP_BUILD ? MODELS : personalModelOptions(remoteModels.data)
  const [modelOpen, setModelOpen] = useState(false)
  /** 菜单退出动画进行中：保持挂载 140ms 播完再卸载。 */
  const [modelClosing, setModelClosing] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [effortClosing, setEffortClosing] = useState(false)
  /** 附件区内容实测高度（px）：容器高度过渡到这个值，长/缩才不是直接切换。 */
  const [attachHeight, setAttachHeight] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const effortRef = useRef<HTMLDivElement>(null)
  const attachRowRef = useRef<HTMLDivElement>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(0)
  const modelCloseTimer = useRef<number | null>(null)
  const effortCloseTimer = useRef<number | null>(null)
  const removeTimers = useRef<number[]>([])

  // 收起：标记 closing 并挂 140ms 定时器，播完退场动画再卸载
  const closeModel = () => {
    if (!modelOpen || modelClosing) return
    setModelClosing(true)
    modelCloseTimer.current = window.setTimeout(() => {
      setModelOpen(false)
      setModelClosing(false)
      modelCloseTimer.current = null
    }, 140)
  }
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
  const openModel = () => {
    if (modelCloseTimer.current !== null) {
      clearTimeout(modelCloseTimer.current)
      modelCloseTimer.current = null
    }
    setModelClosing(false)
    setModelOpen(true)
    closeEffort()
  }
  const openEffort = () => {
    if (effortCloseTimer.current !== null) {
      clearTimeout(effortCloseTimer.current)
      effortCloseTimer.current = null
    }
    setEffortClosing(false)
    setEffortOpen(true)
    closeModel()
  }
  const toggleModel = () => (modelOpen && !modelClosing ? closeModel() : openModel())
  const toggleEffort = () => (effortOpen && !effortClosing ? closeEffort() : openEffort())

  useEffect(
    () => () => {
      if (modelCloseTimer.current !== null) clearTimeout(modelCloseTimer.current)
      if (effortCloseTimer.current !== null) clearTimeout(effortCloseTimer.current)
      removeTimers.current.forEach((t) => clearTimeout(t))
    },
    [],
  )

  const canSend = !reading&&(value.trim().length > 0 || attachments.length > 0) && (PREP_BUILD || (!remoteModels.loading && !remoteModels.saving && !!remoteModels.data?.enabled && !!remoteModels.data.callsEnabled))
  // 设置页可选自定义供应商模型（agent.model = custom:<供应商>:<模型ID>），此处兜底展示原始 ID
  const model = availableModels.find((m) => m.id === modelId) ?? {
    id: modelId,
    name: modelId ? modelId.split(':').slice(2).join(':') || modelId : '未配置模型',
    note: '自定义模型',
    icon: 'model' as const,
  }
  const effort = availableEfforts.length ? efforts[model.id] ?? (PREP_BUILD ? DEFAULT_EFFORT : '默认') : '不支持配置'

  const pickModel = (id: string) => {
    if (PREP_BUILD) { setModelId(id); localStorage.setItem(MODEL_KEY, id); window.dispatchEvent(new Event(MODEL_CHANGE_EVENT)); return }
    setModelError('')
    void saveModelSettings({ defaultModelId: id }).catch(() => setModelError('模型切换未确认，请重试。'))
  }
  const pickEffort = (id: string, level: Effort) => {
    if (!PREP_BUILD) {
      setModelError('')
      void saveModelSettings({ efforts: { ...remoteModels.data?.efforts, [id]: level } }).catch(() => setModelError('思考强度保存未确认，请重试。'))
      return
    }
    const next = { ...prepEfforts, [id]: level }
    setEfforts(next); localStorage.setItem(EFFORT_KEY, JSON.stringify(next))
  }

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  // 模型被外部切换（如失败卡「换个模型」）时同步按钮展示
  useEffect(() => {
    const sync = () => setModelId(localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
    window.addEventListener(MODEL_CHANGE_EVENT, sync)
    return () => window.removeEventListener(MODEL_CHANGE_EVENT, sync)
  }, [])

  // 点击选择器外部或按 Esc 收起模型 / 思考强度菜单
  useEffect(() => {
    if (!modelOpen && !effortOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!modelRef.current?.contains(target)) closeModel()
      if (!effortRef.current?.contains(target)) closeEffort()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModel()
        closeEffort()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [modelOpen, modelClosing, effortOpen, effortClosing])

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

  const addFiles = (files: Iterable<File>) => {
    const added: PromptAttachment[] = Array.from(files, (f) => {
      const kind = kindOf(f)
      return {
        id: String(++nextId.current),
        name: f.name,
        size: f.size,
        kind,
        file:f,
        src: kind === 'image' ? URL.createObjectURL(f) : undefined,
        progress: PREP_BUILD?0:undefined, // 真实模式仅在显式发送时读取，不伪造上传进度。
      }
    })
    if (added.length) setAttachments((prev) => [...prev, ...added])
  }

  /** 移除：瓦片立刻转成 fixed 定在原位播 280ms 出场动效，腾出的空间当帧就开始收；280ms 后卸载并释放缩略图。 */
  const removeAttachment = (id: string, rect: TileRect) => {
    setLeaving((prev) => (prev[id] ? prev : { ...prev, [id]: rect }))
    const timer = window.setTimeout(() => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.id === id)
        if (target?.src) URL.revokeObjectURL(target.src)
        return prev.filter((a) => a.id !== id)
      })
      setLeaving((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }, 280)
    removeTimers.current.push(timer)
  }

  const submit = async () => {
    if (!canSend) return
    setReading(true)
    try{
    const accepted=await onSend(value.trim(), attachments)
    if(accepted===false)return
    attachments.forEach((a) => {
      if (a.src) URL.revokeObjectURL(a.src)
    })
    setAttachments([])
    setLeaving({})
    }finally{setReading(false)}
  }

  // 模拟上传队列（搬自 BoardUI ComposerWithAttachments）：
  // 同一时刻只有一个文件在传；50ms 一跳、带随机步进，到 100 停 150ms 落位，再隔 240ms 起下一个。
  const activeId = attachments.find((a) => a.progress !== undefined)?.id ?? null
  useEffect(() => {
    if (activeId === null) return
    let current = attachments.find((a) => a.id === activeId)?.progress ?? 0
    const step = 100 / Math.max(1, UPLOAD_DURATION / 50)
    let timer = 0
    const tick = () => {
      current = Math.min(100, current + step * (0.55 + 0.9 * Math.random()))
      const p = Math.round(current)
      setAttachments((prev) => prev.map((a) => (a.id === activeId ? { ...a, progress: p } : a)))
      if (current < 100) {
        timer = window.setTimeout(tick, 50)
        return
      }
      timer = window.setTimeout(() => {
        setAttachments((prev) =>
          prev.map((a) => (a.id === activeId ? { ...a, progress: undefined } : a)),
        )
      }, 150)
    }
    timer = window.setTimeout(tick, UPLOAD_GAP)
    return () => window.clearTimeout(timer)
  }, [activeId])

  // 可见集合 = 已落位 + 正在上传 + 退场中；排队中的文件等轮到自己才出现（BoardUI 同款）
  const visible = attachments.filter(
    (a) => a.progress === undefined || a.id === activeId || leaving[a.id] !== undefined,
  )
  /** 仍在文档流里的瓦片数：退场瓦片已脱流转 fixed，高度不为它保留空间（收缩与出场重叠）。 */
  const inFlowCount = visible.filter((a) => leaving[a.id] === undefined).length

  return (
    <form
      className={dragging ? 'prompt-input dragging' : 'prompt-input'}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragEnter={(e) => {
        e.preventDefault()
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
        addFiles(e.dataTransfer.files)
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
        disabled={reading}
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
        <button
          type="button"
          className="prompt-attach"
          aria-label="添加附件"
          title={PREP_BUILD?'上传代码、波形或文件':'添加PNG、JPEG、GIF或WebP图片'}
          disabled={reading}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="paperclip" size={16} />
        </button>
        <div className="prompt-actions">
          {showContextRing && <ContextRing tokens={contextTokens} />}
          {!PREP_BUILD && (modelError || remoteModels.error || remoteModels.saving || !remoteModels.data?.enabled || !remoteModels.data.callsEnabled) && <span role={modelError || remoteModels.error ? 'alert' : 'status'}>{modelError || remoteModels.error || (remoteModels.saving ? '正在保存模型选择…' : !remoteModels.data?.enabled ? '请在设置中配置并启用个人模型' : '模型调用已停用')}</span>}
          <div className="prompt-model" ref={modelRef}>
            <button
              type="button"
              className={modelOpen ? 'prompt-model-btn open' : 'prompt-model-btn'}
              aria-label="切换模型"
              disabled={!PREP_BUILD && (remoteModels.saving || remoteModels.loading || availableModels.length === 0)}
              aria-expanded={modelOpen}
              aria-haspopup="menu"
              onClick={() => toggleModel()}
            >
              {/* key 驱动换模型时的内容切换微动效 */}
              <span className="prompt-model-swap" key={model.id}>
                <Icon className="prompt-model-icon" name={model.icon} />
                <span className="prompt-model-label">{model.name}</span>
              </span>
              <Icon name="alt-arrow-down" size={12} className="caret" />
            </button>
            {modelOpen && (
              <div
                className={modelClosing ? 'prompt-model-menu closing' : 'prompt-model-menu'}
                role="menu"
              >
                {availableModels.map((m) => (
                  <div
                    key={m.id}
                    role="menuitemradio"
                    aria-checked={m.id === model.id}
                    tabIndex={0}
                    className="prompt-model-item"
                    onClick={() => {
                      pickModel(m.id)
                      closeModel()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pickModel(m.id)
                        closeModel()
                      }
                    }}
                  >
                    <Icon className="mi-icon" name={m.icon} size={20} />
                    <span className="mi-copy">
                      <span className="mi-name">{m.name}</span>
                      <span className="mi-note">{m.note}</span>
                    </span>
                    <span className="mi-check">{m.id === model.id && <Icon name="check" size={14} />}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="prompt-effort" ref={effortRef}>
            <button
              type="button"
              className={effortOpen ? 'prompt-model-btn open' : 'prompt-model-btn'}
              aria-label="切换思考强度"
              disabled={!PREP_BUILD && (remoteModels.saving || remoteModels.loading || !modelId || availableEfforts.length === 0)}
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
                {availableEfforts.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={level === effort}
                    className={level === effort ? 'mi-effort-option on' : 'mi-effort-option'}
                    onClick={() => {
                      pickEffort(model.id, level)
                      closeEffort()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        pickEffort(model.id, level)
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
          </div>
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
        accept={PREP_BUILD?undefined:'image/png,image/jpeg,image/gif,image/webp'}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </form>
  )
}

/** 单个附件瓦片（56px）：图片缩略图或插件图标 + 文件名，上传时画环、跳百分比。 */
function AttachmentTile({
  attachment,
  leavingRect,
  onRemove,
}: {
  attachment: PromptAttachment
  /** 已移除、退场中：瓦片固定在移除瞬间的视口矩形上播完动效（leaving 期间 CSS 给它 position: fixed） */
  leavingRect?: TileRect
  onRemove: (rect: TileRect) => void
}) {
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
