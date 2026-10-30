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

import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { BrowserHostApi } from './host-api.ts'
import { canonicalize, makeActionId } from './contracts/ids.ts'
import { toolCommandMaterial } from './tool-identity.ts'
import type { ToolActionIdentity } from './protocol.ts'
import { transportReceipt, type BrowserDispatchLedger, type DispatchSettlement } from './dispatch-ledger.ts'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_SESSION_PURGE_METHOD,
  BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  isReadOnlyBrowserTool,
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
  /** Production always provides the durable ledger; optional for transport-only unit fixtures. */
  dispatches?: Pick<BrowserDispatchLedger, 'prepare' | 'markSent' | 'settle' | 'get'>
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
  action: ToolActionIdentity
  finish: (settlement: DispatchSettlement, value: unknown, error?: BridgeToolError) => void
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  connectionId: string
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
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  private disposal: Promise<void> | undefined

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
    let copied: Record<string, unknown>
    try { copied = JSON.parse(canonicalize(args)) as Record<string, unknown> }
    catch { throw new BridgeToolError('bad-args', 'browser arguments must be plain JSON data') }
    if (this.deps.dispatches === undefined) {
      const actionId = makeActionId()
      const requestDigest = createHash('sha256').update(toolCommandMaterial({ actionId, name, args: copied,
        ...(sessionId === undefined ? {} : { sessionId }) })).digest('hex')
      return this.sendTool(conn, id, name, copied, signal, expiresAt, { actionId, requestDigest }, sessionId)
    }
    return this.track(this.recordAndSend(conn, id, name, copied, signal, expiresAt, sessionId))
  }

  private async recordAndSend(conn: ReadyConnection, id: string, name: string, args: Record<string, unknown>, signal: AbortSignal, expiresAt: number, sessionId?: string): Promise<unknown> {
    const ledger = this.deps.dispatches!
    let action: ToolActionIdentity
    try {
      const prepared = await ledger.prepare({ requestId: id, connectionId: conn.connectionId,
        name, args, expiresAt, ...(sessionId === undefined ? {} : { sessionId }),
        ...(conn.installationId === undefined ? {} : { installationId: conn.installationId }) })
      if (prepared.state !== 'prepared' || prepared.identityVersion !== 2) throw new Error('request already consumed or incompatible')
      action = { actionId: prepared.actionId, requestDigest: prepared.requestDigest }
      let stopped = this.beforeDispatch(conn, signal, expiresAt)
      if (stopped !== undefined) {
        await ledger.settle(id, { state: 'not_sent', reason: stopped.reason })
        throw stopped.error
      }
      // Conservative crash boundary: persistence commits before socket.send.
      // A crash between these two operations is unresolved, never safe to retry.
      await ledger.markSent(id)
      stopped = this.beforeDispatch(conn, signal, expiresAt)
      if (stopped !== undefined) {
        await ledger.settle(id, { state: 'not_sent', reason: stopped.reason })
        throw stopped.error
      }
    } catch (error) {
      if (error instanceof BridgeToolError) throw error
      throw new BridgeToolError('internal', 'browser dispatch could not be durably recorded; no action was sent')
    }
    return this.sendTool(conn, id, name, args, signal, expiresAt, action, sessionId)
  }

  private beforeDispatch(conn: ReadyConnection, signal: AbortSignal, expiresAt: number): { reason: 'cancelled' | 'expired' | 'connection-closed'; error: BridgeToolError } | undefined {
    if (signal.aborted) return { reason: 'cancelled', error: new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch') }
    if (this.closed || this.current !== conn || conn.ws.readyState !== WebSocket.OPEN) return { reason: 'connection-closed', error: new BridgeToolError('bridge-closed', 'extension connection changed before dispatch') }
    if (Date.now() >= expiresAt) return { reason: 'expired', error: new BridgeToolError('timeout', 'browser action expired before dispatch') }
    return undefined
  }

  private sendTool(conn: ReadyConnection, id: string, name: string, args: Record<string, unknown>, signal: AbortSignal, expiresAt: number, action: ToolActionIdentity, sessionId?: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const pending: PendingTool = { action, finish: (settlement, value, error) => {
        if (this.pendingTools.get(id) !== pending) return
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        this.track((async () => {
          try {
            await this.deps.dispatches?.settle(id, settlement)
            if (error === undefined) resolve(value)
            else reject(error)
          } catch {
            reject(new BridgeToolError('internal', 'browser receipt could not be durably recorded; the action result may be unknown'))
          }
        })())
      } }
      const cancel = (reason: 'cancelled' | 'expired', error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        const message = isReadOnlyBrowserTool(name) ? error : new BridgeToolError(error.code, `${error.message}; the action may have started, check the page before another write`)
        pending.finish({ state: 'unresolved', reason }, undefined, message)
      }
      const onAbort = (): void => {
        cancel('cancelled', new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel('expired', new BridgeToolError('timeout', `browser action "${name}" timed out`))
      }, Math.max(0, expiresAt - Date.now()))
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, pending)
      const frame = JSON.stringify({
        t: 'tool.call',
        id,
        action,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame)
      try { conn.ws.send(frame, (error) => {
        /* v8 ignore next -- teardown race: when the write fails, the socket's
        close handler settles the same call with the same code; the callback
        path is a defensive second settle, covered via the close path */
        if (error != null) {
          pending.finish({ state: 'unresolved', reason: 'send-failed' }, undefined, new BridgeToolError('bridge-closed', 'bridge socket failed; delivery may be unknown'))
        }
      }) } catch {
        pending.finish({ state: 'unresolved', reason: 'send-failed' }, undefined, new BridgeToolError('bridge-closed', 'bridge socket failed; delivery may be unknown'))
      }
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  close(): Promise<void> {
    return this.disposal ??= this.closeServer()
  }

  private async closeServer(): Promise<void> {
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
    while (this.operations.size > 0) await Promise.allSettled([...this.operations])
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
      if (ws.readyState !== WebSocket.OPEN) return
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
        // Check compatibility before consuming a pairing code or replacing the
        // current connection. A rejected peer acquires no authority.
        if (frame.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          const upgrade = frame.protocolVersion !== undefined && frame.protocolVersion > BRIDGE_PROTOCOL_VERSION ? 'host' : 'extension'
          sendFrame(ws, { t: 'error', code: `protocol-upgrade-${upgrade}`,
            message: `Incompatible browser bridge protocol. Update the ${upgrade} and build Bridge and extension from the same checkout.` })
          ws.close(PROTOCOL_MISMATCH_CLOSE_CODE, 'incompatible protocol')
          return
        }
        const caps: BridgeCaps = {
          textOnly: true,
          snapshotMaxChars: Math.min(this.deps.caps.snapshotMaxChars, frame.caps.snapshotMaxChars),
          maxInteractiveItems: Math.min(this.deps.caps.maxInteractiveItems, frame.caps.maxInteractiveItems),
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
          this.promote(ws, remoteAddress, caps, frame.installationId, result.credential)
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
  private promote(ws: WebSocket, remoteAddress: string | undefined, caps: BridgeCaps, installationId?: string, credential?: string): void {
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
    this.current = { connectionId: randomUUID(), ws, remoteAddress, abort, pump, ping, orderedSessionRpcs: new Map(),
      ...(installationId === undefined ? {} : { installationId }) }
    sendFrame(ws, { t: 'hello.ok', protocolVersion: BRIDGE_PROTOCOL_VERSION, caps, ...(credential === undefined ? {} : { credential }) })
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
        this.settleTool(conn, frame.id, frame.action, frame.ok, frame.ok ? frame.result : frame.error)
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

  private settleTool(conn: ReadyConnection, id: string, action: ToolActionIdentity, ok: boolean, payload: unknown): void {
    const settlement: DispatchSettlement = { state: 'returned', receipt: transportReceipt(ok, ok ? undefined : payloadCode(payload)) }
    const pending = this.pendingTools.get(id)
    if (pending !== undefined) {
      if (pending.action.actionId !== action.actionId || pending.action.requestDigest !== action.requestDigest) return
      pending.finish(settlement, payload, ok ? undefined : new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
    } else {
      // A late result may settle transport uncertainty, but cannot resurrect
      // the old caller or cross into a replacement connection's authority.
      let row
      try { row = this.deps.dispatches?.get(id) } catch { return }
      if (row?.connectionId === conn.connectionId && row.state === 'unresolved'
        && row.actionId === action.actionId && row.requestDigest === action.requestDigest) {
        void this.track(this.deps.dispatches!.settle(id, settlement)).catch(() => {})
      }
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
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
    for (const pending of this.pendingTools.values()) {
      pending.finish({ state: 'unresolved', reason: 'connection-closed' }, undefined,
        new BridgeToolError('bridge-closed', 'the extension connection was replaced; action delivery may be unknown'))
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
