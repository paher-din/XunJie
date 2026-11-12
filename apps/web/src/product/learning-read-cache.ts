type Entry = { value?: unknown; updatedAt: number; revision: number; pending?: Promise<unknown> }

export class LearningReadCache {
  private entries = new Map<string, Entry>()
  constructor(private readonly limit = 24) {}

  private remember(key: string, entry: Entry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }

  peek<Value>(space: string, path: string): Value | undefined {
    const key = JSON.stringify([space, path]), entry = this.entries.get(key)
    if (entry) this.remember(key, entry)
    return entry?.value as Value | undefined
  }

  set<Value>(space: string, path: string, value: Value) {
    const key = JSON.stringify([space, path])
    const entry = this.entries.get(key) ?? { updatedAt: 0, revision: 0 }
    entry.value = value
    entry.updatedAt = Date.now()
    entry.revision++
    this.remember(key, entry)
  }

  async read<Value>(space: string, path: string, load: () => Promise<Value>): Promise<Value> {
    const key = JSON.stringify([space, path])
    const entry = this.entries.get(key) ?? { updatedAt: 0, revision: 0 }
    this.remember(key, entry)
    if (entry.value !== undefined && Date.now() - entry.updatedAt < 30000) return entry.value as Value
    if (entry.pending) return entry.pending as Promise<Value>
    const revision = entry.revision
    const pending = load().then(value => {
      if (revision === entry.revision) {
        entry.value = value
        entry.updatedAt = Date.now()
      }
      return entry.value as Value
    }).catch(cause => {
      if (revision !== entry.revision && entry.value !== undefined) return entry.value as Value
      throw cause
    }).finally(() => { if (entry.pending === pending) entry.pending = undefined })
    entry.pending = pending
    return pending
  }
}
