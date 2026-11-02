/**
 * Background service worker entry: owns the bridge connection, the gateway
 * RPC client, controlled-tab tool dispatch, and the panel port service.
 *
 * MV3 survival: after the user opens the panel, its port plus a half-minute
 * `alarms` keepalive re-arm the reconnect loop. Merely loading the extension
 * never probes or claims the single-connection bridge.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', id, settings: Partial<Settings> }
 *   panel → bg: { type: 'session.active', sessionId }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'tab-affinity.response', revision, decision, sessionId }
 *   panel → bg: { type: 'tab-affinity.rebind', id }
 *   panel → bg: { type: 'tab-affinity.unbind', id, revision, sessionId }
 *   panel → bg: { type: 'panel.window', windowId }
 *   panel → bg: { type: 'selection.clear', selection? }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'settings.result', id, ok, error? }
 *   bg → panel: { type: 'status', state: BridgeState, caps? }
 *   bg → panel: { type: 'event', frame: ServerFrame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *   bg → panel: { type: 'session.resume-hint', sessionId }
 *   bg → panel: { type: 'selection', selection }
 *   bg → panel: { type: 'tab-affinity', state }
 *   bg → panel: { type: 'tab-affinity.rebind.result', id, ok, error? }
 *   bg → panel: { type: 'tab-affinity.unbind.result', id, ok, error? }
 *
 * @module
 */

import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  BRIDGE_CONFIRM_TOOL_METHOD,
  BRIDGE_RUN_RETARGET_METHOD,
  BRIDGE_RUN_LIST_METHOD,
  BRIDGE_TASK_START_METHOD,
  BRIDGE_TASK_APPROVAL_METHOD,
  isPageBrowserTool,
  isRunTabMutation,
  isRespondResult,
  type BridgeCaps,
  type RespondResult,
} from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { ServerFrame } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { BRIDGE_CONFIG_PATH, BRIDGE_PATH } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { readBridgeCredential, readBridgeDisconnected, writeBridgeCredential } from './credential-store.ts'
import { needsWriteTurn, WriteQueue } from './write-queue.ts'
import { executeRecordedTool } from './execution-receipts.ts'
import { ToolExecutionFence } from './execution-authority.ts'
import { PageAccess } from './page-access.ts'
import { RunTargetRegistry, type RunTargetBinding } from './run-targets.ts'
import { localBridgeUrl } from './bridge-address.ts'
import { requestBrowserPairing, revokeBrowserPairing, type BrowserPairingStatus } from './pairing-client.ts'
import { createRpc, BridgeRpcError } from './rpc.ts'
import { TargetLeaseRegistry, type ToolTargetLease, type ToolTargetIdentity } from './target-leases.ts'
import {
  dispatchOpenTab,
  dispatchToolCall,
  forgetTabSnapshot,
  isNavigationCandidateTool,
  isTabManagementTool,
  resetTabSnapshot,
  type ToolAnswer,
} from './tools.ts'
import {
  isApprovalDecision,
  type ApprovalAuthorization,
  type ApprovalPrompt,
  type ApprovalRequest,
} from '../security/approval.ts'
import { getUiLocale } from '../i18n.ts'
import { InteractionResponseRouter } from './responses.ts'
import {
  actionCoveredByTrustedOrigins,
  normalizeTrustedOrigin,
} from '../security/trusted-origins.ts'
import { TransientEventCache } from './transient-events.ts'
import {
  TabAffinityController,
  isTabAffinityDecision,
  type AffinityTab,
  type TabAffinityDecision,
} from './tab-affinity.ts'
import { bindOpenedTabAffinity } from './open-tab-binding.ts'
import { FocusedWindowTracker } from './focused-window.ts'
import { SelectionTracker, type SelectionSource } from './selection.ts'
import { parsePageSelection, parseSelectionCapture } from '../selection.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'
import {
  LEGACY_RECENT_SESSION_STORAGE_KEY,
  PAGE_SESSION_CONTEXT_STORAGE_KEY,
  PageSessionContextTracker,
} from './session-continuity.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
  /** Skip confirmations only within explicitly authorized tabs. */
  unrestrictedBrowserAccess: boolean
  /** Origins whose state-changing actions may run without another prompt. */
  trustedActionOrigins: string[]
  /** Show an OS notification when no side panel can display an approval. */
  approvalNotifications: boolean
  /** Restore the current tab and page path's conversation when the panel reopens. */
  autoResumeSession: boolean
}

const SETTINGS_DEFAULTS: Settings = {
  // 空地址 = 自动探测本机 dsh（零配置）；手动填地址时优先手动。
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
  unrestrictedBrowserAccess: false,
  trustedActionOrigins: [],
  approvalNotifications: true,
  autoResumeSession: true,
}

/**
 * 自动探测的候选端口：
 * - dsh web（CLI）默认 3080，端口被占时依次回退 3081 / 3090；
 * - DSH Desktop 默认由系统随机分配本地 Web 端口（`dsh-desktop.port: 0`），
 *   用户指南推荐固定为 43189（见 deepseek-harness-desktop docs/user-guide）；
 * - 14389 为历史桌面应用端口，保留兼容旧版。
 */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

/** 探测本机 dsh 的桥地址：fetch /ext/bridge-config 直到成功。 */
async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      const expected = localBridgeUrl(`ws://127.0.0.1:${port}${BRIDGE_PATH}`)
      const discovered = typeof body.wsUrl === 'string' ? localBridgeUrl(body.wsUrl) : undefined
      if (discovered !== undefined && discovered === expected) return discovered
    } catch {
      // 该端口没有 dsh 或未挂桥：试下一个。
    }
  }
  return undefined
}

/** Avoid opening a noisy loopback WebSocket until the local bridge responds. */
async function probeBridge(url: string): Promise<boolean> {
  try {
    const target = new URL(url)
    target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'
    target.pathname = BRIDGE_CONFIG_PATH
    target.search = ''
    target.hash = ''
    const response = await fetch(target, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const body = await response.json() as { wsUrl?: unknown }
    return typeof body.wsUrl === 'string' && localBridgeUrl(body.wsUrl) === localBridgeUrl(url)
  } catch {
    return false
  }
}

const STORAGE_KEY = 'dshSettings'
const INSTALLATION_KEY = 'dshBridgeInstallationId'
const TAB_AFFINITY_STORAGE_KEY = 'dshTabAffinity'
const DETACHED_SESSIONS_STORAGE_KEY = 'dshDetachedSessions'

type StoredTabAffinity = { detached?: true; detachedSessions?: string[] } & (
  | { controlledTabId: number; keptActiveTabId?: number; pinned?: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string }
  | { lost: true; sessionTabs?: Record<string, AffinityTab>; focusedSessionId?: string })

let settings: Settings = { ...SETTINGS_DEFAULTS }
let connectionDisconnected = false
let connectionControlRevision = 0
let unpairing = false
let activeBridgeUrl: string | undefined
let activePairing: { url: string; credential: string; installationId: string } | undefined
let activeInstallationId = ''
let unrestrictedAccessActive = SETTINGS_DEFAULTS.unrestrictedBrowserAccess
let unrestrictedAccessRevision = 0
let pageSharingRevision = 0
let unrestrictedRevocation: Promise<void> | undefined
let settingsPersistence = Promise.resolve()
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
/** Invalidates an asynchronous discovery attempt when its panel lease ends. */
let bridgeStartRevision = 0
const interactionResponses = new InteractionResponseRouter()
const transientEvents = new TransientEventCache()
const tabAffinity = new TabAffinityController()
const targetLeases = new TargetLeaseRegistry()
const runTargets = new RunTargetRegistry()
const focusedWindow = new FocusedWindowTracker()
const selections = new SelectionTracker()
const pageAccess = new PageAccess(tabId => {
  if (tabId !== undefined) {
    forgetTarget(tabId)
    resetTabSnapshot(tabId)
    broadcastSelections(selections.clearTab(tabId))
    for (const call of unsettledToolCalls) if (call.targetLease?.target.tabId === tabId) {
      call.executionFence?.revoke()
      call.revocationRequested = true
      if (!call.committed) call.controller.abort()
    }
    for (const sid of tabAffinity.sessionIdsForTab(tabId)) cancelPendingApprovals(sid)
  }
  broadcastPageAccess()
  syncSelectionWatch()
})
const pageSessionContexts = new PageSessionContextTracker({
  read: async () => (await chrome.storage.session.get(PAGE_SESSION_CONTEXT_STORAGE_KEY))[PAGE_SESSION_CONTEXT_STORAGE_KEY],
  write: async (value) => {
    await chrome.storage.session.set({ [PAGE_SESSION_CONTEXT_STORAGE_KEY]: value })
  },
})
void chrome.storage.session.remove(LEGACY_RECENT_SESSION_STORAGE_KEY).catch(() => {})
/** Ephemeral allowlist: cleared when the last side panel closes or this worker restarts. */
const sessionTrustedActionOrigins = new Set<string>()
/** Tool calls that are either withdrawable or completing an already-dispatched action. */
interface ActiveToolCall {
  sessionId?: string
  executionFence?: ToolExecutionFence
  managed: boolean
  targetLease?: ToolTargetLease
  controller: AbortController
  unrestrictedAccess: boolean
  committed: boolean
  revocationRequested: boolean
  settled: Promise<void>
  settle: () => void
}

const activeToolCalls = new Map<string, ActiveToolCall>()
const writeQueue = new WriteQueue()
/** Disconnection drops result ownership, but dispatched operations must still settle before revocation. */
const unsettledToolCalls = new Set<ActiveToolCall>()
let lastPersistedAffinity: string | undefined
let lastPersistedDetachment: string | undefined
let affinityPersistence = Promise.resolve()
/** Per-session snapshot refreshes preserve prompt ordering without cross-session cancellation. */
const sessionSnapshotRefreshes = new Map<string, Promise<void>>()
interface ActiveFollowRefresh {
  controller: AbortController
  unrestrictedAccess: boolean
  settled: Promise<void>
  settle: () => void
}

const activeFollowRefreshes = new Map<string, ActiveFollowRefresh>()
const unbindingSessions = new Set<string>()
const TAB_AFFINITY_REBIND_TIMEOUT_MS = 10_000

class TabAffinityRebindError extends Error {
  constructor(readonly code: 'no-active-tab' | 'timeout' | 'cancelled' | 'page-access-required', message: string) {
    super(message)
    this.name = 'TabAffinityRebindError'
  }
}

function rebindAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new TabAffinityRebindError('cancelled', getUiLocale() === 'zh' ? '标签页绑定已取消' : 'Tab binding was cancelled')
}

function throwIfRebindAborted(signal: AbortSignal): void {
  if (signal.aborted) throw rebindAbortReason(signal)
}

