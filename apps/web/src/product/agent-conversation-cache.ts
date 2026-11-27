import { agentConversationSchema, type AgentConversation } from '@xunjie/contracts/agent-service'

/**
 * 会话投影的短期缓存：先显示上次看到的对话，再用 lastSeq 做增量刷新。
 * key 里带有完整的 Agent scope，不会跨账号、空间或课程串用。
 */
const PREFIX = 'xj.agent-conversation.v1.'
const TTL = 30 * 60 * 1000
const MAX_MEMORY = 8
const MAX_STORED = 6
const MAX_JSON = 1_500_000
interface Saved { sessionId?: unknown; savedAt?: unknown; value?: unknown }
interface Entry { savedAt: number; value: AgentConversation }
const key = (scope: string, sessionId: string) => PREFIX + scope + ':' + sessionId

export class AgentConversationCache {
  private readonly memory = new Map<string, Entry>()

  read(scope: string, sessionId: string | undefined): AgentConversation | undefined {
    if (!sessionId) return
    const storageKey = key(scope, sessionId)
    const saved = this.memory.get(storageKey)
    if (saved) {
      if (Date.now() - saved.savedAt <= TTL && saved.value.sessionId === sessionId) return saved.value
      this.memory.delete(storageKey)
    }
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (!raw) return
      const value = JSON.parse(raw) as Saved
      if (typeof value.sessionId !== 'string' || value.sessionId !== sessionId
        || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > TTL) {
        this.remove(storageKey)
        return
      }
      const parsed = agentConversationSchema.safeParse(value.value)
      if (!parsed.success || parsed.data.sessionId !== sessionId) { this.remove(storageKey); return }
      this.putMemory(storageKey, value.savedAt, parsed.data)
      return parsed.data
    } catch { this.remove(storageKey) }
  }

  write(scope: string, sessionId: string, value: AgentConversation) {
    if (value.sessionId !== sessionId) return
    const storageKey = key(scope, sessionId), savedAt = Date.now()
    this.putMemory(storageKey, savedAt, value)
    let json: string
    try { json = JSON.stringify({ sessionId, savedAt, value }) } catch { return }
    if (json.length > MAX_JSON) { this.remove(storageKey); return }
    try {
      sessionStorage.setItem(storageKey, json)
      this.trim()
    } catch { /* 容量不足时保留内存缓存，当前页面仍能秒开 */ }
  }

  clear(scope: string, sessionId: string) { this.remove(key(scope, sessionId)) }

  private putMemory(storageKey: string, savedAt: number, value: AgentConversation) {
    this.memory.delete(storageKey)
    this.memory.set(storageKey, { savedAt, value })
    while (this.memory.size > MAX_MEMORY) this.memory.delete(this.memory.keys().next().value!)
  }

  private remove(storageKey: string) {
    this.memory.delete(storageKey)
    try { sessionStorage.removeItem(storageKey) } catch { /* ignore */ }
  }

  private trim() {
    try {
      const entries: { key: string; savedAt: number }[] = []
      for (let index = 0; index < sessionStorage.length; index++) {
        const storageKey = sessionStorage.key(index)
        if (!storageKey?.startsWith(PREFIX)) continue
        try {
          const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as Saved
          entries.push({ key: storageKey, savedAt: typeof value?.savedAt === 'number' ? value.savedAt : 0 })
        } catch { sessionStorage.removeItem(storageKey) }
      }
      if (entries.length <= MAX_STORED) return
      entries.sort((a, b) => a.savedAt - b.savedAt)
      for (const entry of entries.slice(0, entries.length - MAX_STORED)) sessionStorage.removeItem(entry.key)
    } catch { /* ignore */ }
  }
}

export const teacherConversationCache = new AgentConversationCache()
