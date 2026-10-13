import { Icon, IconText } from '../../icons'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage, ConceptCard as ConceptCardData } from '../../bridge/types'
import { MascotSvg } from '../Mascot'
import { ConceptCard } from './ConceptCard'
import { GenCard } from './GenCard'
import { Markdown } from './Markdown'
import { QuizCard } from './QuizCard'
import { StepsBlock } from './StepsBlock'
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
  children?: React.ReactNode
}) {
  const phase = message.phase ?? 'settled'
  return (
    <div className="chat-message agent">
      <div className="agentmark"><IconText name="assistant-mark">学习助手 · 模拟回复</IconText></div>
      {phase === 'waiting' && <WaitingLine />}
      {(phase === 'thinking' || message.thinking) && (
        <ThinkingRow running={phase === 'thinking'} thinking={message.thinking} />
      )}
      {message.text && (
        <Markdown
          text={message.text}
          live={phase === 'streaming'}
          insert={
            phase === 'settled' && message.concept ? (
              <ConceptBlock card={message.concept} onCollect={onConceptCollect} />
            ) : undefined
          }
          insertAfterPara={message.concept?.afterPara}
        />
      )}
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
      {phase === 'settled' && <ActionBar text={message.text} onRetry={onRetry} />}
      {children}
    </div>
  )
}

/** 等待首 token：呼吸点；4 秒起「等待模型响应」；12 秒起追加走动秒数。 */
function WaitingLine() {
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
    <div className="turn-wait">
      {/* a2（2026-10-10 定稿）：等待期 IP 小图出现在状态行前，落定即消失 */}
      <MascotSvg className="turn-ip" motion="think" />
      <span className="turn-dots">
        <i />
        <i />
        <i />
      </span>
      {text && <span className="turn-wait-text">{text}</span>}
    </div>
  )
}

/** 思考折叠行：进行中「正在思考」+ 走动秒数；拿到摘要后「已思考 N 秒」，可展开看教学化摘要。 */
function ThinkingRow({
  running,
  thinking,
}: {
  running: boolean
  thinking?: { summary: string; seconds: number }
}) {
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setElapsed(Date.now() - startRef.current), 200)
    return () => window.clearInterval(t)
  }, [running])
  const seconds = thinking?.seconds ?? Math.max(1, Math.round(elapsed / 1000))
  const expandable = !!thinking
  return (
    <div className="turn-thinkwrap">
      <div
        className={
          'turn-thinkrow' +
          (running ? ' running' : '') +
          (expandable ? ' clickable' : '') +
          (open && expandable ? ' open' : '')
        }
        role={expandable ? 'button' : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        {/* a2：进行中 IP 小图顶替状态球；落定后回到静态 orb */}
        {running ? <MascotSvg className="turn-ip" motion="think" /> : <span className="orb" />}
        <span>{running ? '正在思考' : '已思考'}</span>
        <span className="tm">{seconds} 秒</span>
        {expandable && <Icon className="arw" name="alt-arrow-right" size={12} />}
      </div>
      {open && thinking && <div className="turn-thinkbody">{thinking.summary}</div>}
    </div>
  )
}

/** 概念讲解卡槽：对话页「收纳」把卡片钉到右缘对照（portal 出滚动容器，随滚动常驻），取消后回到原位；
 * 工作区场景传 onCollect 时改收进左侧胶囊卡片体系（已确认第 12 条分流）。 */
function ConceptBlock({
  card,
  onCollect,
}: {
  card: ConceptCardData
  onCollect?: () => void
}) {
  const [pinned, setPinned] = useState(false)
  const el = (
    <ConceptCard
      card={card}
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
  const copy = FAILURE_COPY[failure.reason]
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

/** 落定操作条：复制、重新生成（重新生成只挂在会话最后一条 agent 消息上，由父级控制）。 */
function ActionBar({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="turn-actions">
      <button
        onClick={() => {
          navigator.clipboard.writeText(text).catch(() => {})
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        <IconText name={copied ? 'check' : 'copy'} size={14}>{copied ? '已复制' : '复制'}</IconText>
      </button>
      {onRetry && <button onClick={onRetry}><IconText name="restart" size={14}>重新生成</IconText></button>}
    </div>
  )
}