/** Reject promptly on cancellation while safely consuming a late Chrome promise. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rebindAbortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(rebindAbortReason(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(rebindAbortReason(signal))
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function loadSettings(): Promise<Settings> {
  // Restrict other settings where the browser supports it. The credential is
  // separately stored in extension-origin IndexedDB on every browser.
  if (typeof chrome.storage.local.setAccessLevel === 'function') {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const previous = stored[STORAGE_KEY] as Partial<Settings> | undefined
  connectionDisconnected = await readBridgeDisconnected()
  let credential = connectionDisconnected ? undefined : await readBridgeCredential()
  if (!connectionDisconnected && credential === undefined && typeof previous?.token === 'string' && previous.token !== '') {
    credential = previous.token
    await writeBridgeCredential(credential)
  }
  const loaded = normalizeSettings({ ...SETTINGS_DEFAULTS, ...previous, token: credential ?? '' })
  const { token: _secret, ...publicSettings } = loaded
  if (previous !== undefined && 'token' in previous) await chrome.storage.local.set({ [STORAGE_KEY]: publicSettings })
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL || loaded.bridgeUrl === `${LEGACY_LOCAL_URL}/`) {
    loaded.bridgeUrl = ''
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...publicSettings, bridgeUrl: '' } })
  }
  return loaded
}

async function persistSettings(next: Partial<Settings>, enableConnection = false): Promise<void> {
  if (next.token !== undefined && unpairing) throw new Error('Connection removal is in progress')
  const controlRevision = connectionControlRevision
  const changesUnrestrictedAccess = typeof next.unrestrictedBrowserAccess === 'boolean'
  const accessRevision = changesUnrestrictedAccess ? ++unrestrictedAccessRevision : unrestrictedAccessRevision
  const updated = normalizeSettings({ ...settings, ...next })
  const revokesUnrestrictedAccess = settings.unrestrictedBrowserAccess && !updated.unrestrictedBrowserAccess
  if (settings.sharePageContent !== updated.sharePageContent || revokesUnrestrictedAccess) pageSharingRevision += 1
  settings = updated
  if (!updated.unrestrictedBrowserAccess) unrestrictedAccessActive = false
  syncSelectionWatch()
  let accessTransition: Promise<void> | undefined
  if (revokesUnrestrictedAccess) {
    let trackedRevocation!: Promise<void>
    trackedRevocation = revokeUnrestrictedAccess().finally(() => {
      if (unrestrictedRevocation !== trackedRevocation) return
      unrestrictedRevocation = undefined
      syncSelectionWatch()
    })
    unrestrictedRevocation = trackedRevocation
    accessTransition = trackedRevocation
  } else if (unrestrictedRevocation !== undefined) {
    accessTransition = unrestrictedRevocation
  }
  const persisted = updated
  const write = settingsPersistence.then(async () => {
    await accessTransition
    if (next.token !== undefined) {
      if (controlRevision !== connectionControlRevision || unpairing) throw new Error('Connection settings were superseded')
      await writeBridgeCredential(persisted.token, enableConnection ? 'enable' : undefined,
        () => controlRevision === connectionControlRevision && !unpairing)
      if (enableConnection && controlRevision === connectionControlRevision && !unpairing) {
        const resume = connectionDisconnected
        connectionDisconnected = false
        if (resume && panelPorts.size > 0) armBridgeKeepalive()
      }
    }
    const { token: _secret, ...publicSettings } = persisted
    await chrome.storage.local.set({ [STORAGE_KEY]: publicSettings })
  })
  settingsPersistence = write.catch(() => {})
  await write
  if (changesUnrestrictedAccess
    && accessRevision === unrestrictedAccessRevision
    && settings.unrestrictedBrowserAccess
    && persisted.unrestrictedBrowserAccess
    && unrestrictedRevocation === undefined) {
    unrestrictedAccessActive = true
    syncSelectionWatch()
  }
}

function normalizeSettings(candidate: Settings): Settings {
  const trusted = Array.isArray(candidate.trustedActionOrigins)
    ? [...new Set(candidate.trustedActionOrigins.map(normalizeTrustedOrigin).filter((entry): entry is string => entry !== undefined))].sort()
    : []
  const sharePageContent = candidate.sharePageContent === 'auto' || candidate.sharePageContent === 'off'
    ? candidate.sharePageContent
    : candidate.sharePageContent === 'ask' ? 'ask' : 'auto'
  return {
    ...candidate,
    sharePageContent,
    unrestrictedBrowserAccess: candidate.unrestrictedBrowserAccess === true,
    trustedActionOrigins: trusted,
    approvalNotifications: candidate.approvalNotifications !== false,
    autoResumeSession: candidate.autoResumeSession !== false,
  }
}

/** Settings load is shared by every lazy connection trigger. */
let settingsLoaded = false
const settingsReady = loadSettings().then((loaded) => {
  settings = loaded
  unrestrictedAccessActive = loaded.unrestrictedBrowserAccess
  settingsLoaded = true
})

// The identifier belongs to this extension installation, not a tab or session.
// Share the in-flight write so concurrent panel starts cannot create two IDs.
let installationIdPromise: Promise<string> | undefined
function ensureInstallationId(): Promise<string> {
  if (installationIdPromise === undefined) {
    installationIdPromise = (async () => {
      const stored = await chrome.storage.local.get(INSTALLATION_KEY)
      const existing: unknown = stored[INSTALLATION_KEY]
      if (typeof existing === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(existing)) return existing
      const id = crypto.randomUUID()
      await chrome.storage.local.set({ [INSTALLATION_KEY]: id })
      return id
    })().catch((error: unknown) => { installationIdPromise = undefined; throw error })
  }
  return installationIdPromise
}

function armBridgeKeepalive(): void {
  chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void Promise.resolve(chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM)).catch(() => {})
}

function broadcastStatus(): void {
  const payload = { type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps,
    connectionDisconnected, hasCredential: settings.token !== '' }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastPageAccess(): void {
  const state = tabAffinity.snapshot()
  const message = { type: 'page-access', activeGranted: pageAccess.has(state.active?.tabId),
    controlledGranted: pageAccess.has(state.controlled?.tabId), controlledTabId: state.controlled?.tabId ?? null,
    revocableTabId: pageAccess.has(state.controlled?.tabId) ? state.controlled!.tabId : pageAccess.has(state.active?.tabId) ? state.active!.tabId : null }
  for (const port of panelPorts) { try { port.postMessage(message) } catch { /* closed */ } }
}

function broadcastTabAffinity(): void {
  broadcastPageAccess()
  const payload = { type: 'tab-affinity', state: tabAffinity.snapshot() }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

/** Which window each panel port belongs to, so a quote stays in its window. */
const panelWindows = new WeakMap<chrome.runtime.Port, number>()
/** The conversation each live panel is displaying, used for close checkpoints. */
const panelActiveSessions = new WeakMap<chrome.runtime.Port, string>()

/**
 * Send one window's selection to that window's panels only.
 *
 * A panel must never be offered a quote from a page its own window is not
 * looking at, which also keeps an incognito window's highlight out of a
 * normal window's composer.
 */
function broadcastSelection(windowId: number): void {
  const payload = { type: 'selection', selection: selections.current(windowId) }
  for (const port of panelPorts) {
    if (panelWindows.get(port) !== windowId) continue
    try { port.postMessage(payload) } catch { /* port already closed */ }
  }
}

function broadcastSelections(windowIds: readonly number[]): void {
  for (const windowId of windowIds) broadcastSelection(windowId)
}

/** Whether a window currently has a panel that can display its selection. */
function hasPanelInWindow(windowId: number): boolean {
  for (const port of panelPorts) {
    if (panelWindows.get(port) === windowId) return true
  }
  return false
}

/**
 * Tell a frame its quote is gone so re-selecting the same passage reports it
 * again; the content script deduplicates against the last text it sent.
 */
function resetSelectionDedupe(sources: readonly SelectionSource[]): void {
  for (const { tabId, frameId } of sources) {
    void Promise.resolve(chrome.tabs.sendMessage(
      tabId,
      { type: 'DSH_SELECTION_RESET' },
      { frameId },
    ))
      .catch(() => { /* no content script in this tab */ })
  }
}

/** Whether saved privacy settings currently allow page-selection capture. */
function selectionSharingEnabled(): boolean {
  // Until storage answers, `settings` still holds the defaults. Reporting the
  // default here would arm watchers for a user whose saved choice is `off`.
  return settingsLoaded && !connectionDisconnected && !unpairing && (unrestrictedAccessEnabled() || settings.sharePageContent !== 'off')
}

/** Whether unrestricted access is enabled and no earlier grant is still being revoked. */
function unrestrictedAccessEnabled(): boolean {
  return unrestrictedAccessActive && unrestrictedRevocation === undefined
}

/** Page selections are captured only in a window with an open panel. */
function selectionWatchEnabled(windowId: number): boolean {
  return selectionSharingEnabled() && hasPanelInWindow(windowId)
}

let selectionWatchArmed = false
/** Distinguishes revisions issued by different MV3 worker lifetimes. */
const selectionWatchEpoch = crypto.randomUUID()
/** Orders arm/disarm commands so a slow delivery cannot undo a newer one. */
let selectionWatchRevision = 0

/**
 * Arm or disarm every content script. `selectionchange` fires on each drag in
 * each tab, so the watcher stays off until a panel can actually show a quote.
 *
 * Delivery is asynchronous, so each command carries a revision: a panel that
 * closes and reopens quickly must not leave watchers in the state of whichever
 * `tabs.query` happened to resolve last.
 */
function syncSelectionWatch(): void {
  const anyEnabled = selectionSharingEnabled()
    && [...panelPorts].some((port) => panelWindows.get(port) !== undefined)
  const wasArmed = selectionWatchArmed
  selectionWatchArmed = anyEnabled
  const revision = ++selectionWatchRevision
  if (wasArmed && !anyEnabled) {
    resetSelectionDedupe(selections.sourcesWithSelection())
    broadcastSelections(selections.clearAll())
  }
  void Promise.resolve(chrome.tabs.query({})).then((tabs) => {
    if (revision !== selectionWatchRevision) return
    for (const tab of tabs) {
      if (tab.id === undefined || !pageAccess.has(tab.id)) continue
      const enabled = selectionWatchEnabled(tab.windowId)
      void Promise.resolve(chrome.tabs.sendMessage(tab.id, {
        type: 'DSH_SELECTION_WATCH',
        enabled,
        epoch: selectionWatchEpoch,
        revision,
      }))
        .catch(() => { /* no content script in this tab */ })
    }
  }).catch(() => {})
}

/**
 * Accept a capture from the page the user is actually looking at.
 *
 * `sender.tab` already carries the tab's window, active state, and incognito
 * flag, so admission needs no `chrome.tabs` call: a background page cannot
 * make the worker query Chrome by moving its own selection in a loop.
 */
function recordSelection(tab: chrome.tabs.Tab, frameId: number, value: unknown): void {
  if (!selectionWatchEnabled(tab.windowId)) return
  // Only the tab the user is looking at, in its own window, may set a quote.
  if (tab.id === undefined || tab.active !== true) return
  const capture = parseSelectionCapture(value)
  if (capture === null) return
  if (selections.capture({ windowId: tab.windowId, tabId: tab.id, frameId }, capture)) {
    broadcastSelection(tab.windowId)
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* port already closed */ }
  }
}

function broadcastApprovalResolved(id: string): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* port already closed */ }
  }
}

const APPROVAL_NOTIFICATION_PREFIX = 'dsh-browser-approval:'

function approvalNotificationId(id: string): string {
  return `${APPROVAL_NOTIFICATION_PREFIX}${id}`
}

function deliverApproval(request: ApprovalRequest): boolean {
  let delivered = false
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: 'approval.request', request })
      delivered = true
    } catch { /* port already closed */ }
  }
  return delivered
}

function notifyApproval(request: ApprovalRequest, _windowId: number): void {
  if (!settings.approvalNotifications) return
  const copy = getUiLocale() === 'zh'
    ? {
        title: '浏览器操作等待确认',
        message: '点击通知打开 dsh 浏览器助手，并在 60 秒内确认或拒绝。',
      }
    : {
        title: 'Browser action awaiting approval',
        message: 'Click to open dsh Browser Assistant, then allow or deny within 60 seconds.',
      }
  void Promise.resolve(chrome.notifications.create(approvalNotificationId(request.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title: copy.title,
    message: copy.message,
    requireInteraction: true,
  })).catch(() => {})
}

function clearApprovalNotification(id: string): void {
  void Promise.resolve(chrome.notifications.clear(approvalNotificationId(id))).catch(() => {})
}

const approvals = new ApprovalCoordinator({
  deliver: deliverApproval,
  notify: notifyApproval,
  clearNotification: clearApprovalNotification,
  resolved: broadcastApprovalResolved,
})

function responseMessages(): { unavailable: string; timeout: string; duplicate: string; disconnected: string } {
  return getUiLocale() === 'zh'
    ? {
        unavailable: '未连接 dsh，无法提交回答',
        timeout: '提交回答超时，请重试',
        duplicate: '回答请求编号重复，请重试',
        disconnected: 'dsh 连接已断开，请重新连接后再试',
      }
    : {
        unavailable: 'dsh is not connected, so the answer could not be sent',
        timeout: 'Sending the answer timed out. Try again.',
        duplicate: 'The answer request ID was duplicated. Try again.',
        disconnected: 'The dsh connection was lost. Reconnect and try again.',
      }
}

function cancelPendingApprovals(sessionId?: string): void {
  approvals.cancelAll(sessionId)
}

function revokeStaleTargetCalls(): void {
  for (const call of activeToolCalls.values()) {
    if (!call.committed && call.targetLease?.current() === false) call.controller.abort()
  }
}

function invalidateSessionTarget(sessionId?: string): void {
  targetLeases.invalidateSession(sessionId)
  // An explicit session handoff also changes the global, unattributed target.
  if (sessionId !== undefined) targetLeases.invalidateSession()
  revokeStaleTargetCalls()
}

