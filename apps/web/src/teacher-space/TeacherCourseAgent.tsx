import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@xunjie/ui/foundation'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import { AgentSessionsClient, SessionOutbox, type SessionSubject } from '../product/agent-sessions'
import type { ModelSelectionController } from '../product/ModelSelection'
import { ProductAgent, type TeacherAgentSeed } from '../product/ProductAgent'
import { sessionError } from '../product/useAgentSession'

export function TeacherCourseAgent({ subject, courseId, selection, readOnly, onSettings, seed, onSeedApplied }: {
  subject: SessionSubject; courseId: string; selection: ModelSelectionController; readOnly: boolean
  onSettings(): void; seed: TeacherAgentSeed | null
  onSeedApplied(): void
}) {
  const client = useMemo(() => new AgentSessionsClient({ ...subject, teacherCourseId: courseId }), [subject, courseId])
  const [directory, setDirectory] = useState<{ client: AgentSessionsClient; session?: AgentSession; error?: string }>()
  const [attempt, setAttempt] = useState(0)
  const onSession = useCallback((session: AgentSession) => setDirectory({ client, session }), [client])
  useEffect(() => {
    let current = true
    void client.listTeacherCourse(courseId).then(items => {
      if (!current) return
      const pending = new SessionOutbox(client).start()
      const session = pending ? undefined : items.filter(item => item.state === 'ready' && !item.deleted && !item.archived)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId))[0]
      setDirectory({ client, session })
    }).catch(cause => { if (current) setDirectory({ client, error: sessionError(cause) }) })
    return () => { current = false }
  }, [client, courseId, attempt])

  if (directory?.client !== client) return <p role="status" className="t-loading">正在打开课程对话…</p>
  if (directory.error) return <div className="t-inline-error" role="alert"><p>{directory.error}</p>
    <Button variant="outline" onClick={() => { setDirectory(undefined); setAttempt(value => value + 1) }}>重试</Button></div>
  return <ProductAgent key={client.scope} {...subject} sessionId={directory.session?.sessionId} session={directory.session}
    selection={selection} readOnly={readOnly} onSession={onSession} onSettings={onSettings}
    teacher={{ courseId, seed, onSeedApplied }} />
}
