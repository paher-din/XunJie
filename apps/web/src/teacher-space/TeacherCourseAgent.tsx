import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import { AgentSessionsClient, SessionOutbox, type SessionSubject } from '../product/agent-sessions'
import type { ModelSelectionController } from '../product/ModelSelection'
import { ProductAgent, type TeacherAgentSeed } from '../product/ProductAgent'
import { sessionError } from '../product/useAgentSession'
import { clearTeacherCourseSession, readTeacherCourseSession, writeTeacherCourseSession } from './teacher-course-session'

type Directory = { client: AgentSessionsClient; session?: AgentSession; pending: boolean; error?: string }
const ready = (item: AgentSession) => item.state === 'ready' && !item.deleted && !item.archived
const newest = (items: AgentSession[]) => items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sessionId.localeCompare(a.sessionId))[0]

export function TeacherCourseAgent({ subject, courseId, selection, readOnly, onSettings, seed, onSeedApplied }: {
  subject: SessionSubject; courseId: string; selection: ModelSelectionController; readOnly: boolean
  onSettings(): void; seed: TeacherAgentSeed | null
  onSeedApplied(): void
}) {
  const scope = JSON.stringify([subject.namespace, subject.spaceKey, subject.identity.kind, subject.identity.environmentId,
    subject.identity.spaceId, subject.identity.principalId, courseId])
  const client = useMemo(() => new AgentSessionsClient({ ...subject, teacherCourseId: courseId }), [scope])
  // 有未完成的首问时必须走新会话恢复，不能先把旧会话挂上来。
  const pendingStart = useMemo(() => new SessionOutbox(client).start(), [client])
  const cached = useMemo(() => pendingStart ? undefined : readTeacherCourseSession(client.scope), [client, pendingStart])
  const [directory, setDirectory] = useState<Directory>({ client, session: cached, pending: !cached })
  const selected = useRef<'cache' | 'user'>('cache')
  const [attempt, setAttempt] = useState(0)
  // subject 在页面初次装配后可能换成最终身份；client 变了就按新课程重读指针，不能沿用旧 client 的 pending。
  useEffect(() => {
    const pending = new SessionOutbox(client).start()
    const session = pending ? undefined : readTeacherCourseSession(client.scope)
    selected.current = 'cache'
    setDirectory({ client, session, pending: !session })
  }, [client])
  const retry = useCallback(() => {
    setDirectory(current => current.client === client ? { ...current, pending: !current.session, error: '' } : current)
    setAttempt(value => value + 1)
  }, [client])
  const onSession = useCallback((session: AgentSession) => {
    selected.current = 'user'
    writeTeacherCourseSession(client.scope, session)
    setDirectory({ client, session, pending: false, error: undefined })
  }, [client])
  // 用户已经在输入框里动手时，列表返回也不能把这段新对话换成旧会话。
  const startNew = useCallback(() => {
    if (selected.current === 'user') return
    selected.current = 'user'
    clearTeacherCourseSession(client.scope)
    setDirectory(current => current.client === client ? { ...current, session: undefined, pending: false, error: undefined } : current)
  }, [client])
  useEffect(() => {
    let live = true
    void client.listTeacherCourse(courseId).then(items => {
      if (!live) return
      setDirectory(current => {
        if (current.client !== client) return current
        const pending = new SessionOutbox(client).start()
        const available = items.filter(ready)
        const previous = current.session
        const keep = previous && available.find(item => item.sessionId === previous.sessionId)
        const next = pending ? undefined : selected.current === 'user' ? previous : keep ?? newest(available)
        if (next) writeTeacherCourseSession(client.scope, next)
        else if (!pending) clearTeacherCourseSession(client.scope)
        return { client, session: next, pending: false }
      })
    }).catch(cause => {
      if (!live) return
      // 列表失败不清掉已缓存的会话，先让页面可用；错误放在内联提示里，可单独重试。
      setDirectory(current => current.client === client ? { ...current, pending: false, error: sessionError(cause) } : current)
    })
    return () => { live = false }
  }, [client, courseId, attempt])
  return <ProductAgent key={client.scope} {...subject} sessionId={directory.session?.sessionId} session={directory.session}
    selection={selection} readOnly={readOnly} onSession={onSession} onSettings={onSettings}
    teacher={{ courseId, seed, onSeedApplied }} directoryPending={directory.pending} directoryError={directory.error}
    onRetryDirectory={retry} onNewConversation={startNew} />
}