function invalidateDocumentTarget(tabId: number): void {
  targetLeases.invalidateDocument(tabId)
  revokeStaleTargetCalls()
}

function forgetTarget(tabId: number): void {
  targetLeases.forgetTab(tabId)
  revokeStaleTargetCalls()
}

function selectedTargetIdentity(sessionId?: string): ToolTargetIdentity | undefined {
  const selected = tabAffinity.resolveTarget(sessionId)
  const tab = selected.kind === 'target' ? selected.tab
    : selected.kind === 'initial' ? tabAffinity.snapshot().active : null
  return tab === null ? undefined : { tabId: tab.tabId, windowId: tab.windowId, url: tab.url }
}

const pageAccessFailure = (): ToolAnswer => ({ ok: false, error: { code: 'content-unavailable', message: 'This page has not been authorized. Open it and click the DSH Stride toolbar icon to grant temporary access to this tab.' } })

const staleTarget = (): ToolAnswer => ({ ok: false, error: { code: 'action-failed',
  message: 'The browser target or execution authority changed after this request arrived. Its result cannot be used; observe the selected page before a new action.' } })

/** Pin before receipt storage, approvals or the write queue can await anything. */
function captureToolTarget(sessionId?: string): ToolTargetLease | ToolAnswer {
  const selected = tabAffinity.resolveTarget(sessionId)
  if (selected.kind === 'handoff' || selected.kind === 'lost') return affinityFailure(selected.kind)
  const target = selectedTargetIdentity(sessionId)
  if (target !== undefined && !pageAccess.has(target.tabId)) return pageAccessFailure()
  return target === undefined ? affinityFailure('missing') : targetLeases.capture(sessionId, target, () => selectedTargetIdentity(sessionId))
}

async function prepareToolTarget(lease: ToolTargetLease, sessionId: string | undefined, signal: AbortSignal): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  if (signal.aborted || !lease.current()) return staleTarget()
  let tab: chrome.tabs.Tab
  try { tab = await chrome.tabs.get(lease.target.tabId) } catch { return affinityFailure('lost') }
  if (signal.aborted || !lease.current() || tab.id !== lease.target.tabId) return staleTarget()
  if (tab.windowId !== lease.target.windowId || (tab.url ?? '') !== lease.target.url) {
    // Refresh native metadata for a future request, never retarget this one.
    if (tab.windowId !== lease.target.windowId) forgetTarget(lease.target.tabId)
    else invalidateDocumentTarget(lease.target.tabId)
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    return staleTarget()
  }
  if (!pageAccess.allows(tab)) return pageAccessFailure()
  if (tab.status === 'loading' || tab.pendingUrl !== undefined) return staleTarget()
  // An initial, unattributed call may establish only the target it received.
  // Duplicates never reach here because execution admission happens first.
  if (tabAffinity.resolveTarget(sessionId).kind === 'initial') {
    const summary = summarizeTab(tab)
    if (summary === null || !tabAffinity.bindInitial(summary, sessionId)) return staleTarget()
    persistTabAffinity()
    broadcastTabAffinity()
  }
  return lease.current() && tabAffinity.allowsTarget(lease.target.tabId, sessionId) ? tab : staleTarget()
}

function summarizeTab(tab: chrome.tabs.Tab): AffinityTab | null {
  if (tab.id === undefined) return null
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
  }
}

function storedAffinity(): StoredTabAffinity | null {
  const state = tabAffinity.snapshot()
  const sessionTabs = tabAffinity.sessionMap()
  const hasSessionTabs = Object.keys(sessionTabs).length > 0
  const focusedSessionId = tabAffinity.focusedSession()
  const detachedSessions = tabAffinity.detachedSessionIds()
  const focus = { ...(focusedSessionId === null ? {} : { focusedSessionId }),
    ...(detachedSessions.length > 0 ? { detachedSessions } : {}), ...(state.detached ? { detached: true as const } : {}) }
  if (state.controlled !== null) {
    return {
      controlledTabId: state.controlled.tabId,
      ...(state.status === 'background' && state.active !== null
        ? { keptActiveTabId: state.active.tabId }
        : {}),
      ...(state.pinned ? { pinned: true as const } : {}),
      ...(hasSessionTabs ? { sessionTabs } : {}),
      ...focus,
    }
  }
  return state.status === 'lost'
    ? { lost: true, ...(hasSessionTabs ? { sessionTabs } : {}), ...focus }
    : (hasSessionTabs || detachedSessions.length > 0 ? { lost: true, sessionTabs, ...focus } : null)
}

function persistTabAffinity(strict = false): Promise<void> {
  const record = storedAffinity()
  const serialized = JSON.stringify(record)
  if (serialized === lastPersistedAffinity) return affinityPersistence
  lastPersistedAffinity = serialized
  const detached = { sessionIds: tabAffinity.detachedSessionIds(), detached: tabAffinity.snapshot().detached === true }
  const serializedDetachment = JSON.stringify(detached)
  const pending = affinityPersistence.catch(() => {}).then(async () => {
    if (lastPersistedDetachment !== serializedDetachment) {
      await chrome.storage.local.set({ [DETACHED_SESSIONS_STORAGE_KEY]: detached })
      lastPersistedDetachment = serializedDetachment
    }
    if (record === null) await chrome.storage.session.remove(TAB_AFFINITY_STORAGE_KEY)
    else await chrome.storage.session.set({ [TAB_AFFINITY_STORAGE_KEY]: record })
  })
  affinityPersistence = pending.catch(() => {
    if (lastPersistedAffinity === serialized) lastPersistedAffinity = undefined
    lastPersistedDetachment = undefined
  })
  return strict ? pending : affinityPersistence
}

function observeActiveSummary(summary: AffinityTab): void {
  const previousStatus = tabAffinity.snapshot().status
  if (!tabAffinity.observeActive(summary)) return
  revokeStaleTargetCalls()
  if (previousStatus !== 'handoff' && tabAffinity.snapshot().status === 'handoff') {
    const focused = tabAffinity.focusedSession()
    invalidateSessionTarget(focused ?? undefined)
    if (focused !== null) {
      activeFollowRefreshes.get(focused)?.controller.abort()
      cancelPendingApprovals(focused)
    } else {
      cancelPendingApprovals()
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

function observeActiveTab(tab: chrome.tabs.Tab): void {
  const summary = summarizeTab(tab)
  if (summary !== null) observeActiveSummary(summary)
}

async function syncActiveTab(windowId?: number, signal?: AbortSignal): Promise<chrome.tabs.Tab | undefined> {
  const queryRevision = focusedWindow.beginQuery()
  const query = windowId === undefined
    ? { active: true, lastFocusedWindow: true }
    : { active: true, windowId }
  try {
    const tabs = chrome.tabs.query(query)
    const [tab] = signal === undefined ? await tabs : await abortable(tabs, signal)
    if (signal !== undefined) throwIfRebindAborted(signal)
    if (tab === undefined) return undefined
    if (!focusedWindow.commitQuery(tab.windowId, queryRevision)) return undefined
    if (signal !== undefined) throwIfRebindAborted(signal)
    observeActiveTab(tab)
    return tab
  } catch {
    if (signal !== undefined && signal.aborted) throw rebindAbortReason(signal)
    return undefined
  }
}

async function restoreTabAffinity(): Promise<void> {
  await pageAccess.ready
  let record: StoredTabAffinity | null = null
  let durableDetached: { sessionIds?: unknown; detached?: unknown } | undefined
  let durableUnavailable = false
  try {
    await settingsReady
    const local = await chrome.storage.local.get(DETACHED_SESSIONS_STORAGE_KEY)
    durableDetached = local[DETACHED_SESSIONS_STORAGE_KEY] as typeof durableDetached
    if (durableDetached !== undefined && (durableDetached === null || typeof durableDetached !== 'object'
      || !Array.isArray(durableDetached.sessionIds) || durableDetached.sessionIds.some(sid => typeof sid !== 'string' || sid.trim() === '')
      || typeof durableDetached.detached !== 'boolean')) throw new Error('invalid-detachment-state')
    lastPersistedDetachment = JSON.stringify(durableDetached ?? { sessionIds: [], detached: false })
  } catch { durableUnavailable = true }
  try {
    const stored = await chrome.storage.session.get(TAB_AFFINITY_STORAGE_KEY)
    const candidate = stored[TAB_AFFINITY_STORAGE_KEY] as Partial<StoredTabAffinity> | undefined
    const controlledTabId = (candidate as { controlledTabId?: unknown } | undefined)?.controlledTabId
    const focusedSessionId = (candidate as { focusedSessionId?: unknown } | undefined)?.focusedSessionId
    const focus = typeof focusedSessionId === 'string' && focusedSessionId.trim() !== '' ? { focusedSessionId } : {}
    if (typeof controlledTabId === 'number' && Number.isInteger(controlledTabId) && controlledTabId >= 0) {
      const keptActiveTabId = (candidate as { keptActiveTabId?: unknown }).keptActiveTabId
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        controlledTabId,
        ...(typeof keptActiveTabId === 'number' && Number.isInteger(keptActiveTabId) && keptActiveTabId >= 0
          ? { keptActiveTabId }
          : {}),
        ...((candidate as { pinned?: unknown }).pinned === true ? { pinned: true as const } : {}),
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    } else if ((candidate as { lost?: unknown } | undefined)?.lost === true) {
      const sessionTabs = (candidate as { sessionTabs?: Record<string, AffinityTab> }).sessionTabs
      record = {
        lost: true,
        ...(typeof sessionTabs === 'object' && sessionTabs !== null ? { sessionTabs } : {}),
        ...focus,
      }
    }
    if (record !== null) {
      if (candidate?.detached === true) record.detached = true
      if (Array.isArray(candidate?.detachedSessions)) record.detachedSessions = candidate.detachedSessions.filter((sid): sid is string => typeof sid === 'string' && sid.trim() !== '')
    }
    lastPersistedAffinity = candidate === undefined || record !== null
      ? JSON.stringify(record)
      : undefined
  } catch {
    // Session storage is a survival aid, not a reason to disable the bridge.
  }

  if (record?.sessionTabs !== undefined) {
    const restoredSessions: Record<string, AffinityTab> = {}
    for (const [sid, storedTab] of Object.entries(record.sessionTabs)) {
      if (typeof storedTab?.tabId !== 'number' || !Number.isInteger(storedTab.tabId) || storedTab.tabId < 0) continue
      try {
        const live = summarizeTab(await chrome.tabs.get(storedTab.tabId))
        if (live !== null) restoredSessions[sid] = live
      } catch {
        // Closed tabs are deliberately pruned so the session fails closed.
      }
    }
    tabAffinity.restoreSessionTabs(restoredSessions)
  }
  const detachedIds = Array.isArray(durableDetached?.sessionIds) ? durableDetached.sessionIds.filter((sid): sid is string => typeof sid === 'string' && sid.trim() !== '') : record?.detachedSessions ?? []
  tabAffinity.restoreDetachedSessions(detachedIds)
  if (durableUnavailable) tabAffinity.restoreDetachedSessions(Object.keys(tabAffinity.sessionMap()))
  tabAffinity.restoreFocusedSession(record?.focusedSessionId ?? null)

  if (record !== null && 'controlledTabId' in record) {
    try {
      const controlled = summarizeTab(await chrome.tabs.get(record.controlledTabId))
      if (controlled === null) tabAffinity.restoreLost()
      else tabAffinity.restoreControlled(controlled)
    } catch {
      tabAffinity.restoreLost()
    }
  } else if (record?.lost === true) {
    tabAffinity.restoreLost()
  }
  if (durableUnavailable || durableDetached?.detached === true || record?.detached === true) tabAffinity.restoreDetached()

  // Restore the pin before syncing the active tab: otherwise the sync would
  // surface a handoff prompt for a switch the user already said not to ask about.
  if (record !== null && 'pinned' in record && record.pinned === true) tabAffinity.restorePinned()
  await syncActiveTab()
  if (record !== null && 'keptActiveTabId' in record) {
    const state = tabAffinity.snapshot()
    if (state.status === 'handoff' && state.active?.tabId === record.keptActiveTabId) {
      tabAffinity.decide('keep', state.revision)
    }
  }
  persistTabAffinity()
  broadcastTabAffinity()
}

const affinityReady = restoreTabAffinity()

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Refresh one session's recovery checkpoint from its actual controlled tab. */
async function checkpointSessionPage(sessionValue: unknown, isCurrentCall: () => boolean = () => true): Promise<void> {
  const sessionId = validSessionId(sessionValue)
  if (sessionId === undefined || !isCurrentCall()) return
  await Promise.all([affinityReady, pageSessionContexts.ready])
  if (!isCurrentCall()) return
  const bound = tabAffinity.getSessionTab(sessionId)
  if (bound === undefined) return
  // The action may have navigated before this checkpoint started. Pin this
  // phase separately so a later navigation/rebind cannot revive a stale read.
  const checkpointTarget = targetLeases.capture(sessionId, bound, () => selectedTargetIdentity(sessionId))
  if (!checkpointTarget.current()) return
  try {
    const tab = await chrome.tabs.get(bound.tabId)
    if (!isCurrentCall() || !checkpointTarget.current()
      || tab.id !== bound.tabId || tab.windowId !== bound.windowId) return
    pageSessionContexts.bind(sessionId, tab)
  } catch {
    // A concurrently closed tab is cleaned by tabs.onRemoved.
  }
}

/** Resolve the contextual hint only after the panel has identified its window. */
async function postResumeHint(port: chrome.runtime.Port, windowId: number): Promise<void> {
  await pageSessionContexts.ready
  let sessionId: string | null = null
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId })
    if (tab !== undefined && pageAccess.allows(tab)) sessionId = pageSessionContexts.candidate(tab)
  } catch {
    // Without an exact live page the panel must start a new conversation.
  }
  if (!panelPorts.has(port) || panelWindows.get(port) !== windowId) return
  try { port.postMessage({ type: 'session.resume-hint', sessionId }) } catch { /* port closed */ }
}

