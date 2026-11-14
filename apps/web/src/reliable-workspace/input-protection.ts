import { LOCAL_MAX_WAIT_MS } from './coordinator'

interface RetainedInput { value: unknown; write: () => Promise<unknown>; before?: Promise<void>; writing?: Promise<void>; state: 'pending' | 'failed' }
/** The same latest-input obligation is used by workspace and standalone session drafts. */
export class RetainedInputs {
  private entries = new Map<string, RetainedInput>()
  constructor(private changed: () => void) {}
  get size() { return this.entries.size }
  retainInput<T>(key: string, input: T, write: (value: T) => Promise<unknown>): Promise<void> {
    const value = structuredClone(input)
    const entry: RetainedInput = { value, write: () => write(value), before: this.entries.get(key)?.writing, state: 'pending' }
    this.entries.set(key, entry); this.changed()
    return this.writeInput(key, entry)
  }
  retainedInput<T>(key: string): T | undefined { return structuredClone(this.entries.get(key)?.value as T | undefined) }
  inputProtection(key: string): 'protected' | 'pending' | 'failed' { return this.entries.get(key)?.state ?? 'protected' }
  private writeInput(key: string, entry: RetainedInput): Promise<void> {
    if (entry.writing) return entry.writing
    if (entry.state === 'failed') { entry.state = 'pending'; this.changed() }
    const writing = (async () => { await entry.before?.catch(() => {}); await entry.write() })()
    entry.writing = writing
    void writing.then(() => {
      entry.writing = undefined
      if (this.entries.get(key) === entry) { this.entries.delete(key); this.changed() }
    }, () => {
      entry.writing = undefined
      if (this.entries.get(key) === entry) { entry.state = 'failed'; this.changed() }
    })
    return writing
  }
  async protectInput(key: string): Promise<void> { while (this.entries.has(key)) await this.writeInput(key, this.entries.get(key)!) }
  async protect() { await Promise.all([...this.entries.keys()].map(key => this.protectInput(key))) }
}

/** No activity or work transport is fabricated for ordinary chat. Only pending local inputs have a lifetime. */
export class ReliableInputProtection {
  private inputs = new RetainedInputs(() => this.changed())
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  hasPending() { return this.inputs.size > 0 }
  private beforeUnload = (event: BeforeUnloadEvent) => { if (this.hasPending()) { event.preventDefault(); event.returnValue = '' } }
  private changed() {
    if (this.hasPending() && !this.timer) {
      window.addEventListener('beforeunload', this.beforeUnload)
      this.timer = setInterval(() => { void this.inputs.protect().catch(() => {}) }, LOCAL_MAX_WAIT_MS)
    } else if (!this.hasPending() && this.timer) {
      clearInterval(this.timer); this.timer = undefined; window.removeEventListener('beforeunload', this.beforeUnload)
    }
    for (const listener of this.listeners) listener()
  }
  retainInput<T>(key: string, input: T, write: (value: T) => Promise<unknown>) { return this.inputs.retainInput(key, input, write) }
  retainedInput<T>(key: string) { return this.inputs.retainedInput<T>(key) }
  inputProtection(key: string) { return this.inputs.inputProtection(key) }
  protectInput(key: string) { return this.inputs.protectInput(key) }
  async leave(): Promise<void> { do { await this.inputs.protect() } while (this.hasPending()) }
}
export const sessionInputProtection = new ReliableInputProtection()
