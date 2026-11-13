/** Runs in an isolated extension panel. Never returns credentials or page content. */
export function configurePanelConnection({ bridgeUrl, pairingCode, origin, timeoutMs, deferred }) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'dsh-panel' })
    window.__dshBenchmarkPort = port
    const id = crypto.randomUUID()
    const diagnostics = { settingsSaved: false, states: [] }
    let connected = false, settled = false
    const finish = (error) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      port.onMessage.removeListener(receive); port.onDisconnect.removeListener(disconnected)
      if (error) { port.disconnect(); reject(error) } else resolve(diagnostics)
    }
    const check = () => { if (diagnostics.settingsSaved && (deferred || connected)) finish() }
    const disconnected = () => finish(new Error('extension connection port disconnected'))
    const receive = message => {
      if (message?.type === 'settings.result' && message.id === id) {
        if (!message.ok) return finish(new Error('extension settings were rejected'))
        diagnostics.settingsSaved = true; check(); return
      }
      if (message?.type !== 'status') return
      const known = ['connecting', 'connected', 'reconnecting', 'stopped', 'update-host', 'update-extension', 'incompatible']
      if (!known.includes(message.state)) return
      const currentHost = message.hostIdentity === bridgeUrl
      diagnostics.states.push({ state: message.state, currentHost })
      if (diagnostics.states.length > 16) diagnostics.states.shift()
      // A different auto-discovered Host must not satisfy this fixture's handshake.
      connected = message.state === 'connected' && currentHost
      check()
    }
    const timer = setTimeout(() => finish(new Error(`extension bridge connection timed out: ${JSON.stringify(diagnostics)}`)), timeoutMs)
    port.onMessage.addListener(receive); port.onDisconnect.addListener(disconnected)
    try {
      port.postMessage({ type: 'settings', id, settings: {
        bridgeUrl, ...(pairingCode === undefined ? {} : { token: pairingCode }), sharePageContent: 'auto',
        trustedActionOrigins: [origin], approvalNotifications: false, autoResumeSession: false,
      } })
    } catch { finish(new Error('extension settings could not be sent')) }
  })
}

/** Test-worker diagnostics only. Observe outcomes, never sent frames or credentials. */
export function installConnectionProbe() {
  const records = globalThis.__strideConnectionDiagnostics = []
  const record = value => { records.push(value); if (records.length > 24) records.shift() }
  const NativeSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args)
      const url = new URL(String(args[0]))
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return
      const port = url.port
      record({ event: 'created', port })
      this.addEventListener('open', () => record({ event: 'open', port }))
      this.addEventListener('error', () => record({ event: 'error', port }))
      this.addEventListener('close', event => record({ event: 'close', port, code: event.code }))
      this.addEventListener('message', event => {
        try {
          const frame = JSON.parse(String(event.data))
          if (frame.t === 'hello.ok') record({ event: 'accepted', port })
          else if (frame.t === 'error') record({ event: 'rejected', port,
            code: typeof frame.code === 'string' && /^[a-z][a-z-]{0,47}$/.test(frame.code) ? frame.code : 'unknown' })
        } catch { /* not a handshake frame */ }
      })
    }
  }
}

/** Parent-side deadline also applies when a renderer's own timer is throttled. */
export async function within(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