/** Re-checkpoint each open panel before issuing a bridge-epoch resume hint. */
function refreshPanelResumeHints(): void {
  for (const port of panelPorts) {
    const windowId = panelWindows.get(port)
    if (windowId === undefined) continue
    const sessionId = panelActiveSessions.get(port)
    const checkpoint = sessionId === undefined
      ? Promise.resolve()
      : checkpointSessionPage(sessionId)
    void checkpoint.then(() => postResumeHint(port, windowId), () => postResumeHint(port, windowId))
  }
}

/** Bind at prompt submission so a switch while the model is thinking is visible. */
async function ensureInitialTabBinding(sessionId?: string): Promise<boolean> {
  await affinityReady
  if (tabAffinity.resolveTarget(sessionId).kind !== 'initial') return true
  try {
    const tab = await syncActiveTab()
    const summary = tab === undefined ? null : summarizeTab(tab)
    if (summary === null || tab === undefined || !pageAccess.allows(tab)) return false
    if (tabAffinity.bindInitial(summary, sessionId)) {
      persistTabAffinity()
      broadcastTabAffinity()
    }
    return true
  } catch {
    return false
  }
}

function affinityFailure(kind: 'handoff' | 'lost' | 'missing' | 'detached'): ToolAnswer {
  if (kind === 'detached') return { ok: false, error: { code: 'action-failed', message: 'The user unbound this page. Browser tools cannot rebind it; the user must explicitly select a page in the extension.' } }
  if (kind === 'handoff') {
    return {
      ok: false,
      error: { code: 'action-failed', message: 'The user switched tabs, so browser operations are paused. In the side panel, choose whether to keep the previous page or follow the current page.' },
    }
  }
  if (kind === 'lost') {
    return {
      ok: false,
      error: { code: 'content-unavailable', message: 'The controlled tab was closed. Select the current page in the side panel before retrying.' },
    }
  }
  return { ok: false, error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
}

/** Resolve one stable tab target without allowing a manual switch to drift it. */
async function resolveToolTab(sessionId?: string): Promise<Pick<chrome.tabs.Tab, 'id' | 'url' | 'title' | 'windowId'> | ToolAnswer> {
  await affinityReady
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolution = tabAffinity.resolveTarget(sessionId)
    if (resolution.kind === 'handoff') return affinityFailure('handoff')
    if (resolution.kind === 'lost') return affinityFailure('lost')
    if (resolution.kind === 'initial') {
      if (!await ensureInitialTabBinding(sessionId)) return affinityFailure('missing')
      continue
    }
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      const summary = summarizeTab(tab)
      if (summary === null) return affinityFailure('missing')
      if (tabAffinity.observeTab(summary)) broadcastTabAffinity()
      const current = tabAffinity.resolveTarget(sessionId)
      if (current.kind === 'handoff') return affinityFailure('handoff')
      if (current.kind === 'lost') return affinityFailure('lost')
      if (current.kind === 'target' && current.tab.tabId === summary.tabId) return pageAccess.allows(tab) ? tab : pageAccessFailure()
    } catch {
      const affectedSessions = tabAffinity.sessionIdsForTab(resolution.tab.tabId)
      if (tabAffinity.removeTab(resolution.tab.tabId)) {
        for (const sid of affectedSessions) {
          activeFollowRefreshes.get(sid)?.controller.abort()
          cancelPendingApprovals(sid)
        }
        persistTabAffinity()
        broadcastTabAffinity()
      }
      return affinityFailure('lost')
    }
  }
  return affinityFailure('handoff')
}

/**
 * Pick a window for browser_open_tab without requiring an already-controlled page.
 * Handoff still blocks: the user must finish the keep/follow choice first.
 */
async function resolveOpenTabWindow(sessionId?: string): Promise<{ windowId: number } | ToolAnswer> {
  await affinityReady
  if (tabAffinity.isDetached(sessionId)) return affinityFailure('detached')
  const resolution = tabAffinity.resolveTarget(sessionId)
  if (resolution.kind === 'handoff') return affinityFailure('handoff')
  if (resolution.kind === 'target') {
    try {
      const tab = await chrome.tabs.get(resolution.tab.tabId)
      return { windowId: tab.windowId }
    } catch {
      // Fall through to the focused window when the prior controlled tab is gone.
    }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return { windowId: focused.id }
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (fallback?.windowId !== undefined) return { windowId: fallback.windowId }
  return affinityFailure('missing')
}

function bindOpenedTab(
  tab: chrome.tabs.Tab,
  sessionId: string | undefined,
  isCurrentCall: () => boolean,
  options: { active?: boolean } = {},
): boolean {
  if (!isCurrentCall() || !pageAccess.allows(tab)) return false
  const summary = summarizeTab(tab)
  if (summary === null) return false
  const sid = sessionId?.trim()
  invalidateSessionTarget(sid)
  bindOpenedTabAffinity(tabAffinity, summary, {
    active: options.active,
    sessionId: sid,
  })
  if (sid !== undefined && sid !== '') {
    const binding = targetLeases.capture(sid, summary, () => selectedTargetIdentity(sid))
    void pageSessionContexts.ready.then(() => {
      if (isCurrentCall() && binding.current()) pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
    })
  }
  persistTabAffinity()
  broadcastTabAffinity()
  return true
}

async function authorizeToolCall(
  prompt: ApprovalPrompt,
  signal: AbortSignal,
  windowId: number,
  sessionId?: string,
  unrestrictedAccess: boolean = unrestrictedAccessEnabled(),
  waiting?: (value: boolean) => Promise<void>,
): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  if (unrestrictedAccess) return 'approved'
  if (actionCoveredByTrustedOrigins(
    prompt,
    sessionTrustedActionOrigins,
    settings.trustedActionOrigins,
  )) {
    return 'approved'
  }
  await waiting?.(true)
  let result: ApprovalRequestResult
  try { result = await approvals.request(prompt, signal, windowId, sessionId) }
  finally { await waiting?.(false) }
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  if (decision === 'trust-session' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    sessionTrustedActionOrigins.add(prompt.origins[0]!)
    return 'approved'
  }
  // Retain wire compatibility with panels from the previous build. The new UI
  // manages permanent trust explicitly in Settings instead of offering it in
  // the action dialog.
  if (decision === 'trust-origin' && prompt.kind === 'action' && prompt.canTrust && prompt.origins.length === 1) {
    await persistSettings({ trustedActionOrigins: [...settings.trustedActionOrigins, prompt.origins[0]!] })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Capture the newly controlled tab and seed it into this session's next Agent step. */
async function refreshFollowedPage(sessionId: string, tabId: number): Promise<void> {
  activeFollowRefreshes.get(sessionId)?.controller.abort()
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const activeRefresh: ActiveFollowRefresh = {
    controller,
    unrestrictedAccess,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeFollowRefreshes.set(sessionId, activeRefresh)
  try {
    const target = await resolveToolTab(sessionId)
    if ('ok' in target || target.id !== tabId || controller.signal.aborted) return
    const budget = caps === null
      ? undefined
      : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
    const pageLease = pageAccess.lease(tabId)
    const answer = await dispatchToolCall(
      { id: crypto.randomUUID(), name: 'browser_snapshot', args: {} },
      unrestrictedAccess ? 'auto' : settings.sharePageContent,
      budget,
      (prompt) => authorizeToolCall(prompt, controller.signal, target.windowId, sessionId, unrestrictedAccess),
      controller.signal,
      target,
      () => pageLease() && target.id !== undefined && tabAffinity.allowsTarget(target.id, sessionId),
      { unrestrictedAccess },
    )
    if (!answer.ok || controller.signal.aborted || !pageLease() || !tabAffinity.allowsTarget(tabId, sessionId)) return
    if (typeof answer.result !== 'object' || answer.result === null) return
    const snapshot = (answer.result as { text?: unknown }).text
    if (typeof snapshot !== 'string' || snapshot.trim() === '') return
    await gatewayRpc(BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD, { sessionId, snapshot })
  } finally {
    activeRefresh.settle()
    if (activeFollowRefreshes.get(sessionId) === activeRefresh) activeFollowRefreshes.delete(sessionId)
  }
}

async function refreshSessionSnapshot(sessionId: string): Promise<void> {
  await affinityReady
  const target = await resolveToolTab(sessionId)
  if (!('ok' in target) && target.id !== undefined) {
    await refreshFollowedPage(sessionId, target.id)
  }
}

async function resolveTabAffinityResponse(response: {
  revision: number
  decision: TabAffinityDecision
  sessionId: unknown
}): Promise<void> {
  await affinityReady
  const active = await syncActiveTab()
  if (response.decision === 'follow' && (active === undefined || !pageAccess.allows(active))) { broadcastPageAccess(); return }
  const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
  const accepted = tabAffinity.decide(response.decision, response.revision, sid)
  const controlled = accepted && response.decision === 'follow'
    ? tabAffinity.snapshot().controlled
    : null
  if (controlled !== null) resetTabSnapshot(controlled.tabId)
  if (accepted) {
    invalidateSessionTarget(sid)
    persistTabAffinity()
    if (controlled !== null && sid !== undefined) {
      const lease = targetLeases.capture(sid, controlled, () => selectedTargetIdentity(sid))
      await pageSessionContexts.ready
      if (lease.current()) pageSessionContexts.bind(sid, { id: controlled.tabId, ...controlled })
    }
  }
  broadcastTabAffinity()
  if (controlled !== null && typeof response.sessionId === 'string' && response.sessionId.trim() !== '') {
    await refreshFollowedPage(response.sessionId, controlled.tabId)
  }
}

/** Move browser control to the current tab only after a fresh, valid query. */
async function rebindTabAffinityToActive(signal: AbortSignal, sessionId?: string): Promise<void> {
  await abortable(Promise.all([affinityReady, pageSessionContexts.ready]).then(() => undefined), signal)
  const tab = await syncActiveTab(undefined, signal)
  throwIfRebindAborted(signal)
  const summary = tab === undefined ? null : summarizeTab(tab)
  if (summary === null) {
    throw new TabAffinityRebindError('no-active-tab', getUiLocale() === 'zh'
      ? '无法确定当前标签页，原会话和标签页绑定保持不变'
      : 'The current tab could not be determined; the existing session and tab binding were left unchanged')
  }

  if (tab === undefined || !pageAccess.allows(tab)) throw new TabAffinityRebindError('page-access-required', getUiLocale() === 'zh'
    ? '请先在目标页面点击工具栏上的 DSH Stride 图标授权此页' : 'Click the DSH Stride toolbar icon on the intended page first')
  commitTabAffinityRebind(summary, sessionId)
}

/** Commit one explicit tab handoff and clear stale element references. */
function commitTabAffinityRebind(
  summary: AffinityTab,
  sessionId?: string,
  mode: 'active' | 'background' = 'active',
): void {
  invalidateSessionTarget(sessionId)
  const previousControlledTabId = tabAffinity.snapshot().controlled?.tabId
  if (sessionId !== undefined) {
    activeFollowRefreshes.get(sessionId)?.controller.abort()
    cancelPendingApprovals(sessionId)
  }
  if (mode === 'active') tabAffinity.rebindActive(summary, sessionId)
  else tabAffinity.rebindControlled(summary, sessionId)
  if (sessionId !== undefined) {
    pageSessionContexts.bind(sessionId, { id: summary.tabId, ...summary })
  }
  if (previousControlledTabId !== undefined && previousControlledTabId !== summary.tabId) {
    resetTabSnapshot(previousControlledTabId)
  }
  resetTabSnapshot(summary.tabId)
  persistTabAffinity()
  broadcastTabAffinity()
}

async function followModelSelectedTab(tab: chrome.tabs.Tab, sessionId: string | undefined, isCurrentCall: () => boolean): Promise<void> {
  const summary = summarizeTab(tab)
  if (summary === null || !pageAccess.allows(tab)) throw new Error('The page needs a native toolbar authorization')
  await pageSessionContexts.ready
  if (!isCurrentCall()) throw new Error('Browser connection changed before the selected tab could be bound')
  commitTabAffinityRebind(summary, sessionId, 'background')
}

/** 把协商的快照预算下发到受控页（尚未绑定时使用活动页）。 */
async function pushBudgetToControlledTab(negotiated: BridgeCaps): Promise<void> {
  await affinityReady
  const resolution = tabAffinity.resolveTarget()
  const tabId = resolution.kind === 'target'
    ? resolution.tab.tabId
    : resolution.kind === 'initial'
      ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id
      : undefined
  if (tabId === undefined || !pageAccess.has(tabId)) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_BUDGET',
      budget: { maxItems: negotiated.maxInteractiveItems, maxChars: negotiated.snapshotMaxChars },
    })
  } catch {
    // 页面尚未注入 content script：下一次快照仍用默认预算，可接受。
  }
}

