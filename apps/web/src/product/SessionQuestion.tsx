import { useEffect, useState, type Ref } from 'react'
import type { AgentQuestion } from '@xunjie/contracts/agent-runtime'
import { teachingStudentAnswerSchema, teachingStudentAskInputSchema } from '@xunjie/contracts/student-questions'
import { AgentQuestion as AgentQuestionControl, AgentTraceItem } from '@xunjie/ui/chat'
import { Icon } from '@xunjie/ui/icons'
import type { AgentSessionController } from './useAgentSession'
import { useSessionDraft } from './session-drafts'
import './student-questions.css'

function presentationOf(question: AgentQuestion) {
  const { questionId: _questionId, sourceInputId: _sourceInputId, ...presentation } = question.presentation
  return teachingStudentAskInputSchema.safeParse(presentation)
}

function DraftProtectionFeedback({ error, retry }: { error: string; retry: () => Promise<void> }) {
  return error ? <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void retry().catch(() => {})}>重试保留输入</button></p> : null
}

export function SessionQuestionBox({ question, controller, readOnly, focusRef }: {
  question: AgentQuestion; controller: AgentSessionController; readOnly: boolean; focusRef?: Ref<HTMLElement>
}) {
  const parsed = presentationOf(question)
  const draft = useSessionDraft(controller.client.scope, controller.sessionId, 'question:' + question.questionId + ':' + question.version,
    { text: '', editing: true, expectedVersion: question.version })
  if (!parsed.success) return <section ref={focusRef} tabIndex={focusRef ? -1 : undefined} className="session-question-box" aria-label="Agent 的问题">
    <p role="status" className="session-question-status">正在等待原问题结果，请稍候。</p>
  </section>
  const prompt = parsed.data
  const choice = prompt.options.find(option => option.id === draft.value.optionId)?.id ?? ''
  const answer = (value: Record<string, string>) => void draft.protect()
    .then(() => controller.respond(question.questionId, question.version, value)).catch(() => {})
  return <section ref={focusRef} tabIndex={focusRef ? -1 : undefined} className="session-question-box" data-question-id={question.questionId} aria-label="Agent 的问题">
    <header className="session-question-heading">
      <span className="session-question-icon" aria-hidden="true"><Icon name="chat-round-dots" tone="neutral" /></span>
      <span>Agent 向你提问</span>
    </header>
    <AgentQuestionControl prompt={prompt.question} options={prompt.options} allowText={prompt.allowText}
      mode={choice ? 'choice' : 'text'} optionId={choice} text={draft.value.text}
      disabled={readOnly || controller.busy || !draft.ready}
      valid={!!choice || prompt.allowText && !!draft.value.text.trim()}
      pending={controller.busy} skippable={prompt.skippable}
      onMode={(mode, id) => { void draft.change({ ...draft.value, optionId: mode === 'choice' ? id ?? '' : '' }).catch(() => {}) }}
      onText={text => { void draft.change({ ...draft.value, text, optionId: '' }).catch(() => {}) }}
      onSubmit={skip => answer(skip ? { kind: 'skip' } : choice ? { kind: 'choice', optionId: choice } : { kind: 'text', text: draft.value.text })} />
    <DraftProtectionFeedback error={draft.error} retry={draft.protect} />
  </section>
}

function answerOf(question: AgentQuestion, prompt: ReturnType<typeof presentationOf>) {
  if (question.state === 'pending') return '等待你的回应'
  if (question.state === 'skipped') return '已跳过这次提问'
  if (!prompt.success) return '问题内容暂时无法显示'
  const answer = teachingStudentAnswerSchema.safeParse(question.answer)
  if (!answer.success || answer.data.kind === 'skip') return '已跳过这次提问'
  if (answer.data.kind === 'text') return answer.data.text
  const optionId = answer.data.optionId
  return prompt.data.options.find(option => option.id === optionId)?.label ?? optionId
}

export function AgentQuestionRecord({ question }: { question: AgentQuestion }) {
  const prompt = presentationOf(question)
  const answered = question.state !== 'pending'
  const [open, setOpen] = useState(answered)
  useEffect(() => { if (answered) setOpen(true) }, [answered])
  const status = question.state === 'pending' ? '进行中' : question.state === 'answered' ? '已完成'
    : question.state === 'skipped' ? '已跳过' : '已结束'
  return <AgentTraceItem title="向你提问" icon="chat-round-dots" status={status}
    tone={question.state === 'pending' ? 'waiting' : question.state === 'answered' ? 'done' : 'neutral'}
    open={open} onOpenChange={setOpen}>
    <div className="agent-question-record">
      <p className="agent-question-record-prompt">{prompt.success ? prompt.data.question : '问题内容暂时无法显示。'}</p>
      <dl className="agent-question-record-answer">
        <dt>{question.state === 'skipped' ? '这次提问' : '你的选择'}</dt>
        <dd>{answerOf(question, prompt)}</dd>
      </dl>
    </div>
  </AgentTraceItem>
}
