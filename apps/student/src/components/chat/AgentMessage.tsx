import { Icon, IconText } from '../../icons'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, ConceptCard as ConceptCardData } from '../../bridge/types'
import { formatMessageTime } from '../../lib/chatTime'
import { MascotSvg } from '../Mascot'
import { ConceptCard } from './ConceptCard'
import { GenCard } from './GenCard'
import { Markdown } from './Markdown'
import { QuizCard } from './QuizCard'
import { StepsBlock } from './StepsBlock'
import { useSmoothStreamText } from './useSmoothStreamText'
import {
  FAILURE_ACTION_LABEL,
  FAILURE_COPY,
  STOP_EMPTY,
  STOP_WITH_CONTENT,
  WAIT_SECONDS_AT_MS,
  WAIT_TEXT,
  WAIT_TEXT_AT_MS,
} from './copy'

/** 生成交互卡的逐消息动作槽（由页面按消息定位注入适配层调用）。 */
export interface GenCardSlots {
  /** 收纳后的任务名（占位行展示）。 */
  taskName?: string
  /** 「收纳」：拿到收纳时的最新快照（父级写适配层）。 */
  onCollect?: (snapshot: unknown) => void
  /** 生成失败卡的「重试」。 */
  onRetry?: () => void
  /** 占位行「打开」：导航到工作区并取出。 */
  onOpen?: () => void
  /** 工作区消息内卡：「在工具区打开」成中心工具区标签页。 */
  onOpenInWorkspace?: () => void
  /** live 期间的交互状态续写。 */
  onStateSync?: (snapshot: unknown) => void
}

/**
 * 一条 agent 消息（共用组件层：AgentPage 与工作区引导面板共用）。
 * 按 phase 渲染：waiting 呼吸点三档递进 / thinking 折叠行 / streaming 逐字 markdown + 光标 /
 * stopped 停止行 / failed 失败卡（含错误码）/ settled 操作条。
 * 文案口径见 docs/agent-page-design.md「已确认」。
 * children 用于消息内卡片槽（如任务卡），由父级按数据渲染。
 */
export function AgentMessage({
  message,
  onResume,
  onRetry,
  onSwitchModel,
  onQuizAnswer,
  onConceptCollect,
  genCardSlots,
  sourceLabel,
  children,
}: {
  message: ChatMessage
  /** stopped 且有已生成内容：继续生成。 */
  onResume?: () => void
  /** settled 重新生成 / failed 重试 / stopped 空内容时重新生成。 */
  onRetry?: () => void
  /** failed(model)：换个模型后重试；不传则不显示该按钮。 */
  onSwitchModel?: () => void
  /** 小测卡作答写回（按消息定位）；不传则仅本地判定、不持久化。 */
  onQuizAnswer?: (selected: string) => void
  /** 工作区场景：概念卡「收纳」收进左侧胶囊卡片体系（覆盖默认的钉右缘行为）。 */
  onConceptCollect?: () => void
  /** 生成交互卡动作槽；不传则消息内的生成卡不带收纳等动作。 */
  genCardSlots?: GenCardSlots
  /** I0-B complete approved content keeps its actual source label. */
  sourceLabel?: string
  children?: React.ReactNode
}) {
  const phase = message.phase ?? 'settled'
  const streaming = phase === 'streaming'
  // 到达节奏 ≠ 上屏节奏：适配层按 token 吐字（一次 1–4 字、间隔带抖动），
  // 这一层按帧把缓冲匀出去，正文才是一条匀速的流而不是一顿一顿。
  const shown = useSmoothStreamText(message.text, streaming)
  return (
    <div className="chat-message agent">
      {sourceLabel && <div className="agentmark"><IconText name="assistant-mark">{sourceLabel}</IconText></div>}
      {phase === 'waiting' || phase === 'thinking' ? (
        /* 回合头：等待与正在思考共用同一行、同一只 IP 小图。
           小图挂在相位切换之外——重挂会让它的骨骼动画从第 0 帧重来，每回合开头都会跳一下 */
        <div className="turn-status">
          <MascotSvg className="turn-ip" motion="think" />
          {phase === 'waiting' ? <WaitTail /> : <ThinkTail thinking={message.thinking} />}
        </div>
      ) : (
        message.thinking && <ThinkingSettled thinking={message.thinking} />
      )}
      {/* 概念卡随正文画出：讲到它依附的那一段就立壳，之后逐条写出、出图、补读图提示，不再等落定才弹出。
          失败不落卡（半张卡配一张失败卡只会分不清看哪儿）；被叫停则停在半张卡上——
          正文留着半截，卡片没理由不见，只是动作还不给 */}
      {message.text && (
        <Markdown
          text={shown}
          live={streaming}
          truncated={phase === 'stopped' || phase === 'failed'}
          insert={
            message.concept && phase !== 'failed' ? (
              <ConceptBlock
                card={message.concept}
                stage={streaming ? 'drawing' : phase === 'stopped' ? 'paused' : 'ready'}
                onCollect={onConceptCollect}
              />
            ) : undefined
          }
          insertAfterPara={message.concept?.afterPara}
        />
      )}
      {/* 消息内卡片槽紧跟正文：卡片属于这条回复的内容，操作条始终收在最后 */}
      {children}
      {message.steps && message.steps.length > 0 && (
        <StepsBlock steps={message.steps} running={phase === 'streaming'} />
      )}
      {phase === 'settled' && message.quiz && (
        <QuizCard quiz={message.quiz} onSubmitAnswer={onQuizAnswer} />
      )}
      {phase === 'settled' && message.genCard && (
        <GenCard card={message.genCard} {...genCardSlots} />
      )}
      {phase === 'stopped' && (
        <StopLine empty={!message.text} onResume={onResume} onRetry={onRetry} />
      )}
      {phase === 'failed' && message.failure && (
        <FailureCard message={message} onRetry={onRetry} onSwitchModel={onSwitchModel} />
      )}
      {phase === 'settled' && (
        <ActionBar text={message.text} at={message.at} onRetry={onRetry} />
      )}
    </div>
  )
}