/** Route one tool.call frame to the user-approved controlled tab. */
function routeToolCall(call: Extract<ServerFrame, { t: 'tool.call' }>): void {
  if (bridge === null) return
  // Transport duplicates must not replace an already-authorized operation.
  if (activeToolCalls.has(call.id)) return
  const controller = new AbortController()
  const unrestrictedAccess = unrestrictedAccessEnabled()
  let settle!: () => void
  const callRpc = rpc
  let executionFence: ToolExecutionFence | undefined
  let runTarget: RunTargetBinding | undefined
  const activeCall: ActiveToolCall = {
    ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
    managed: call.execution.kind === 'run',
    controller,
    unrestrictedAccess,
    committed: false,
    revocationRequested: false,
    settled: new Promise<void>((resolve) => { settle = resolve }),
    settle: () => { settle() },
  }
  activeToolCalls.set(call.id, activeCall)
  unsettledToolCalls.add(activeCall)
  const target = isTabManagementTool(call.name) || call.name === 'browser_open_tab' ? undefined : captureToolTarget(call.sessionId)
  if (target !== undefined && !('ok' in target)) activeCall.targetLease = target
  const admittedPages = pageAccess.snapshot()
  const pageLease = target !== undefined && !('ok' in target) ? pageAccess.lease(target.target.tabId) : () => true
  const isCurrentCall = (): boolean => activeToolCalls.get(call.id) === activeCall
  const targetAllowed = (): boolean => (call.name !== 'browser_list_tabs' || admittedPages.current()) && pageLease() && !tabAffinity.isDetached(call.sessionId) && isCurrentCall() && executionFence?.current() === true && (runTarget === undefined || runTarget.current()) && (activeCall.targetLease === undefined
    || (activeCall.committed ? activeCall.targetLease.sameBinding() : activeCall.targetLease.current()))
  const commitAction = (): void => {
    if (!targetAllowed()) throw new Error('Browser target lease expired before dispatch')
    activeCall.committed = true
  }
  const rollbackActionCommit = (): void => {
    activeCall.committed = false
    if (activeCall.revocationRequested || !targetAllowed()) controller.abort()
  }
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => {
        if (!activeCall.committed) controller.abort()
      }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null
    ? undefined
    : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }
  // A queued operation must observe privacy changes made while it waited.
  // An operation that arrived without unrestricted access must not acquire a
  // newer grant merely because the user enabled it later.
  const sharePageContent = (): Settings['sharePageContent'] => unrestrictedAccess ? 'auto' : settings.sharePageContent
  const managementDispatch = async (): Promise<ToolAnswer> => {
    await affinityReady
    const affinity = tabAffinity.snapshot()
    let windowId = affinity.active?.windowId ?? affinity.controlled?.windowId
    if (windowId === undefined) {
      try {
        windowId = (await chrome.windows.getLastFocused()).id
      } catch { /* approvals can still report unavailable without a focused window */ }
    }
    const controlledTabId = call.sessionId === undefined
      ? affinity.controlled?.tabId
      : tabAffinity.getSessionTab(call.sessionId)?.tabId
    return dispatchToolCall(
      call,
      sharePageContent(),
      budget,
      (prompt) => authorize(prompt, windowId ?? 0),
      controller.signal,
      undefined,
      undefined,
      {
        unrestrictedAccess,
        allowsTab: admittedPages.allows,
        ...(controlledTabId === undefined ? {} : { controlledTabId }),
        followTab: (tab) => followModelSelectedTab(tab, call.sessionId, () => targetAllowed() && admittedPages.allows(tab)),
        commitAction,
        rollbackActionCommit,
      },
    )
  }
  const authorize = async (prompt: ApprovalPrompt, windowId: number): Promise<ApprovalAuthorization> => {
    const notify = async (waiting: boolean) => {
      if (call.taskBudget !== true || callRpc === null) return
      await callRpc.request(BRIDGE_TASK_APPROVAL_METHOD, { requestId: call.id, waiting },
        { signal: controller.signal, timeoutMs: 2000 }).catch(() => {})
    }
    return authorizeToolCall(prompt, controller.signal, windowId, call.sessionId, unrestrictedAccess, notify)
  }
  const dispatch = (): Promise<ToolAnswer> => (isTabManagementTool(call.name)
    ? managementDispatch()
    : call.name === 'browser_open_tab'
    ? resolveOpenTabWindow(call.sessionId).then((target) => 'ok' in target
      ? target
      : dispatchOpenTab(
          call,
          target.windowId,
          sharePageContent(),
          budget,
          (prompt) => authorize(prompt, target.windowId),
          controller.signal,
          (tab) => bindOpenedTab(tab, call.sessionId, targetAllowed, { active: call.args.active !== false }),
          (tabId) => targetAllowed() && tabAffinity.allowsTarget(tabId, call.sessionId),
          commitAction,
          true,
        ))
    : (target === undefined || 'ok' in target ? Promise.resolve(target ?? affinityFailure('missing'))
      : prepareToolTarget(target, call.sessionId, controller.signal)).then((prepared) => 'ok' in prepared
      ? prepared
      : dispatchToolCall(
          call,
          sharePageContent(),
          budget,
          (prompt) => authorize(prompt, prepared.windowId),
          controller.signal,
          prepared,
          () => targetAllowed() && prepared.id !== undefined && tabAffinity.allowsTarget(prepared.id, call.sessionId),
          { unrestrictedAccess, commitAction, rollbackActionCommit },
        ))
  )
  const dispatchAndCheckpoint = async (): Promise<ToolAnswer> => {
    if (tabAffinity.isDetached(call.sessionId)) return affinityFailure('detached')
    if (call.execution.kind === 'run') {
      if (isRunTabMutation(call.name)) return { ok: false, error: { code: 'execution-denied',
        message: 'Run-bound tab creation, follow and close are unavailable. Pause the task and use its selected-page continuation control.' } }
      if (isPageBrowserTool(call.name)) {
        if (target === undefined || 'ok' in target) return target ?? affinityFailure('missing')
        runTarget = runTargets.join(call.execution, call.sessionId!, target, call.targetBinding)
        if (runTarget === undefined) return { ok: false, error: { code: 'execution-denied',
          message: 'The original run target is unavailable or was rebound. Select the intended page and enter a new trusted control revision.' } }
      }
    }
    executionFence = new ToolExecutionFence(call, isCurrentCall, runTarget?.id)
    activeCall.executionFence = executionFence
    if (callRpc === null || !await executionFence.confirm(payload => callRpc.request(BRIDGE_CONFIRM_TOOL_METHOD, payload, {
      signal: controller.signal, timeoutMs: Math.min(5000, call.expiresAt - Date.now()),
    }), controller.signal)) return { ok: false, error: { code: 'execution-denied',
      message: 'The Host did not confirm this request’s original execution context; no browser tool was dispatched.' } }
    if (runTarget !== undefined && !runTarget.accept()) return staleTarget()
    const sharingAtDispatch = pageSharingRevision
    let answer = await dispatch()
    if (!targetAllowed()) return staleTarget()
    if (answer.ok && isNavigationCandidateTool(call.name) && activeToolCalls.get(call.id) === activeCall) {
      await checkpointSessionPage(call.sessionId, targetAllowed)
    }
    if (sharingAtDispatch !== pageSharingRevision && !unrestrictedAccessEnabled() && settings.sharePageContent !== 'auto') {
      if (call.name === 'browser_snapshot' || call.name === 'browser_get_text') {
        answer = { ok: false, error: { code: 'action-failed', message: 'Page sharing changed before the observation could be delivered.' } }
      } else if (answer.ok && typeof answer.result === 'object' && answer.result !== null
        && typeof (answer.result as { text?: unknown }).text === 'string'
        && (answer.result as { text: string }).text.includes('<UNTRUSTED_PAGE_CONTENT')) {
        answer = { ok: true, result: { text: 'Browser action returned; page content was withheld because sharing settings changed. This does not confirm a saved change.' } }
      }
    }
    return answer
  }
  const result = executeRecordedTool(call, controller.signal, () => needsWriteTurn(call.name)
    ? writeQueue.run(controller.signal, dispatchAndCheckpoint) : dispatchAndCheckpoint())
  void result.then(
    async (answer) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (answer.ok && !targetAllowed()) answer = staleTarget()
      // A committed browser_open_tab already rebound affinity; prefer that
      // factual success over a generic cancel that would leave the model wrong.
      if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id, action: call.action,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      if (answer.ok) {
        if (activeToolCalls.get(call.id) !== activeCall) return
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, action: call.action, ok: true, result: answer.result })
      } else {
        const socket = bridge
        if (socket === null) return
        socket.send({ t: 'tool.result', id: call.id, action: call.action, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      if (activeToolCalls.get(call.id) !== activeCall) return
      if (controller.signal.aborted) {
        if (activeToolCalls.get(call.id) === activeCall) {
          bridge?.send({
            t: 'tool.result',
            id: call.id, action: call.action,
            ok: false,
            error: { code: 'action-failed', message: 'Tool call was cancelled' },
          })
        }
        return
      }
      bridge?.send({
        t: 'tool.result',
        id: call.id, action: call.action,
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    unsettledToolCalls.delete(activeCall)
    activeCall.settle()
    if (activeToolCalls.get(call.id) === activeCall) activeToolCalls.delete(call.id)
  })
}

function cancelToolCall(id: string): void {
  const call = activeToolCalls.get(id)
  if (call !== undefined) {
    if (!call.committed || call.managed) call.executionFence?.revoke()
    if (!call.committed) call.controller.abort()
  }
}

async function revokeUnrestrictedAccess(): Promise<void> {
  const calls = [...unsettledToolCalls].filter((call) => call.unrestrictedAccess)
  const refreshes = [...activeFollowRefreshes.values()].filter((refresh) => refresh.unrestrictedAccess)
  for (const call of calls) {
    call.revocationRequested = true
    if (!call.committed) call.controller.abort()
  }
  for (const refresh of refreshes) refresh.controller.abort()
  await Promise.allSettled([
    ...calls.map(async (call) => { await call.settled }),
    ...refreshes.map(async (refresh) => { await refresh.settled }),
  ])
}

function cancelAllToolCalls(): void {
  targetLeases.revokeAll()
  runTargets.revokeAll()
  for (const call of activeToolCalls.values()) {
    call.executionFence?.revoke()
    if (!call.committed) call.controller.abort()
  }
  activeToolCalls.clear()
}

/** (Re)start the bridge with the current settings; address discovery contains no credential. */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  await affinityReady
  if (panelPorts.size === 0 || connectionDisconnected || unpairing) return
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision && panelPorts.size > 0) ?? ''
  }
  // Discovery is asynchronous. A panel may have closed or a newer settings
  // update may have started while its fetches were in flight.
  if (revision !== bridgeStartRevision || panelPorts.size === 0 || connectionDisconnected || unpairing) return
  if (url === '') {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastStatus()
    return
  }
  const localUrl = localBridgeUrl(url)
  if (localUrl === undefined) {
    bridge?.stop()
    bridge = null
    rpc = null
    broadcastStatus()
    return
  }
  url = localUrl
  const installationId = settings.token === '' ? '' : await ensureInstallationId()
  if (revision !== bridgeStartRevision || panelPorts.size === 0 || connectionDisconnected || unpairing) return
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') {
          cancelAllToolCalls()
          interactionResponses.failAll(responseMessages().disconnected)
          transientEvents.clear()
        }
        broadcastStatus()
        if (state === 'stopped') refreshPanelResumeHints()
        if (state === 'stopped' && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') {
          transientEvents.ingest(frame)
          broadcastEvent(frame)
        }
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') cancelToolCall(frame.id)
        else if (frame.t === 'respond.result') interactionResponses.route(frame)
        // rpc.result is settled by the rpc facade (wrapped below).
      },
      onHelloOk: async (negotiated, credential, presentedToken) => {
        if (connectionDisconnected || unpairing) throw new Error('Connection was removed')
        const controlRevision = connectionControlRevision
        const pairing = { url: activeBridgeUrl, installationId: activeInstallationId }
        if (credential !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(credential) || settings.token !== presentedToken) {
            throw new Error('Pairing was superseded or returned an invalid credential')
          }
          await persistSettings({ token: credential })
        }
        if (connectionDisconnected || unpairing || controlRevision !== connectionControlRevision) throw new Error('Connection was removed')
        if (pairing.url !== undefined && presentedToken !== undefined) activePairing = { url: pairing.url, credential: credential ?? presentedToken, installationId: pairing.installationId }
        caps = negotiated
        broadcastStatus()
        void pushBudgetToControlledTab(negotiated)
      },
    }, probeBridge, () => panelPorts.size > 0 && !connectionDisconnected && !unpairing)
    bridge = client
    rpc = createRpc(client)
  }
  activeBridgeUrl = url
  activeInstallationId = installationId
  bridge.start(url, settings.token, installationId)
}

