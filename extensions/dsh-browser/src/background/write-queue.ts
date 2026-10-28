// A read does not compete for the browser's write lease. Unknown future tools
// default to serialization until they are explicitly classified as read-only.
const READ_ONLY_TOOLS = new Set(['browser_snapshot', 'browser_get_text', 'browser_wait', 'browser_list_tabs'])

export function needsWriteTurn(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name)
}

/** In-memory, single-browser write ordering. It is not a durable receipt ledger. */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly capacity = 128) {}

  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error('Browser action was cancelled while queued'))
    if (this.pending >= this.capacity) return Promise.reject(new Error('Browser write queue is full; wait for existing actions to finish'))
    this.pending += 1
    let started = false
    const turn = this.tail.then(async () => {
      if (signal.aborted) throw new Error('Browser action was cancelled while queued')
      started = true
      return await work()
    })
    // A cancelled waiter must not release the next write before the preceding
    // committed operation settles, even though it can report cancellation now.
    this.tail = turn.then(() => { this.pending -= 1 }, () => { this.pending -= 1 })
    return new Promise<T>((resolve, reject) => {
      // Once work starts, its owner must wait for it to settle. Revocation may
      // not finish while a started operation is still unwinding.
      const cancel = (): void => { if (!started) reject(new Error('Browser action was cancelled while queued')) }
      if (signal.aborted) cancel()
      else signal.addEventListener('abort', cancel, { once: true })
      void turn.then(resolve, reject).finally(() => { signal.removeEventListener('abort', cancel) })
    })
  }
}
