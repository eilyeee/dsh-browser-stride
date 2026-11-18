/** Stop waiting while still observing the native reply if it arrives later. */
export function waitForReply<T>(reply: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    void reply.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
      else resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/** Bound reads or preparation only. Never release a dispatched write this way. */
export async function readWithin<T>(timeoutMs: number, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const timeout = new Error('Chrome did not respond while reading the page.')
  if (timeoutMs <= 0) throw timeout
  const controller = new AbortController()
  const bounded = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs)
  try { return await waitForReply(read(bounded), bounded) }
  finally { clearTimeout(timer) }
}