/** Gateway RPC with a helpful error when the bridge is down. */
async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error(getUiLocale() === 'zh'
      ? '未连接 dsh（请检查设置中的地址与配对状态）'
      : 'dsh is not connected (check the bridge address and pairing in Settings)')
  }
  return rpc.request(method, payload)
}

let pairingJob: { controller: AbortController; port: chrome.runtime.Port } | undefined

function cancelBrowserPairing(port?: chrome.runtime.Port): void {
  if (pairingJob !== undefined && (port === undefined || pairingJob.port === port)) pairingJob.controller.abort()
}

async function pairBrowser(port: chrome.runtime.Port, address: string): Promise<void> {
  if (unpairing) {
    try { port.postMessage({ type: 'browser-pairing', status: { phase: 'failed', error: 'pairing-busy' } }) } catch { /* panel closed */ }
    return
  }
  if (pairingJob !== undefined) {
    if (pairingJob.port !== port) {
      try { port.postMessage({ type: 'browser-pairing', status: { phase: 'failed', error: 'pairing-busy' } }) } catch { /* panel closed */ }
    }
    return
  }
  const job = { controller: new AbortController(), port }
  pairingJob = job
  const send = (status: BrowserPairingStatus): void => {
    if (pairingJob !== job || !panelPorts.has(port)) return
    try { port.postMessage({ type: 'browser-pairing', status }) } catch { /* panel closed */ }
  }
  send({ phase: 'requesting' })
  try {
    await settingsReady
    if (bridge?.connected) throw new Error('already-connected')
    const initial = { token: settings.token, bridgeUrl: settings.bridgeUrl }
    const discovered = address === '' ? await discoverBridge(() => !job.controller.signal.aborted && panelPorts.has(port)) : address
    const local = discovered === undefined ? undefined : localBridgeUrl(discovered)
    if (local === undefined) throw new Error('host-unavailable')
    job.controller.signal.throwIfAborted()
    const installationId = await ensureInstallationId()
    const credential = await requestBrowserPairing(local, installationId, job.controller.signal, send)
    job.controller.signal.throwIfAborted()
    if (pairingJob !== job || !panelPorts.has(port) || settings.token !== initial.token || settings.bridgeUrl !== initial.bridgeUrl) {
      throw new Error('pairing-cancelled')
    }
    send({ phase: 'saving' })
    await persistSettings({ bridgeUrl: address === '' ? '' : local, token: credential }, true)
    // A completed credential commit survives closing the panel, just like a
    // manual pairing. Only a live panel may initiate its new connection.
    if (!job.controller.signal.aborted && panelPorts.has(port)) await startBridge()
    send({ phase: 'saved' })
  } catch (error) {
    send({ phase: 'failed', error: job.controller.signal.aborted ? 'pairing-cancelled' : error instanceof Error ? error.message : 'host-unavailable' })
  } finally { if (pairingJob === job) pairingJob = undefined }
}

/** Unpairing is local revocation first; an offline Host cannot make us reconnect. */
async function unpairBrowser(): Promise<{ remoteRevoked: boolean }> {
  if (unpairing) throw new Error('Connection removal is already in progress')
  unpairing = true
  const notify = (status: BrowserPairingStatus) => { for (const port of panelPorts) {
    try { port.postMessage({ type: 'browser-pairing', status }) } catch { /* panel closed */ }
  } }
  notify({ phase: 'unpairing' })
  try {
    await settingsReady.catch(() => {})
    const captured = bridge?.connected ? activePairing : undefined
    const credential = captured?.credential ?? settings.token
    let address = captured?.url ?? (settings.bridgeUrl || activeBridgeUrl)
    connectionControlRevision += 1
    bridgeStartRevision += 1
    connectionDisconnected = true
    const pairing = pairingJob
    pairing?.controller.abort()
    if (pairingJob === pairing) pairingJob = undefined
    bridge?.stop()
    cancelAllToolCalls()
    cancelPendingApprovals()
    void pageAccess.clear().catch(() => {})
    settings = { ...settings, token: '' }
    activePairing = undefined
    caps = null
    disarmBridgeKeepalive()
    syncSelectionWatch()
    broadcastStatus()
    // Atomic credential deletion + disabled marker also wins over old handshakes.
    await writeBridgeCredential('', 'disable')
    await settingsPersistence.catch(() => {})
    await persistSettings({})
    if (credential === '') { notify({ phase: 'unpaired', remoteRevoked: false }); return { remoteRevoked: false } }
    const installationId = captured?.installationId ?? await ensureInstallationId().catch(() => undefined)
    if (address === undefined) {
      const deadline = Date.now() + 2500
      address = await discoverBridge(() => Date.now() < deadline)
    }
    const remoteRevoked = address !== undefined && installationId !== undefined && await revokeBrowserPairing(address, installationId, credential)
    notify({ phase: 'unpaired', remoteRevoked })
    return { remoteRevoked }
  } catch (error) { notify({ phase: 'failed', error: 'unpair-failed' }); throw error }
  finally { unpairing = false; broadcastStatus() }
}

