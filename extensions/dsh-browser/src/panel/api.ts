/**
 * Panel ↔ background port client. The panel never touches the bridge or the
 * gateway directly; everything goes through the service worker's port.
 *
 * @module
 */

import type { BridgeCaps, RespondResult } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import type { Settings } from '../background/index.ts'
import type { TabAffinityDecision, TabAffinityState } from '../background/tab-affinity.ts'
import type { ApprovalDecision, ApprovalRequest } from '../security/approval.ts'
import { parsePageSelection, type PageSelection } from '../selection.ts'
import { getUiLocale } from '../i18n.ts'
import type { BrowserPairingStatus } from '../background/pairing-client.ts'

/** Panel-side subset of the extension settings. */
export type PanelSettings = Settings

interface RpcFailurePayload {
  code?: unknown
  message?: unknown
  details?: unknown
}

interface RpcResultMessage {
  type: 'rpc.result'
  id: string
  ok: boolean
  result?: unknown
  error?: RpcFailurePayload
}

interface RespondResultMessage {
  type: 'respond.result'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

interface SettingsResultMessage {
  type: 'settings.result'
  id: string
  ok: boolean
  error?: { message?: unknown }
}

interface StatusMessage {
  type: 'status'
  state: BridgeState
  caps: BridgeCaps | null
  connectionDisconnected?: boolean
  hasCredential?: boolean
}

interface EventMessage {
  type: 'event'
  frame: ServerFrame
}

interface ApprovalRequestMessage {
  type: 'approval.request'
  request: ApprovalRequest
}

interface ApprovalResolvedMessage {
  type: 'approval.resolved'
  id: string
}

interface TabAffinityMessage {
  type: 'tab-affinity'
  state: TabAffinityState
}

interface TabAffinityRebindResultMessage {
  type: 'tab-affinity.rebind.result'
  id: string
  ok: boolean
  error?: { code: string; message: string }
}

interface SelectionMessage {
  type: 'selection'
  selection: unknown
}

interface SessionResumeHintMessage {
  type: 'session.resume-hint'
  sessionId: string | null
}

export interface PageAccessStatus { activeGranted: boolean; controlledGranted: boolean; controlledTabId: number | null }

type BackgroundMessage = ({ type: 'page-access' } & PageAccessStatus) | RpcResultMessage | RespondResultMessage | SettingsResultMessage | (Omit<SettingsResultMessage, 'type'> & { type: 'browser-pairing.unpair.result' | 'page-access.revoke.result' }) | StatusMessage | EventMessage | ApprovalRequestMessage | ApprovalResolvedMessage | TabAffinityMessage | TabAffinityRebindResultMessage | (Omit<TabAffinityRebindResultMessage, 'type'> & { type: 'browser-run.retarget.result' | 'tab-affinity.unbind.result' }) | SelectionMessage | SessionResumeHintMessage | { type: 'browser-pairing'; status: BrowserPairingStatus }

/** Structured gateway failure retained for product-level error handling. */
export class PanelRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown = {},
  ) {
    super(message)
    this.name = 'PanelRpcError'
  }
}

function panelRpcError(failure: RpcFailurePayload | undefined, fallbackMessage: string): PanelRpcError {
  return new PanelRpcError(
    typeof failure?.code === 'string' ? failure.code : 'rpc-failed',
    typeof failure?.message === 'string' ? failure.message : fallbackMessage,
    failure?.details ?? {},
  )
}

