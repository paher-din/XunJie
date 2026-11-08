import { useEffect, useRef, useState } from 'react'
import { PromptInput as PromptInputView, type PromptAttachment, type PromptAttachmentKind } from '@xunjie/ui/chat'
import { PREP_BUILD } from '../workspace/mode'
import { personalModelOptions, reasoningOptions, saveModelSettings, useModelSettings } from '../lib/modelSettings'
import { ContextRing } from './ContextRing'
export type { PromptAttachment, PromptAttachmentKind } from '@xunjie/ui/chat'

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

/** 模拟上传节奏（搬自 BoardUI Composer：单文件排队，逐个落位）。 */
const UPLOAD_DURATION = 1100
const UPLOAD_GAP = 240

export interface PromptInputProps {
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

/** 旧消费者适配：模型持久化、文件资源、准备模式进度与发送接纳留在旧宿主。 */
export function PromptInput({ value, onChange, onSend, autoFocus, contextTokens = 0,
  showContextRing = true, busy = false, onStop }: PromptInputProps) {
  const [attachments, setAttachments] = useState<PromptAttachment[]>([])
  const attachmentsRef=useRef(attachments)
  attachmentsRef.current=attachments
  useEffect(()=>()=>{attachmentsRef.current.forEach(attachment=>{if(attachment.src)URL.revokeObjectURL(attachment.src)})},[])
  const [reading,setReading]=useState(false)
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
  const nextId = useRef(0)
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

  // 模型被外部切换（如失败卡「换个模型」）时同步按钮展示
  useEffect(() => {
    const sync = () => setModelId(localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
    window.addEventListener(MODEL_CHANGE_EVENT, sync)
    return () => window.removeEventListener(MODEL_CHANGE_EVENT, sync)
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

  const removeAttachment = (id: string) => {
    setAttachments(previous => {
      const target = previous.find(a => a.id === id)
      if (target?.src) URL.revokeObjectURL(target.src)
      return previous.filter(a => a.id !== id)
    })
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

  const statusText = !PREP_BUILD && (modelError || remoteModels.error || remoteModels.saving || !remoteModels.data?.enabled || !remoteModels.data.callsEnabled)
    ? modelError || remoteModels.error || (remoteModels.saving ? '正在保存模型选择…' : !remoteModels.data?.enabled ? '请在设置中配置并启用个人模型' : '模型调用已停用') : undefined
  return <PromptInputView value={value} onChange={onChange} onSend={submit} canSend={canSend}
    submitting={reading} autoFocus={autoFocus} busy={busy} onStop={onStop}
    attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment}
    accept={PREP_BUILD ? undefined : 'image/png,image/jpeg,image/gif,image/webp'}
    attachmentTitle={PREP_BUILD ? '上传代码、波形或文件' : '添加PNG、JPEG、GIF或WebP图片'}
    model={model} models={availableModels} onModelChange={pickModel}
    modelDisabled={!PREP_BUILD && (remoteModels.saving || remoteModels.loading || availableModels.length === 0)}
    effort={effort} efforts={availableEfforts} onEffortChange={pickEffort}
    effortDisabled={!PREP_BUILD && (remoteModels.saving || remoteModels.loading || !modelId || availableEfforts.length === 0)}
    status={statusText ? { role: modelError || remoteModels.error ? 'alert' : 'status', text: statusText } : undefined}
    contextIndicator={showContextRing ? <ContextRing tokens={contextTokens} /> : undefined}
  />
}
