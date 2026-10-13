import { Markdown } from '../chat/Markdown'
import type { TutoringResourceResult } from '../../workspace/tutoringReturn'

export interface TutoringExampleProps {
  resource: TutoringResourceResult
  onReturn: () => void
  /** Main's identity/view validation result; closing never implies acknowledged or resumes tutoring. */
  returnNotice?: string
}

/** Passive reading slot: no fetch, mutations, model, execution or receipt side effects. */
export function TutoringExample({ resource, onReturn, returnNotice }: TutoringExampleProps) {
  return <section className="ts-pane" aria-label="教学资料阅读" data-testid="tutoring-example">
    <header className="ts-pane-head">
      <h2>{resource.kind === 'ready' ? resource.resource.title : '资料暂不可用'}</h2>
      <button type="button" onClick={onReturn}>返回原作品</button>
    </header>
    <p className="ts-pane-lead">只读资料，与你的作品分开。返回后由你继续编辑，不自动保存、求助或运行。</p>
    {resource.kind === 'ready' ? <>
      <p data-testid="tutoring-example-source">{resource.sourceLabel}</p>
      {resource.nature === 'course-material' && <p>这是当前可读课程资料；尚无依据将其称为教师批准的类似例子。</p>}
      <Markdown text={resource.resource.text} />
    </> : <p role="status">{resource.notice}</p>}
    {returnNotice && <p role="status">{returnNotice}</p>}
  </section>
}