/** 等待首 token 的尾段：呼吸点；4 秒起「等待模型响应」，12 秒起追加走动秒数。 */
function WaitTail() {
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setElapsed(Date.now() - startRef.current), 200)
    return () => window.clearInterval(t)
  }, [])
  const text =
    elapsed < WAIT_TEXT_AT_MS
      ? ''
      : elapsed < WAIT_SECONDS_AT_MS
        ? WAIT_TEXT
        : `${WAIT_TEXT} · ${Math.floor(elapsed / 1000)} 秒`
  return (
    <>
      <span className="turn-dots">
        <i />
        <i />
        <i />
      </span>
      {text && <span className="turn-wait-text">{text}</span>}
    </>
  )
}

/** 正在思考的尾段：走动秒数；摘要回来后换成可展开的落定态。 */
function ThinkTail({ thinking }: { thinking?: { summary: string; seconds: number } }) {
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setElapsed(Date.now() - startRef.current), 200)
    return () => window.clearInterval(t)
  }, [])
  const seconds = thinking?.seconds ?? Math.max(1, Math.round(elapsed / 1000))
  return (
    <>
      <span className="turn-thinklabel">正在思考</span>
      <span className="tm">{seconds} 秒</span>
    </>
  )
}

/** 已思考（落定态）：静态 orb + 「已思考 N 秒」，可展开看教学化摘要。 */
function ThinkingSettled({ thinking }: { thinking: { summary: string; seconds: number } }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="turn-thinkwrap">
      <div
        className={'turn-thinkrow clickable' + (open ? ' open' : '')}
        role="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="orb" />
        <span className="turn-thinklabel">已思考</span>
        <span className="tm">{thinking.seconds} 秒</span>
        <Icon className="arw" name="alt-arrow-right" size={12} />
      </div>
      <div className="turn-thinkbody" hidden={!open}>
        {thinking.summary}
      </div>    </div>
  )
}

/** 概念讲解卡槽：对话页「收纳」把卡片钉到右缘对照（portal 出滚动容器，随滚动常驻），取消后回到原位；
 * 工作区场景传 onCollect 时改收进左侧胶囊卡片体系（已确认第 12 条分流）。 */
function ConceptBlock({
  card,
  stage,
  onCollect,
}: {
  card: ConceptCardData
  /** 卡片处在哪个阶段：生成中 / 这条被叫停 / 落定（动作只给落定态）。 */
  stage?: 'drawing' | 'paused' | 'ready'
  onCollect?: () => void
}) {
  const [pinned, setPinned] = useState(false)
  const el = (
    <ConceptCard
      card={card}
      stage={stage}
      pinned={pinned}
      onTogglePin={onCollect ?? (() => setPinned((v) => !v))}
    />
  )
  if (pinned && !onCollect) return createPortal(<div className="concept-pin">{el}</div>, document.body)
  return el
}

