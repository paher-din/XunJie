import { useEffect, useState } from 'react'
import type { QuizCard as QuizCardData, QuizResult } from '../../bridge/types'

/**
 * 自测小测卡：落定后挂载的单题单选（已确认 2026-10-10，
 * docs/agent-page-design.md「教学专属块」）。
 * 交互定稿：选了再提交；答错给解析并可再答一次（不揭示答案）；
 * 答对后提示已记入学习画像（真实画像写入由适配层在 submitQuizAnswer 里完成）。
 * 判定在本地完成（answer 随卡片下发）；onSubmitAnswer 是把结果写回消息的持久化钩子。
 */
export function QuizCard({
  quiz,
  onSubmitAnswer,
}: {
  quiz: QuizCardData
  /** 提交一次作答（写回消息的 quiz.result）；不传则仅本地判定。 */
  onSubmitAnswer?: (selected: string) => void
}) {
  const [result, setResult] = useState<QuizResult | undefined>(quiz.result)
  const [selected, setSelected] = useState<string | null>(null)
  // 答错后点「再答一次」：本地回到未答形态，已写回的错误结果仍留在消息里
  const [retrying, setRetrying] = useState(false)
  // 适配层写回后 quiz.result 会随会话查询更新（如重挂后拿到已答结果），同步进本地
  useEffect(() => {
    setResult(quiz.result)
    setRetrying(false)
  }, [quiz.result])

  const judged = retrying ? undefined : result
  const locked = judged !== undefined

  const submit = () => {
    if (!selected || locked) return
    const next: QuizResult = {
      selected,
      correct: selected === quiz.answer,
      attempts: (result?.attempts ?? 0) + 1,
    }
    setResult(next)
    setRetrying(false)
    onSubmitAnswer?.(selected)
  }

  const retry = () => {
    setRetrying(true)
    setSelected(null)
  }

  return (
    <div
      className={
        'quiz-card' + (judged ? ' judged' + (judged.correct ? ' judged-right' : ' judged-wrong') : '')
      }
    >
      <div className="quiz-head">
        <span className="quiz-cap">小测</span>
        <span className="quiz-title">{quiz.title}</span>
        {judged && judged.attempts > 1 && (
          <span className="quiz-meta">第 {judged.attempts} 次作答</span>
        )}
      </div>
      <div className="quiz-body">
        <div className="quiz-stem">{quiz.stem}</div>
        <div className="quiz-opts">
          {quiz.options.map((opt) => {
            const isRightMark = judged?.correct && opt.key === quiz.answer
            const isWrongPick = judged !== undefined && !judged.correct && opt.key === judged.selected
            const cls =
              'quiz-opt' +
              (!judged && selected === opt.key ? ' sel' : '') +
              (isRightMark ? ' right' : '') +
              (isWrongPick ? ' wrongsel' : '')
            return (
              <button
                key={opt.key}
                className={cls}
                disabled={locked}
                onClick={() => setSelected(opt.key)}
              >
                <span className="b">{isRightMark ? '✓' : isWrongPick ? '✕' : opt.key}</span>
                <span>{opt.text}</span>
              </button>
            )
          })}
        </div>
        {!locked && (
          <div className="quiz-submitrow">
            <button className="quiz-submit" disabled={!selected} onClick={submit}>
              提交
            </button>
          </div>
        )}
        {judged && (
          <div className="quiz-judge">
            <div className="quiz-verdict">
              {judged.correct ? (
                <span className="ok">答对了。</span>
              ) : (
                <span className="no">还不对，再想想。</span>
              )}
            </div>
            <div className="quiz-explain">{quiz.explain}</div>
            {!judged.correct && (
              <button className="quiz-retry" onClick={retry}>
                再答一次
              </button>
            )}
            {judged.correct && (
              <div className="quiz-record">已记入学习画像 · {quiz.topic}：掌握</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
