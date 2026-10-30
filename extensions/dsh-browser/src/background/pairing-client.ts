import { BRIDGE_PAIRING_REQUEST_PATH, BRIDGE_PROTOCOL_VERSION } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { localBridgeUrl } from './bridge-address.ts'

export interface BrowserPairingStatus {
  phase: 'idle' | 'requesting' | 'pending' | 'saving' | 'saved' | 'failed'
  verificationCode?: string
  hostUrl?: string
  error?: string
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = (): void => { clearTimeout(timer); reject(new Error('pairing-cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1_000)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Runs only in the trusted background. Neither proof nor credential goes to the panel. */
export async function requestBrowserPairing(
  bridgeUrl: string,
  installationId: string,
  signal: AbortSignal,
  pending: (status: BrowserPairingStatus) => void,
  fetchImpl: typeof fetch = fetch,
  wait: (signal: AbortSignal) => Promise<void> = pause,
): Promise<string> {
  const local = localBridgeUrl(bridgeUrl)
  if (local === undefined) throw new Error('invalid-host')
  const url = new URL(local.replace(/^ws:/, 'http:'))
  url.pathname = BRIDGE_PAIRING_REQUEST_PATH
  const hostUrl = url.origin + '/'
  const proofKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
  let requestId: string | undefined
  let claimed = false
  const post = async (payload: object, activeSignal = signal): Promise<Record<string, unknown>> => {
    activeSignal.throwIfAborted()
    const response = await fetchImpl(url.toString(), {
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.any([activeSignal, AbortSignal.timeout(5_000)]),
    })
    let result: Record<string, unknown>
    try { result = await response.json() as Record<string, unknown> } catch { throw new Error('update-host') }
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('invalid-response')
    if (!response.ok) {
      const known = ['protocol-upgrade-host', 'protocol-upgrade-extension', 'pairing-busy', 'pairing-unavailable']
      throw new Error(typeof result.error === 'string' && known.includes(result.error) ? result.error : 'host-unavailable')
    }
    return result
  }
  try {
    const request = await post({ action: 'request', protocolVersion: BRIDGE_PROTOCOL_VERSION, installationId, proofKey })
    if (typeof request.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.requestId)
      || typeof request.verificationCode !== 'string' || !/^[A-F0-9]{8}$/.test(request.verificationCode)
      || typeof request.expiresAt !== 'number' || !Number.isSafeInteger(request.expiresAt)
      || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 5 * 60_000) throw new Error('invalid-response')
    requestId = request.requestId
    pending({ phase: 'pending', verificationCode: request.verificationCode, hostUrl })
    while (Date.now() < request.expiresAt) {
      await wait(signal)
      const result = await post({ action: 'claim', requestId, proofKey })
      signal.throwIfAborted()
      if (result.status === 'denied') throw new Error('pairing-denied')
      if (result.status === 'paired' && typeof result.credential === 'string' && /^[a-f0-9]{64}$/.test(result.credential)) {
        claimed = true
        return result.credential
      }
      if (result.status !== 'pending') throw new Error('invalid-response')
    }
    throw new Error('pairing-unavailable')
  } finally {
    if (requestId !== undefined && !claimed) {
      await post({ action: 'cancel', requestId, proofKey }, AbortSignal.timeout(1_000)).catch(() => {})
    }
  }
}
