/** Deny-only handoff fence. Page/model messages can never acknowledge it. */
export const NATIVE_TAKEOVER_KEY = 'dshNativeTakeover'
interface Storage {
  get(key: string): Promise<Record<string, unknown>>
  set(value: Record<string, unknown>): Promise<void>
}
export class NativeTakeoverFence {
  readonly ready: Promise<void>
  private loaded = false
  private faulted = false
  private tabs = new Set<number>()
  private sessions = new Set<string>()
  private acknowledgements = new Map<number, Set<string>>()
  private tabEpochs = new Map<number, object>()
  private sessionEpochs = new Map<string, object>()
  private pendingAcknowledgements = new Map<string, object>()
  private persistence = Promise.resolve()
  constructor(private storage: Storage, private capacity = 5000) {
    this.ready = storage.get(NATIVE_TAKEOVER_KEY).then(value => {
      const stored = value[NATIVE_TAKEOVER_KEY]
      if (stored !== undefined) {
        if (typeof stored !== 'object' || stored === null) throw Error('invalid fence')
        const row = stored as { tabs?: unknown; sessions?: unknown }
        if (!Array.isArray(row.tabs) || !Array.isArray(row.sessions) || row.tabs.length + row.sessions.length > capacity
          || row.tabs.some(id => !Number.isSafeInteger(id) || id < 0)
          || row.sessions.some(id => typeof id !== 'string' || id.length > 200)) throw Error('invalid fence')
        for (const id of row.tabs) this.tabs.add(id)
        for (const id of row.sessions) this.sessions.add(id)
      }
      this.loaded = true
    }).catch(() => { this.faulted = true })
  }
  private persist(): Promise<void> {
    this.persistence = this.persistence.then(async () => {
      await this.ready
      if (this.faulted || this.tabs.size + this.sessions.size > this.capacity) throw Error('takeover-fence-unavailable')
      await this.storage.set({ [NATIVE_TAKEOVER_KEY]: { tabs: [...this.tabs], sessions: [...this.sessions] } })
    }).catch(() => { this.faulted = true })
    return this.persistence
  }
  block(tabId: number, sessions: readonly (string | undefined)[]): void {
    this.tabs.add(tabId); this.tabEpochs.set(tabId, {}); this.acknowledgements.delete(tabId)
    for (const session of sessions) { const id = session ?? ''; this.sessions.add(id); this.sessionEpochs.set(id, {}) }
    void this.persist()
  }
  /** Call only after a fresh native group selection or explicit task continuation. */
  async acknowledge(tabId: number, session?: string): Promise<boolean> {
    await this.ready
    if (this.faulted) return false
    const id = session ?? ''
    if (!this.tabs.has(tabId) && !this.sessions.has(id)) return true
    if ((this.acknowledgements.get(tabId)?.size ?? 0) >= this.capacity && !this.acknowledgements.get(tabId)?.has(id)) { this.faulted = true; return false }
    const epoch = {}, tabEpoch = this.tabEpochs.get(tabId)
    this.pendingAcknowledgements.set(id, epoch)
    this.sessions.delete(id); this.sessionEpochs.set(id, epoch)
    let acknowledgements = this.acknowledgements.get(tabId)
    if (acknowledgements === undefined) { acknowledgements = new Set(); this.acknowledgements.set(tabId, acknowledgements) }
    acknowledgements.add(id)
    await this.persist()
    const current = !this.faulted && this.pendingAcknowledgements.get(id) === epoch
      && this.sessionEpochs.get(id) === epoch && this.tabEpochs.get(tabId) === tabEpoch
    if (this.pendingAcknowledgements.get(id) === epoch) this.pendingAcknowledgements.delete(id)
    return current
  }
  status(session?: string, tabId?: number): 'handoff-required' | 'unavailable' | undefined {
    if (this.faulted) return 'unavailable'
    if (!this.loaded) return undefined
    return this.pendingAcknowledgements.has(session ?? '') || this.sessions.has(session ?? '')
      || (tabId !== undefined && this.tabs.has(tabId) && !this.acknowledgements.get(tabId)?.has(session ?? '')) ? 'handoff-required' : undefined
  }
  capture(session?: string, tabId?: number): () => boolean {
    const id = session ?? ''
    const sessionEpoch = this.sessionEpochs.get(id), tabEpoch = tabId === undefined ? undefined : this.tabEpochs.get(tabId)
    return () => this.loaded && !this.faulted && this.sessionEpochs.get(id) === sessionEpoch
      && (tabId === undefined || this.tabEpochs.get(tabId) === tabEpoch)
      && !this.pendingAcknowledgements.has(id) && !this.sessions.has(id)
      && (tabId === undefined || !this.tabs.has(tabId) || this.acknowledgements.get(tabId)?.has(id) === true)
  }
}
