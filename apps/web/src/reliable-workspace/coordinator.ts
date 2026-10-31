export const LOCAL_MAX_WAIT_MS = 250
export const NETWORK_MAX_WAIT_MS = 1000

/** Shared protection, initialization and dispatch lifetime for workspace state partitions. */
export abstract class ReliableStateCoordinator {
  protected dirty = false
  protected stopped = false
  protected disposed = false
  protected denied = false
  private protecting?: Promise<void>
  private initializing?: Promise<void>
  private localTimer?: ReturnType<typeof setInterval>
  private networkTimer?: ReturnType<typeof setInterval>
  protected abstract ready(): boolean
  protected abstract conflicted(): boolean
  protected abstract load(): Promise<void>
  protected abstract persist(): Promise<void>
  protected abstract synchronize(): Promise<void>
  protected abstract clearListeners(): void

  async open() {
    if (this.disposed || this.ready()) return
    this.localTimer ??= setInterval(() => {
      if (this.ready()) void this.protect().catch(() => {})
      else if (!this.denied) void this.initialize().catch(() => {})
    }, LOCAL_MAX_WAIT_MS)
    this.startNetwork()
    window.addEventListener('beforeunload', this.beforeUnload)
    await this.initialize()
    void this.synchronize()
  }
  private async initialize(): Promise<void> {
    if (this.initializing) return this.initializing
    this.initializing = this.load()
    try { await this.initializing } finally { this.initializing = undefined }
  }
  async protect(): Promise<void> {
    if (this.protecting) {
      await this.protecting
      if (this.dirty && !this.conflicted()) return this.protect()
      return
    }
    this.protecting = this.persist()
    try { await this.protecting } finally { this.protecting = undefined }
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty) { event.preventDefault(); event.returnValue = '' }
  }
  private startNetwork() {
    if (!this.stopped && !this.disposed)
      this.networkTimer ??= setInterval(() => { void this.synchronize() }, NETWORK_MAX_WAIT_MS)
  }
  async leave(): Promise<void> { await this.protect(); if (this.dirty) return this.leave() }
  suspend() {
    this.stopped = true
    if (this.networkTimer) clearInterval(this.networkTimer)
    this.networkTimer = undefined
  }
  resume() {
    if (this.disposed || !this.stopped) return
    this.stopped = false
    this.denied = false
    this.startNetwork()
    void this.synchronize()
  }
  dispose() {
    this.disposed = true
    this.suspend()
    if (this.localTimer) clearInterval(this.localTimer)
    this.localTimer = undefined
    window.removeEventListener('beforeunload', this.beforeUnload)
    this.clearListeners()
  }
}