// ---- Content script messages ----

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if (sender.id !== chrome.runtime.id) return
  if (sender.tab?.id === undefined) return
  const type = (message as { type?: unknown }).type
  if (type === 'DSH_DOCUMENT_CHANGED') {
    if (!pageAccess.allows(sender.tab) || !pageAccess.allowsFrame(sender.tab.id, sender.url)) return
    invalidateDocumentTarget(sender.tab.id)
    resetTabSnapshot(sender.tab.id)
    broadcastSelections(selections.clearTab(sender.tab.id, sender.frameId ?? 0))
    return
  }
  if (!pageAccess.allows(sender.tab) || !pageAccess.allowsFrame(sender.tab.id, sender.url ?? sender.tab.url)) return
  if (type === 'DSH_CONTENT_READY') {
    // navigation.ts also listens for this frame-ready announcement; only this
    // listener answers it, telling a fresh document whether to watch
    // selections. The revision lets a slow reply lose to a newer broadcast.
    sendResponse({
      selectionWatch: selectionWatchEnabled(sender.tab.windowId) && pageAccess.has(sender.tab.id),
      selectionWatchEpoch: selectionWatchEpoch,
      selectionWatchRevision: selectionWatchRevision,
    })
    return
  }
  if (type !== 'DSH_SELECTION' || sender.tab === undefined) return
  recordSelection(sender.tab, sender.frameId ?? 0, (message as { selection?: unknown }).selection)
})

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  // Content scripts can open runtime ports too. Only the extension's own
  // panel may submit settings, approvals or Host RPCs through this channel.
  if (port.sender?.id !== chrome.runtime.id
    || port.sender.url?.split(/[?#]/, 1)[0] !== chrome.runtime.getURL('panel/index.html')) {
    port.disconnect()
    return
  }
  const wasIdle = panelPorts.size === 0
  const tabAffinityRebinds = new Map<string, {
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()
  const runRetargets = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>()
  panelPorts.add(port)
  if (wasIdle) armBridgeKeepalive()
  void settingsReady.then(syncSelectionWatch)
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    broadcastStatus()
    if (connectionDisconnected) { disarmBridgeKeepalive(); return }
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  try { port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps,
    connectionDisconnected, hasCredential: settings.token !== '' }) } catch { /* port closed */ }
  void affinityReady.then(async () => {
    await syncActiveTab()
    try { port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() }) } catch { /* port closed */ }
  })
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'browser-run.retarget': {
        const request = message as { id?: unknown; runId?: unknown; sessionId?: unknown; expectedVersion?: unknown; controlRevision?: unknown; affinityRevision?: unknown; start?: unknown; task?: unknown }
        if (typeof request.id !== 'string') break
        const id = request.id
        const sid = validSessionId(request.sessionId)
        const runId = validSessionId(request.runId)
        const version = request.expectedVersion
        const revision = request.controlRevision
        const start = request.start === true
        const reply = (ok: boolean, code = 'handoff-failed'): void => {
          try { port.postMessage({ type: 'browser-run.retarget.result', id, ok,
            ...(!ok ? { error: { code, message: 'Task target change was not confirmed. Refresh task status before another action.' } } : {}) }) } catch { /* panel closed */ }
        }
        if (sid === undefined || runId === undefined || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0
          || typeof revision !== 'number' || !Number.isSafeInteger(revision + 2) || revision < 0 || !Number.isSafeInteger(revision)
          || runRetargets.size !== 0 || unbindingSessions.has(sid)) { reply(false); break }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        runRetargets.set(id, { controller, timer })
        const boundRpc = rpc
        let affinityRevision = request.affinityRevision
        const current = () => panelPorts.has(port) && panelActiveSessions.get(port) === sid && tabAffinity.focusedSession() === sid
          && tabAffinity.snapshot().revision === affinityRevision
        void (async () => {
          if (!current() || boundRpc === null || bridge?.connected !== true) throw new Error('stale selection')
          if (start) {
            const active = tabAffinity.snapshot().active
            if (active === null) throw new Error('no active page')
            const before = targetLeases.capture(sid, active, () => tabAffinity.snapshot().active ?? undefined)
            const native = await chrome.tabs.get(active.tabId)
            const summary = summarizeTab(native)
            if (!current() || !before.current() || controller.signal.aborted || summary === null
              || native.status === 'loading' || native.pendingUrl !== undefined || summary.tabId !== active.tabId
              || summary.windowId !== active.windowId || summary.url !== active.url) throw new Error('page changed')
            if (!pageAccess.allows(native)) throw new Error('page-access-required')
            commitTabAffinityRebind(summary, sid)
            affinityRevision = tabAffinity.snapshot().revision
          }
          const target = captureToolTarget(sid)
          if ('ok' in target) throw new Error('target unavailable')
          const live = await prepareToolTarget(target, sid, controller.signal)
          if ('ok' in live || !current() || !target.current() || controller.signal.aborted) throw new Error('target changed')
          const prepared = runTargets.prepare({ kind: 'run', runId, controlRevision: revision + (start ? 0 : 2) }, sid, target)
          if (prepared === undefined) throw new Error('target unavailable')
          const result = await boundRpc.request(start ? BRIDGE_TASK_START_METHOD : BRIDGE_RUN_RETARGET_METHOD, { runId, sessionId: sid,
            expectedVersion: version, controlRevision: revision, targetBinding: prepared.id,
            ...(start || request.task === true ? { targetUrl: target.target.url } : {}) }, { signal: controller.signal, timeoutMs: 12_000 })
          if (typeof result !== 'object' || result === null) throw new Error('invalid result')
          const value = result as { runId?: unknown; sessionId?: unknown; controlRevision?: unknown; state?: unknown; targetBinding?: unknown }
          if (value.runId !== runId || value.sessionId !== sid || value.controlRevision !== revision + (start ? 0 : 2)
            || value.state !== 'running' || value.targetBinding !== prepared.id) throw new Error('invalid result')
          reply(true)
        })().catch(error => reply(false, error instanceof BridgeRpcError ? error.code : 'handoff-failed')).finally(() => {
          clearTimeout(timer)
          if (runRetargets.get(id)?.controller === controller) runRetargets.delete(id)
        })
        break
      }
      case 'browser-pairing.start': {
        const address = (message as { bridgeUrl?: unknown }).bridgeUrl
        if (typeof address === 'string' && address.length <= 512 && (address === '' || localBridgeUrl(address) !== undefined)) {
          void pairBrowser(port, address)
        } else {
          try { port.postMessage({ type: 'browser-pairing', status: { phase: 'failed', error: 'invalid-host' } }) } catch { /* panel closed */ }
        }
        break
      }
      case 'browser-pairing.cancel':
        cancelBrowserPairing(port)
        break
      case 'browser-pairing.unpair': {
        const id = (message as { id?: unknown }).id
        if (typeof id !== 'string') break
        void unpairBrowser().then(result => {
          try { port.postMessage({ type: 'browser-pairing.unpair.result', id, ok: true, result }) } catch { /* panel closed */ }
        }, () => {
          try { port.postMessage({ type: 'browser-pairing.unpair.result', id, ok: false,
            error: { message: getUiLocale() === 'zh' ? '连接凭据未能完全清除，请重试' : 'Connection credentials could not be fully cleared. Try again.' } }) } catch { /* panel closed */ }
        })
        break
      }
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        if ([BRIDGE_RUN_RETARGET_METHOD, BRIDGE_TASK_START_METHOD, BRIDGE_TASK_APPROVAL_METHOD].includes(rpcMsg.method)) {
          try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: false,
            error: { code: 'forbidden', message: 'Use the selected-page task control.' } }) } catch { /* panel closed */ }
          break
        }
        const rpcSessionId = typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null
          ? (rpcMsg.payload as { sessionId?: string }).sessionId
          : undefined
        const refresh = rpcSessionId === undefined
          ? Promise.resolve()
          : sessionSnapshotRefreshes.get(rpcSessionId) ?? Promise.resolve()
        const prepare = rpcMsg.method === 'session.prompt'
          ? Promise.resolve().then(async () => {
              await refresh
              return rpcSessionId === undefined || tabAffinity.getSessionTab(rpcSessionId) !== undefined
            })
          : Promise.resolve(true)
        void prepare.then((ready) => {
          if (!ready) throw new Error('This session is not bound to a live browser tab')
          return gatewayRpc(rpcMsg.method, rpcMsg.payload)
        }).then(
          (result) => {
            try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'rpc.result',
                id: rpcMsg.id,
                ok: false,
                error: { code: error instanceof BridgeRpcError ? error.code : 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        const messages = responseMessages()
        interactionResponses.begin(
          port,
          response.id,
          () => bridge?.send({
            t: 'respond',
            id: response.id as string,
            rpcId: response.rpcId as string,
            result: response.result as RespondResult,
          }) === true,
          messages,
        )
        break
      }
      case 'settings': {
        cancelBrowserPairing()
        const settingsMsg = message as { id?: unknown; settings: Partial<Settings> }
        const requestId = typeof settingsMsg.id === 'string' ? settingsMsg.id : undefined
        void settingsReady.then(async () => {
          try {
            const previousConnection = { bridgeUrl: settings.bridgeUrl, token: settings.token }
            await persistSettings(settingsMsg.settings, typeof settingsMsg.settings.token === 'string' && settingsMsg.settings.token.trim() !== '')
            const connectionChanged = settings.bridgeUrl !== previousConnection.bridgeUrl
              || settings.token !== previousConnection.token
            if (panelPorts.size > 0) {
              if (connectionChanged) await startBridge()
              broadcastStatus()
            } else if (connectionChanged) {
              // The settings write outlived its originating panel. Do not keep a
              // healthy socket authenticated with stale connection settings: make
              // the next explicit panel lease start from the persisted values.
              bridgeStartRevision += 1
              bridge?.stop()
              bridge = null
              rpc = null
              caps = null
              broadcastStatus()
              disarmBridgeKeepalive()
            }
            if (requestId !== undefined) {
              try { port.postMessage({ type: 'settings.result', id: requestId, ok: true }) } catch { /* port closed */ }
            }
          } catch (error: unknown) {
            if (requestId === undefined) return
            try {
              port.postMessage({
                type: 'settings.result',
                id: requestId,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              })
            } catch { /* port closed */ }
          }
        })
        break
      }
      case 'panel.window': {
        // The panel reports its own window; a side panel has no sender.tab.
        const registration = message as { windowId?: unknown }
        if (typeof registration.windowId !== 'number'
          || !Number.isInteger(registration.windowId)
          || registration.windowId < 0) break
        panelWindows.set(port, registration.windowId)
        syncSelectionWatch()
        try {
          port.postMessage({ type: 'selection', selection: selections.current(registration.windowId) })
        } catch { /* port closed */ }
        void postResumeHint(port, registration.windowId)
        break
      }
      case 'selection.clear': {
        // The user sent, dismissed, or explicitly abandoned this window's
        // quote. A send/dismiss names the value it acted on so a newer capture
        // that arrived while work was in flight cannot be cleared by mistake.
        const windowId = panelWindows.get(port)
        if (windowId === undefined) break
        const request = message as { selection?: unknown }
        const expected = request.selection === undefined ? undefined : parsePageSelection(request.selection)
        if (expected === null) break
        const source = selections.source(windowId)
        const cleared = expected === undefined
          ? selections.clear(windowId)
          : selections.clearIfCurrent(windowId, expected)
        if (cleared && source !== null) resetSelectionDedupe([source])
        // Also repairs a panel that acted on a stale attachment.
        broadcastSelection(windowId)
        break
      }
      case 'session.active': {
        const session = message as { sessionId?: unknown; isNew?: boolean }
        const sid = validSessionId(session.sessionId)
        if (sid === undefined) {
          panelActiveSessions.delete(port)
        } else {
          panelActiveSessions.set(port, sid)
          if (session.isNew === true) {
            const bind = Promise.all([affinityReady, pageSessionContexts.ready]).then(async () => {
              const tab = await syncActiveTab()
              const summary = tab === undefined ? null : summarizeTab(tab)
              if (summary === null) throw new Error('No active tab is available to bind this session')
              if (tabAffinity.getSessionTab(sid) === undefined) {
                invalidateSessionTarget(sid)
                if (!tabAffinity.bindNewSession(sid, summary)) {
                  tabAffinity.focusSession(sid)
                  persistTabAffinity(); broadcastTabAffinity()
                  return
                }
              }
              pageSessionContexts.bind(sid, { id: summary.tabId, ...summary })
              resetTabSnapshot(summary.tabId)
              persistTabAffinity()
              broadcastTabAffinity()
              await refreshSessionSnapshot(sid)
            }).catch(() => {})
            sessionSnapshotRefreshes.set(sid, bind)
            void bind.finally(() => {
              if (sessionSnapshotRefreshes.get(sid) === bind) sessionSnapshotRefreshes.delete(sid)
            })
          } else if (tabAffinity.focusSession(sid)) {
            invalidateSessionTarget()
            persistTabAffinity()
            broadcastTabAffinity()
          }
        }
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id === 'string' && isApprovalDecision(approval.decision)) {
          approvals.respond(approval.id, approval.decision)
        }
        break
      }
      case 'tab-affinity.response': {
        const response = message as { revision?: unknown; decision?: unknown; sessionId?: unknown }
        if (typeof response.revision !== 'number' || !isTabAffinityDecision(response.decision)) break
        const sid = typeof response.sessionId === 'string' ? response.sessionId : undefined
        if (sid !== undefined && unbindingSessions.has(sid)) break
        const decision = resolveTabAffinityResponse({
          revision: response.revision,
          decision: response.decision,
          sessionId: response.sessionId,
        }).catch(() => {})
        if (response.decision === 'follow' && sid !== undefined) {
          sessionSnapshotRefreshes.set(sid, decision)
          void decision.finally(() => {
            if (sessionSnapshotRefreshes.get(sid) === decision) sessionSnapshotRefreshes.delete(sid)
          })
        } else {
          void decision
        }
        break
      }
      case 'tab-affinity.rebind': {
        const request = message as { id?: unknown; sessionId?: unknown }
        if (typeof request.id !== 'string') break
        const requestId = request.id
        const rebindSessionId = validSessionId(request.sessionId) ?? panelActiveSessions.get(port)
        if (unbindingSessions.has(rebindSessionId ?? '')) {
          try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: false,
            error: { code: 'binding-busy', message: getUiLocale() === 'zh' ? '正在解绑页面，请稍后重试' : 'Page unbinding is in progress. Try again afterwards.' } }) } catch { /* panel closed */ }
          break
        }
        if (tabAffinityRebinds.has(requestId)) break
        const controller = new AbortController()
        const timer = setTimeout(() => {
          controller.abort(new TabAffinityRebindError('timeout', getUiLocale() === 'zh'
            ? '绑定当前标签页超时，请重试'
            : 'Binding the current tab timed out. Try again.'))
        }, TAB_AFFINITY_REBIND_TIMEOUT_MS)
        tabAffinityRebinds.set(requestId, { controller, timer })
        void rebindTabAffinityToActive(controller.signal, rebindSessionId).then(
          () => {
            try { port.postMessage({ type: 'tab-affinity.rebind.result', id: requestId, ok: true }) } catch { /* port closed */ }
          },
          (error: unknown) => {
            try {
              port.postMessage({
                type: 'tab-affinity.rebind.result',
                id: requestId,
                ok: false,
                error: {
                  code: error instanceof TabAffinityRebindError ? error.code : 'no-active-tab',
                  message: error instanceof Error ? error.message : String(error),
                },
              })
            } catch { /* port closed */ }
          },
        ).finally(() => {
          const current = tabAffinityRebinds.get(requestId)
          if (current?.controller !== controller) return
          clearTimeout(current.timer)
          tabAffinityRebinds.delete(requestId)
        })
        break
      }
      case 'tab-affinity.unbind': {
        const request = message as { id?: unknown; sessionId?: unknown; revision?: unknown }
        if (typeof request.id !== 'string') break
        const id = request.id
        const sid = request.sessionId === null ? undefined : validSessionId(request.sessionId)
        const key = sid ?? ''
        const current = () => panelPorts.has(port) && panelActiveSessions.get(port) === sid
          && tabAffinity.focusedSession() === (sid ?? null) && tabAffinity.snapshot().revision === request.revision
        const reply = (ok: boolean, message?: string) => {
          try { port.postMessage({ type: 'tab-affinity.unbind.result', id, ok,
            ...(ok ? {} : { error: { code: 'unbind-refused', message: message ?? (getUiLocale() === 'zh' ? '页面绑定已变化，请核对后重试' : 'The page binding changed. Check it before retrying.') } }) }) } catch { /* panel closed */ }
        }
        if ((request.sessionId !== null && sid === undefined) || typeof request.revision !== 'number'
          || !Number.isSafeInteger(request.revision) || !current() || unbindingSessions.has(key)) { reply(false); break }
        unbindingSessions.add(key)
        const boundRpc = rpc
        void (async () => {
          await Promise.all([affinityReady, pageSessionContexts.ready])
          if (!current() || runRetargets.size > 0 || tabAffinityRebinds.size > 0) throw new Error('stale-binding')
          if (sid !== undefined && boundRpc !== null && bridge?.connected === true) {
            const envelope = await boundRpc.request(BRIDGE_RUN_LIST_METHOD, { sessionId: sid }, { timeoutMs: 5000 }) as { result?: { ok?: boolean; value?: { items?: Array<{ state?: string }> } } }
            const listed = envelope?.result?.ok === true ? envelope.result.value : undefined
            if (!Array.isArray(listed?.items)) throw new Error('task-status-unavailable')
            if (listed.items.some(run => run.state === 'running' || run.state === 'stopping')) throw new Error('task-running')
          }
          if (!current() || rpc !== boundRpc || runRetargets.size > 0 || tabAffinityRebinds.size > 0) throw new Error('stale-binding')
          const previous = tabAffinity.snapshot().controlled
          if (!tabAffinity.unbindSession(sid, request.revision as number)) throw new Error('stale-binding')
          invalidateSessionTarget(sid)
          for (const call of unsettledToolCalls) if (call.sessionId === sid) {
            call.executionFence?.revoke()
            call.revocationRequested = true
            if (!call.committed) call.controller.abort()
          }
          if (sid !== undefined) { activeFollowRefreshes.get(sid)?.controller.abort(); pageSessionContexts.removeSession(sid) }
          if (sid !== undefined) cancelPendingApprovals(sid)
          if (previous !== null) resetTabSnapshot(previous.tabId)
          broadcastTabAffinity()
          await persistTabAffinity(true)
          reply(true)
        })().catch(error => {
          const running = error instanceof Error && error.message === 'task-running'
          reply(false, running ? (getUiLocale() === 'zh' ? '请先暂停或停止正在运行的任务，再解绑页面' : 'Pause or stop the running task before unbinding its page.')
            : getUiLocale() === 'zh' ? '页面解绑未能确认，请核对绑定和任务状态后重试' : 'Page unbinding was not confirmed. Check the binding and task status before retrying.')
        }).finally(() => { unbindingSessions.delete(key) })
        break
      }
      case 'page-access.revoke': {
        const request = message as { id?: unknown; tabId?: unknown }
        if (typeof request.id !== 'string' || typeof request.tabId !== 'number') break
        const reply = (ok: boolean) => { try { port.postMessage({ type: 'page-access.revoke.result', id: request.id, ok }) } catch { /* closed */ } }
        // Revocation remains valid if focus changed after the displayed button was clicked.
        if (!pageAccess.has(request.tabId)) { reply(false); break }
        void pageAccess.revoke(request.tabId).then(() => reply(true), () => reply(false))
        break
      }
      case 'request-status':
        broadcastPageAccess()
        try {
          port.postMessage({ type: 'status', state: bridge?.state ?? ('stopped' as BridgeState), caps,
            connectionDisconnected, hasCredential: settings.token !== '' })
          port.postMessage({ type: 'tab-affinity', state: tabAffinity.snapshot() })
          const statusWindowId = panelWindows.get(port)
          if (statusWindowId !== undefined) {
            port.postMessage({ type: 'selection', selection: selections.current(statusWindowId) })
          }
          for (const frame of transientEvents.replay()) port.postMessage({ type: 'event', frame })
          approvals.replay((request) => {
            port.postMessage({ type: 'approval.request', request })
            return true
          })
          const resumeWindowId = panelWindows.get(port)
          if (resumeWindowId !== undefined) void postResumeHint(port, resumeWindowId)
        } catch { /* port closed */ }
        break
    }
  })
  port.onDisconnect.addListener(() => {
    cancelBrowserPairing(port)
    for (const job of runRetargets.values()) { clearTimeout(job.timer); job.controller.abort() }
    runRetargets.clear()
    for (const operation of tabAffinityRebinds.values()) {
      clearTimeout(operation.timer)
      operation.controller.abort(new TabAffinityRebindError('cancelled', getUiLocale() === 'zh'
        ? '后台连接已断开，标签页绑定已取消'
        : 'The background connection was lost, so tab binding was cancelled'))
    }
    tabAffinityRebinds.clear()
    const panelWindowId = panelWindows.get(port)
    const panelSessionId = panelActiveSessions.get(port)
    panelActiveSessions.delete(port)
    panelPorts.delete(port)
    if (panelSessionId !== undefined) void checkpointSessionPage(panelSessionId)
    interactionResponses.removePort(port)
    if (panelWindowId !== undefined && !hasPanelInWindow(panelWindowId)) {
      const source = selections.source(panelWindowId)
      if (selections.clear(panelWindowId) && source !== null) resetSelectionDedupe([source])
    }
    syncSelectionWatch()
    if (panelPorts.size === 0) {
      bridgeStartRevision += 1
      bridge?.suspendReconnect()
      sessionTrustedActionOrigins.clear()
      approvals.notifyPending()
      if (bridge?.state !== 'connected') disarmBridgeKeepalive()
    }
  })
})

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(APPROVAL_NOTIFICATION_PREFIX)) return
  const id = notificationId.slice(APPROVAL_NOTIFICATION_PREFIX.length)
  const windowId = approvals.windowId(id)
  if (windowId === undefined) return
  clearApprovalNotification(id)
  // Notification clicks are extension user gestures; both panel APIs require
  // the call to remain inside this handler.
  openAssistantPanel(windowId)
})