/** 已停止：保留已生成部分；有内容给「继续生成」，空内容给「重新生成」。 */
function StopLine({
  empty,
  onResume,
  onRetry,
}: {
  empty: boolean
  onResume?: () => void
  onRetry?: () => void
}) {
  return (
    <div className="turn-stopline">
      <Icon name="stop" size={12} />
      <span>{empty ? STOP_EMPTY : STOP_WITH_CONTENT}</span>
      {empty
        ? onRetry && <button onClick={onRetry}><IconText name="restart" size={14}>重新生成</IconText></button>
        : onResume && <button onClick={onResume}><IconText name="play" size={14}>继续生成</IconText></button>}
    </div>
  )
}

/** 失败卡：分型标题 + 说明 + 错误码 + 动作；「知道了」折叠成一行（仍可重试）。 */
function FailureCard({
  message,
  onRetry,
  onSwitchModel,
}: {
  message: ChatMessage
  onRetry?: () => void
  onSwitchModel?: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const failure = message.failure!
  const copy: (typeof FAILURE_COPY)['network'] = failure.code === 'DEADLINE_EXCEEDED'||failure.code==='PROVIDER_IDLE_TIMEOUT'
    ? { title: failure.code==='PROVIDER_IDLE_TIMEOUT'?'模型连接长时间无响应':'等待模型响应超时', actions: ['retry', 'dismiss'] }
    : failure.code === 'PROVIDER_PAYMENT_REQUIRED'
      ? { title: '供应商余额不足', actions: ['dismiss'] }
      : failure.code === 'RATE_LIMITED'
        ? { title: '供应商请求频率受限', actions: ['retry', 'dismiss'] }
        : failure.code === 'OUTPUT_LIMIT_EXCEEDED'
          ? { title: '模型已用完本次输出额度，回复未完成', actions: ['retry', 'dismiss'] }
          : failure.code === 'EMPTY_MODEL_RESPONSE'
            ? { title: '模型已结束，但没有返回正文', actions: ['retry', 'dismiss'] }
            : failure.code === 'PROVIDER_CONTENT_FILTERED'
              ? { title: '供应商未能返回这次回复', actions: ['retry', 'dismiss'] }
        : FAILURE_COPY[failure.reason]
  if (dismissed) {
    return (
      <div className="turn-fail-collapsed">
        <span>{copy.title}</span>
        {onRetry && <button onClick={onRetry}><IconText name="restart" size={14}>重试</IconText></button>}
      </div>
    )
  }
  const handlers = {
    retry: onRetry,
    switchModel: onSwitchModel,
    dismiss: () => setDismissed(true),
  } as const
  return (
    <div className="turn-failcard">
      <div className="turn-failhead">
        <Icon className="turn-failicon" name="danger-triangle" size={18} />
        <strong>{copy.title}</strong>
      </div>
      {copy.desc && <p>{copy.desc}</p>}
      {failure.code && <div className="turn-failcode">错误码 {failure.code}</div>}
      <div className="turn-failacts">
        {copy.actions.map((action, i) => {
          const handler = handlers[action]
          if (!handler) return null
          return (
            <button key={action} className={i === 0 ? 'primary' : ''} onClick={handler}>
              {FAILURE_ACTION_LABEL[action]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 落定操作条：图标键，无障碍名与提示承载文案（复制、重新生成——重新生成只挂在会话最后一条 agent 消息上，由父级控制）。 */
function ActionBar({ text, at, onRetry }: { text: string; at?: string; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="turn-actions">
      <button
        aria-label={copied ? '已复制' : '复制回复'}
        title={copied ? '已复制' : '复制'}
        onClick={() => {
          navigator.clipboard.writeText(text).catch(() => {})
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        <Icon className={copied ? 'copied' : ''} name={copied ? 'check' : 'copy'} size={16} />
      </button>
      {onRetry && (
        <button aria-label="重新生成" title="重新生成" onClick={onRetry}>
          <Icon name="restart" size={16} />
        </button>
      )}
      {/* 时间戳跟在操作键后面：先给动作，再交代这条是什么时候说的 */}
      {at && (
        <time className="turn-time" dateTime={at}>
          {formatMessageTime(at)}
        </time>
      )}
    </div>
  )
}