/** The panel API surface. */
export interface PanelApi {
  startBrowserPairing(bridgeUrl: string): Promise<void>
  cancelBrowserPairing(): Promise<void>
  unpairBrowser(): Promise<void>
  onPageAccess(callback: (status: PageAccessStatus) => void): () => void
  revokePageAccess(tabId: number): Promise<void>
  onBrowserPairing(callback: (status: BrowserPairingStatus) => void): () => void
  rpc<T = unknown>(method: string, payload?: unknown): Promise<T>
  respond(rpcId: string, result: RespondResult): Promise<unknown>
  onStatus(callback: (state: BridgeState, caps: BridgeCaps | null, connection?: { connectionDisconnected?: boolean; hasCredential?: boolean }) => void): () => void
  onEvent(callback: (frame: ServerFrame) => void): () => void
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void
  onApprovalResolved(callback: (id: string) => void): () => void
  onTabAffinity(callback: (state: TabAffinityState) => void): () => void
  onSelection(callback: (selection: PageSelection | null) => void): () => void
  onSessionResumeHint(callback: (sessionId: string | null) => void): () => void
  respondToApproval(id: string, decision: ApprovalDecision): Promise<void>
  resolveTabAffinity(revision: number, decision: TabAffinityDecision, sessionId: string | null): Promise<void>
  retargetRun(payload: { runId: string; sessionId: string; expectedVersion: number; controlRevision: number; affinityRevision: number; start?: boolean; task?: boolean }): Promise<void>
  rebindTabAffinity(): Promise<void>
  unbindTabAffinity(revision: number, sessionId: string | null): Promise<void>
  /** Clear all selection state, or only the exact selection supplied. */
  clearSelection(selection?: PageSelection): Promise<void>
  /** Scope this panel's selections to its own browser window. */
  registerWindow(windowId: number): Promise<void>
  setActiveSession(sessionId: string, isNew?: boolean): Promise<void>
  updateSettings(settings: Partial<PanelSettings>): Promise<void>
  requestStatus(): Promise<void>
}