// ---- Tab affinity ----

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void affinityReady.then(() => {
    const activationRevision = focusedWindow.acceptActivation(windowId)
    if (activationRevision === null) return
    // Mark the switch before awaiting metadata so an already-running trusted
    // action cannot slip through the handoff boundary.
    const state = tabAffinity.snapshot()
    const known = state.controlled?.tabId === tabId ? state.controlled : state.active?.tabId === tabId ? state.active : null
    observeActiveSummary({ tabId, windowId, title: known?.title ?? '', url: known?.url ?? '' })
    return chrome.tabs.get(tabId).then((tab) => {
      if (focusedWindow.isCurrent(activationRevision)) observeActiveTab(tab)
    }).catch(() => {})
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Firefox ends activeTab on a new document, including loopback pages where
  // the separate DSH network permission would otherwise let injection succeed.
  if (import.meta.env.EXT_TARGET === 'firefox' && changeInfo.status === 'loading') void pageAccess.revoke(tabId).catch(() => {})
  pageAccess.observe(tab, changeInfo.groupId !== undefined)
  if (changeInfo.status === 'complete') void pageAccess.refresh(tab)
  if (changeInfo.status === 'loading' || changeInfo.url !== undefined) invalidateDocumentTarget(tabId)
  void affinityReady.then(() => {
    if (!tabAffinity.tracks(tabId)) return
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) {
      revokeStaleTargetCalls()
      broadcastTabAffinity()
    }
  })
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void pageAccess.revoke(removedTabId).catch(() => {})
  forgetTarget(removedTabId)
  forgetTarget(addedTabId)
  // The old document is gone even though Chrome transfers the tab identity.
  forgetTabSnapshot(removedTabId)
  resetTabSnapshot(addedTabId)
  broadcastSelections(selections.clearTab(removedTabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.replaceTab(removedTabId, addedTabId)
  })
  void affinityReady.then(() => {
    // onReplaced is an identity swap (for example prerender activation), not
    // a close or user-visible switch. Transfer IDs synchronously before any
    // metadata lookup so tool resolution never observes the removed target.
    const affectedSessions = tabAffinity.sessionIdsForTab(removedTabId)
    if (!tabAffinity.replaceTab(removedTabId, addedTabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
    return chrome.tabs.get(addedTabId).then((tab) => {
      const summary = summarizeTab(tab)
      if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
    }).catch(() => {})
  })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  void pageAccess.revoke(tabId).catch(() => {})
  forgetTarget(tabId)
  forgetTabSnapshot(tabId)
  broadcastSelections(selections.clearTab(tabId))
  void pageSessionContexts.ready.then(() => {
    pageSessionContexts.removeTab(tabId)
  })
  void affinityReady.then(() => {
    const affectedSessions = tabAffinity.sessionIdsForTab(tabId)
    if (!tabAffinity.removeTab(tabId)) return
    for (const sid of affectedSessions) {
      activeFollowRefreshes.get(sid)?.controller.abort()
      cancelPendingApprovals(sid)
    }
    persistTabAffinity()
    broadcastTabAffinity()
  })
})

// A committed navigation replaces a document; a same-document history or
// fragment update does not, and must not drop a quote still on the screen.
// Matching the exact frame keeps an iframe's navigation from invalidating a
// quote taken from its parent page, and vice versa.
chrome.webNavigation?.onCommitted.addListener(({ tabId, frameId }) => {
  invalidateDocumentTarget(tabId)
  resetTabSnapshot(tabId)
  broadcastSelections(selections.clearTab(tabId, frameId))
})

// The document and even its URL can remain unchanged after SPA history
// transitions. Invalidate every frame's pre-transition snapshot while keeping
// the user's visible text selection intact.
chrome.webNavigation?.onHistoryStateUpdated?.addListener(({ tabId }) => { invalidateDocumentTarget(tabId); resetTabSnapshot(tabId) })
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener(({ tabId }) => { invalidateDocumentTarget(tabId); resetTabSnapshot(tabId) })
chrome.webNavigation?.onBeforeNavigate?.addListener(({ tabId }) => { invalidateDocumentTarget(tabId) })
chrome.tabs.onDetached?.addListener((tabId) => { void pageAccess.revoke(tabId).catch(() => {}); forgetTarget(tabId) })
chrome.tabs.onAttached?.addListener((tabId) => {
  forgetTarget(tabId)
  void affinityReady.then(async () => {
    if (!tabAffinity.tracks(tabId)) return
    const tab = await chrome.tabs.get(tabId)
    const summary = summarizeTab(tab)
    if (summary !== null && tabAffinity.observeTab(summary)) broadcastTabAffinity()
  }).catch(() => {})
})

// Ports are cleaned up by their own disconnect; only the window's quote is
// left behind when the whole window goes away.
chrome.windows.onRemoved.addListener((windowId) => {
  selections.clear(windowId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  focusedWindow.markFocused(windowId)
  void affinityReady.then(() => syncActiveTab(windowId))
})

// ---- Keepalive ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BRIDGE_KEEPALIVE_ALARM) return
  if (panelPorts.size === 0) {
    if (bridge === null || bridge.state !== 'connected') disarmBridgeKeepalive()
    return
  }
  // `stopped` is intentionally terminal until an explicit panel reopen or
  // settings save. In particular, code 4000 means another browser owns the
  // single bridge slot and the keepalive must not reclaim it.
  if (bridge === null || bridge.state === 'reconnecting') {
    void settingsReady.then(() => startBridge())
  }
})

// ---- Boot ----

interface FirefoxSidebarAction {
  open(): Promise<void> | void
}

function openAssistantPanel(windowId?: number): void {
  if (import.meta.env.EXT_TARGET === 'firefox') {
    const sidebar = (chrome as unknown as { sidebarAction?: FirefoxSidebarAction }).sidebarAction
    if (sidebar === undefined) return
    void Promise.resolve(sidebar.open()).catch(() => {})
    return
  }
  if (windowId !== undefined) void chrome.sidePanel.open({ windowId }).catch(() => {})
}

// An actual toolbar action is the only way to grant native activeTab access.
// Opening a side panel from the browser menu does not authorize a webpage.
chrome.action?.onClicked.addListener(tab => {
  openAssistantPanel(tab.windowId)
  void pageAccess.grantFromAction(tab).then(() => {
    broadcastPageAccess()
    syncSelectionWatch()
  }).catch(() => { broadcastPageAccess() })
})
if (import.meta.env.EXT_TARGET !== 'firefox') {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
}
void pageAccess.cleanExpiredGroups().catch(() => {})

// Alarms survive some extension/service-worker restarts. Remove any stale
// schedule left by an older eager-connection build; onConnect re-arms it.
disarmBridgeKeepalive()

// `settingsReady` intentionally has no bridge-start continuation: opening a
// side panel is the first action allowed to claim the bridge connection.
