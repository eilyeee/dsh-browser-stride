/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC dispatch, per-connection event pump, and tool-call dispatch to the
 * connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE the /api trust
 * fence (which only guards the client-connection routes), so the bridge brings
 * its own authentication: a bearer token presented in the `hello` frame within
 * HELLO_TIMEOUT_MS. Host calls terminate at the bridge-owned Host adapter.
 * The bridge is loopback-only. Host management methods require a separate,
 * explicit Host configuration in addition to the bearer token.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserHostApi } from './host-api.ts'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { SessionPurgeError } from './session-purge.ts'
import { verifyToken } from './token.ts'
import type { PairingStore } from './pairing.ts'

/**
 * Host management methods that must not be granted by browser pairing alone.
 */
const PRIVILEGED_METHODS = new Set([
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Reject DNS rebinding and user-controlled non-local authorities. */
export function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === 'string' && (/^127\.0\.0\.1(?::\d{1,5})?$/.test(host) || /^\[::1\](?::\d{1,5})?$/.test(host))
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** When provided, the administrator token is never accepted as a browser credential. */
  pairing?: PairingStore
  /** Explicit Host-side opt-in for settings, credentials and local paths. */
  allowHostManagement?: boolean
  /** Active dsh Host adapter used for unary calls, events, and waterfalls. */
  api: BrowserHostApi
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Permanently delete one session's durable storage. Callers archive the
   * session through the gateway first; this only removes files.
   */
  purgeSession: (sessionId: string) => Promise<void>
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Seconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  installationId?: string
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
  /** Ordered requests belong to this connection, never to its replacement. */
  orderedSessionRpcs: Map<string, Promise<void>>
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  /* v8 ignore next -- teardown race: the socket can die between a pump's
  readiness check and this write; the guard refuses writes on dead sockets */
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    if (!isLoopbackAddress(remote) || !isLoopbackHost(req.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pump BEFORE replaceConnection nulls the connection.
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        /* v8 ignore next -- acceptor close cannot fail: close() is idempotent
        and the noServer acceptor only reports teardown of already-terminated clients */
        if (error === undefined) resolve()
        /* v8 ignore next -- same unreachable arm */
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  /** Disconnect a revoked installation immediately after the revocation commits. */
  revokeInstallation(installationId: string): void {
    if (this.current?.installationId === installationId) this.replaceConnection()
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined): void {
    let authenticating = false
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        if (authenticating) {
          ws.close(1008, 'authentication in progress')
          return
        }
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        authenticating = true
        // Origin headers are not credentials: a local process can forge them.
        const authentication: Promise<{ credential?: string } | undefined> = this.deps.pairing === undefined
          ? Promise.resolve(verifyToken(this.deps.token, frame.token) ? {} : undefined)
          : this.deps.pairing.authenticate(frame.installationId ?? '', frame.token)
        void authentication.then((result) => {
          if (result === undefined) {
            ws.close(4002, 'bad credential')
            return
          }
          if (helloTimer === undefined || ws.readyState !== WebSocket.OPEN) return
          clearTimeout(helloTimer)
          helloTimer = undefined
          this.promote(ws, remoteAddress, frame.installationId, result.credential)
        }, () => { ws.close(1011, 'authentication unavailable') })
        return
      }
      const conn = this.current
      if (conn === null || conn.ws !== ws || conn.abort.signal.aborted) return
      this.handleReadyFrame(frame, conn)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, remoteAddress: string | undefined, installationId?: string, credential?: string): void {
    this.replaceConnection()
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const frame of this.deps.api.events(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame,
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
          // An authenticated socket without its Remote streams is unusable but
          // otherwise appears healthy to the extension. Closing the generation
          // activates its bounded reconnect loop and rebuilds every follower.
          ws.close(1011, 'event stream failed')
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping, orderedSessionRpcs: new Map(),
      ...(installationId === undefined ? {} : { installationId }) }
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps, ...(credential === undefined ? {} : { credential }) })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame, conn: ReadyConnection): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame, conn)
        break
      case 'respond':
        void this.handleRespond(frame, conn)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>, conn: ReadyConnection): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame, conn)
      return
    }
    const previous = conn.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame, conn),
      () => this.handleRpc(frame, conn),
    )
    conn.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (conn.orderedSessionRpcs.get(sessionId) === task) conn.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>, conn: ReadyConnection): Promise<void> {
    // An ordered call may have waited while another connection replaced its
    // owner. It must never borrow the new connection's identity or signal.
    if (this.current !== conn || conn.abort.signal.aborted) return
    const management = PRIVILEGED_METHODS.has(frame.method)
      || frame.method.startsWith('settings.') || frame.method.startsWith('credentials.')
    const forbidden = management && this.deps.allowHostManagement !== true
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'host management is not enabled in the Host configuration' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    if (frame.method === BRIDGE_SESSION_PURGE_METHOD) {
      const sessionId = purgeSessionPayload(frame.payload)
      if (sessionId === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId must be a non-empty string' },
        })
        return
      }
      try {
        await this.deps.purgeSession(sessionId)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { purged: true } })
      } catch (error: unknown) {
        const code = error instanceof SessionPurgeError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code, message } })
      }
      return
    }
    try {
      const result = await this.deps.api.call({
        rpcId: frame.id,
        method: frame.method,
        payload: frame.payload,
        signal: conn.abort.signal,
      })
      sendFrame(conn.ws, {
        t: 'rpc.result',
        id: frame.id,
        ok: true,
        result: { type: 'server-response', rpcId: frame.id, result },
      })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** Relay a pending Host waterfall response through the active adapter. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>, conn: ReadyConnection): Promise<void> {
    if (this.current !== conn || conn.abort.signal.aborted) return
    try {
      const result = await this.deps.api.respond(frame.rpcId, frame.result, conn.abort.signal)
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function purgeSessionPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  return sessionId
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}