/** Connect to the background service worker and return the panel API. */
export function connectPanel(): PanelApi {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const pendingResponses = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const pendingSettings = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const pendingRebinds = new Map<string, {
    resolve: () => void
    reject: (error: Error) => void
  }>()
  const pageAccessListeners = new Set<(status: PageAccessStatus) => void>()
  const statusListeners = new Set<Parameters<PanelApi['onStatus']>[0]>()
  const pairingListeners = new Set<(status: BrowserPairingStatus) => void>()
  const eventListeners = new Set<(frame: ServerFrame) => void>()
  const approvalListeners = new Set<(request: ApprovalRequest) => void>()
  const approvalResolvedListeners = new Set<(id: string) => void>()
  const tabAffinityListeners = new Set<(state: TabAffinityState) => void>()
  const selectionListeners = new Set<(selection: PageSelection | null) => void>()
  const sessionResumeHintListeners = new Set<(sessionId: string | null) => void>()

  let port: chrome.runtime.Port | null = null
  let reconnectPromise: Promise<chrome.runtime.Port> | null = null

  function onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const msg = message as BackgroundMessage
    switch (msg.type) {
      case 'browser-pairing':
        for (const listener of pairingListeners) listener(msg.status)
        break
      case 'rpc.result': {
        const entry = pending.get(msg.id)
        if (entry === undefined) return
        pending.delete(msg.id)
        // The bridge relays the gateway's ServerResponse envelope verbatim
        // ({ type, rpcId, result: { ok, value | error } }); unwrap the value
        // so callers get the business payload, and surface business errors.
        const envelope = msg.result as { result?: { ok?: boolean; value?: unknown; error?: RpcFailurePayload } } | undefined
        const business = envelope?.result
        if (msg.ok && business?.ok !== false) entry.resolve(business?.value)
        else entry.reject(panelRpcError(
          business?.ok === false ? business.error : msg.error,
          getUiLocale() === 'zh' ? 'RPC 请求失败' : 'RPC request failed',
        ))
        break
      }
      case 'respond.result': {
        const entry = pendingResponses.get(msg.id)
        if (entry === undefined) return
        pendingResponses.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) entry.resolve(msg.result)
        else entry.reject(new Error(msg.error?.message
          ?? (getUiLocale() === 'zh' ? '回答提交失败' : 'Failed to send the answer')))
        break
      }
      case 'page-access.revoke.result':
      case 'browser-pairing.unpair.result':
      case 'settings.result': {
        const entry = pendingSettings.get(msg.id)
        if (entry === undefined) return
        pendingSettings.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new Error(typeof msg.error?.message === 'string'
          ? msg.error.message
          : (getUiLocale() === 'zh' ? '保存设置失败' : 'Failed to save settings')))
        break
      }
      case 'page-access':
        for (const listener of pageAccessListeners) listener(msg)
        break
      case 'status':
        for (const listener of statusListeners) {
          if (msg.connectionDisconnected === undefined && msg.hasCredential === undefined) listener(msg.state, msg.caps)
          else listener(msg.state, msg.caps, { connectionDisconnected: msg.connectionDisconnected, hasCredential: msg.hasCredential })
        }
        break
      case 'event':
        for (const listener of eventListeners) listener(msg.frame)
        break
      case 'approval.request':
        for (const listener of approvalListeners) listener(msg.request)
        break
      case 'approval.resolved':
        for (const listener of approvalResolvedListeners) listener(msg.id)
        break
      case 'tab-affinity':
        for (const listener of tabAffinityListeners) listener(msg.state)
        break
      case 'selection': {
        // The page owns this text; validate it again on the way into the UI.
        const selection = parsePageSelection(msg.selection)
        for (const listener of selectionListeners) listener(selection)
        break
      }
      case 'browser-run.retarget.result':
      case 'tab-affinity.unbind.result':
      case 'tab-affinity.rebind.result': {
        const entry = pendingRebinds.get(msg.id)
        if (entry === undefined) return
        pendingRebinds.delete(msg.id)
        if (msg.ok) entry.resolve()
        else entry.reject(new PanelRpcError(msg.error?.code ?? 'handoff-failed', msg.error?.message
          ?? (getUiLocale() === 'zh' ? '无法绑定当前标签页' : 'Failed to bind the current tab')))
        break
      }
      case 'session.resume-hint':
        for (const listener of sessionResumeHintListeners) listener(msg.sessionId)
        break
    }
  }

  function connectionError(cause?: unknown): Error {
    const fallback = getUiLocale() === 'zh' ? '后台连接已断开' : 'Background connection lost'
    return cause instanceof Error ? cause : new Error(fallback)
  }

  function failAll(error: Error, preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'settings'; id: string }): void {
    for (const listener of pairingListeners) listener({ phase: 'failed', error: 'connection-lost' })
    for (const [id, entry] of pending) {
      if (preserve?.kind === 'rpc' && preserve.id === id) continue
      entry.reject(error)
      pending.delete(id)
    }
    for (const [id, entry] of pendingResponses) {
      if (preserve?.kind === 'respond' && preserve.id === id) continue
      clearTimeout(entry.timer)
      entry.reject(error)
      pendingResponses.delete(id)
    }
    for (const [id, entry] of pendingRebinds) {
      if (preserve?.kind === 'rebind' && preserve.id === id) continue
      entry.reject(error)
      pendingRebinds.delete(id)
    }
    for (const [id, entry] of pendingSettings) {
      if (preserve?.kind === 'settings' && preserve.id === id) continue
      entry.reject(error)
      pendingSettings.delete(id)
    }
  }

  function attach(next: chrome.runtime.Port): chrome.runtime.Port {
    port = next
    next.onMessage.addListener(onMessage)
    next.onDisconnect.addListener(() => {
      if (port !== next) return
      port = null
      failAll(connectionError())
      // Firefox event pages and extension reloads can invalidate a live Port.
      // Reconnect once while the panel is still open; later sends share the
      // same attempt instead of opening competing ports.
      void ensurePort(150).catch(() => {})
    })
    return next
  }

  function ensurePort(delayMs = 0): Promise<chrome.runtime.Port> {
    if (port !== null) return Promise.resolve(port)
    if (reconnectPromise !== null) return reconnectPromise

    const attempt = new Promise<void>((resolve) => { setTimeout(resolve, delayMs) })
      .then(() => port ?? attach(chrome.runtime.connect({ name: 'dsh-panel' })))
    reconnectPromise = attempt
    void attempt.then(
      () => { if (reconnectPromise === attempt) reconnectPromise = null },
      () => { if (reconnectPromise === attempt) reconnectPromise = null },
    )
    return attempt
  }

  function invalidate(
    stale: chrome.runtime.Port,
    error: Error,
    preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'settings'; id: string },
  ): void {
    if (port !== stale) return
    port = null
    failAll(error, preserve)
  }

  /**
   * Post once on the live port. Calls made during reconnect wait for the shared
   * replacement; a synchronous stale-port failure retries only the message
   * that is known not to have been accepted. Requests already accepted by the
   * old port are rejected by invalidate() and are never replayed.
   */
  function send(
    message: unknown,
    preserve?: { kind: 'rpc' | 'respond' | 'rebind' | 'settings'; id: string },
  ): Promise<void> {
    const current = port
    if (current !== null) {
      try {
        current.postMessage(message)
        return Promise.resolve()
      } catch (cause) {
        invalidate(current, connectionError(cause), preserve)
      }
    }

    return ensurePort(150).then((next) => {
      try {
        next.postMessage(message)
      } catch (cause) {
        const error = connectionError(cause)
        invalidate(next, error)
        throw error
      }
    })
  }

  try {
    attach(chrome.runtime.connect({ name: 'dsh-panel' }))
  } catch {
    void ensurePort(150).catch(() => {})
  }

  return {
    onPageAccess(callback) { pageAccessListeners.add(callback); return () => { pageAccessListeners.delete(callback) } },
    revokePageAccess(tabId) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pendingSettings.delete(id); reject(new PanelRpcError('timeout', 'Page access revocation was not confirmed')) }, 10000)
        const entry = { resolve: () => { clearTimeout(timer); resolve() }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
        pendingSettings.set(id, entry)
        void send({ type: 'page-access.revoke', id, tabId }, { kind: 'settings', id }).catch((error: unknown) => {
          if (pendingSettings.get(id) !== entry) return
          pendingSettings.delete(id); entry.reject(connectionError(error))
        })
      })
    },
    startBrowserPairing(bridgeUrl) { return send({ type: 'browser-pairing.start', bridgeUrl }) },
    cancelBrowserPairing() { return send({ type: 'browser-pairing.cancel' }) },
    unpairBrowser() {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { pendingSettings.delete(id); reject(new PanelRpcError('timeout', getUiLocale() === 'zh' ? '解绑结果尚未确认，请核对连接状态' : 'Unpairing was not confirmed. Check the connection status.')) }, 15000)
        const entry = { resolve: () => { clearTimeout(timer); resolve() }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
        pendingSettings.set(id, entry)
        void send({ type: 'browser-pairing.unpair', id }, { kind: 'settings', id }).catch((error: unknown) => {
          if (pendingSettings.get(id) !== entry) return
          pendingSettings.delete(id); entry.reject(connectionError(error))
        })
      })
    },
    onBrowserPairing(callback) { pairingListeners.add(callback); return () => { pairingListeners.delete(callback) } },
    rpc<T>(method: string, payload?: unknown): Promise<T> {
      const id = crypto.randomUUID()
      return new Promise<T>((resolve, reject) => {
        const entry = { resolve: (value: unknown) => resolve(value as T), reject }
        pending.set(id, entry)
        void send(
          { type: 'rpc', id, method, payload },
          { kind: 'rpc', id },
        ).catch((error: unknown) => {
          if (pending.get(id) !== entry) return
          pending.delete(id)
          reject(connectionError(error))
        })
      })
    },
    respond(rpcId, result) {
      const id = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(id)
          reject(new Error(getUiLocale() === 'zh' ? '回答提交超时，请重试' : 'Sending the answer timed out. Try again.'))
        }, 35_000)
        const entry = { resolve, reject, timer }
        pendingResponses.set(id, entry)
        void send(
          { type: 'respond', id, rpcId, result },
          { kind: 'respond', id },
        ).catch((error: unknown) => {
          if (pendingResponses.get(id) !== entry) return
          pendingResponses.delete(id)
          clearTimeout(timer)
          reject(connectionError(error))
        })
      })
    },
    onStatus(callback) {
      statusListeners.add(callback)
      return () => { statusListeners.delete(callback) }
    },
    onEvent(callback) {
      eventListeners.add(callback)
      return () => { eventListeners.delete(callback) }
    },
    onApprovalRequest(callback) {
      approvalListeners.add(callback)
      return () => { approvalListeners.delete(callback) }
    },
    onApprovalResolved(callback) {
      approvalResolvedListeners.add(callback)
      return () => { approvalResolvedListeners.delete(callback) }
    },
    onTabAffinity(callback) {
      tabAffinityListeners.add(callback)
      return () => { tabAffinityListeners.delete(callback) }
    },
    onSelection(callback) {
      selectionListeners.add(callback)
      return () => { selectionListeners.delete(callback) }
    },
    onSessionResumeHint(callback) {
      sessionResumeHintListeners.add(callback)
      return () => { sessionResumeHintListeners.delete(callback) }
    },
    respondToApproval(id, decision) {
      return send({ type: 'approval.response', id, decision })
    },
    resolveTabAffinity(revision, decision, sessionId) {
      return send({ type: 'tab-affinity.response', revision, decision, sessionId })
    },
    retargetRun(payload) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRebinds.delete(id)
          reject(new PanelRpcError('timeout', 'Task target change was not confirmed; refresh its status.'))
        }, 17_000)
        const entry = { resolve: () => { clearTimeout(timer); resolve() }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
        pendingRebinds.set(id, entry)
        void send({ type: 'browser-run.retarget', id, ...payload }, { kind: 'rebind', id }).catch((cause: unknown) => {
          if (pendingRebinds.get(id) !== entry) return
          pendingRebinds.delete(id)
          entry.reject(connectionError(cause))
        })
      })
    },
    rebindTabAffinity() {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingRebinds.set(id, entry)
        void send(
          { type: 'tab-affinity.rebind', id },
          { kind: 'rebind', id },
        ).catch((cause: unknown) => {
          if (pendingRebinds.get(id) !== entry) return
          pendingRebinds.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    unbindTabAffinity(revision, sessionId) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRebinds.delete(id)
          reject(new PanelRpcError('timeout', getUiLocale() === 'zh' ? '解绑结果未确认，请核对页面绑定状态' : 'Unbinding was not confirmed. Check the page binding.'))
        }, 10000)
        const entry = { resolve: () => { clearTimeout(timer); resolve() }, reject: (error: Error) => { clearTimeout(timer); reject(error) } }
        pendingRebinds.set(id, entry)
        void send({ type: 'tab-affinity.unbind', id, revision, sessionId }, { kind: 'rebind', id }).catch((error: unknown) => {
          if (pendingRebinds.get(id) !== entry) return
          pendingRebinds.delete(id); entry.reject(connectionError(error))
        })
      })
    },
    clearSelection(selection) {
      return send({ type: 'selection.clear', ...(selection === undefined ? {} : { selection }) })
    },
    registerWindow(windowId) {
      return send({ type: 'panel.window', windowId })
    },
    setActiveSession(sessionId, isNew) {
      return send({ type: 'session.active', sessionId, isNew })
    },
    updateSettings(next) {
      const id = crypto.randomUUID()
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject }
        pendingSettings.set(id, entry)
        void send(
          { type: 'settings', id, settings: next },
          { kind: 'settings', id },
        ).catch((cause: unknown) => {
          if (pendingSettings.get(id) !== entry) return
          pendingSettings.delete(id)
          reject(connectionError(cause))
        })
      })
    },
    requestStatus() {
      return send({ type: 'request-status' })
    },
  }
}
