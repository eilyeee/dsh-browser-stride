/**
 * `@yuxianglin/dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the /api trust fence — so it brings its own bearer-token
 * authentication (first frame `hello` within HELLO_TIMEOUT_MS). Extension
 * calls, Session streams, and Host waterfalls use dsh's Typert Gateway
 * and Connection services.
 * Tools execute by dispatching
 * `tool.call` frames to the connected extension, which performs the action in
 * the tab explicitly controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No dsh core code is touched.
 *
 * @module @yuxianglin/dsh-bridge-browser
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer, isLoopbackAddress, isLoopbackHost } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { BROWSER_SYSTEM_PROMPT } from './browser-policy.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { withSessionDeferral } from './session-deferral.ts'
import { withSessionWorkspace } from './session-workspace.ts'
import { purgeSessionFiles, type SessionPurgeDeps } from './session-purge.ts'
import { resolveToken } from './token.ts'
import { PairingStore } from './pairing.ts'
import { createPairingRoute } from './pairing-http.ts'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from './remote-host-api.ts'
import { isRecord, type BrowserHostApi } from './host-api.ts'
import { BrowserRunStore } from './run-store.ts'
export { computeToolCommandDigest } from './tool-identity.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'typertGateway', 'connection', 'tools', 'agents', 'storageDomain']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Default directory backing the browser extension's session group. */
const DEFAULT_SESSION_WORKSPACE_PATH = dshHomePath('browser-sessions')

/** Durable session storage root written by the JSONL persistence plugin. */
const SESSIONS_ROOT = dshHomePath('sessions')

/** Default: sessions materialize only on the first message (open-and-close leaves no trace). */
const DEFAULT_DEFER_SESSION_CREATE = true

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Separately authorize browser access to Host settings, credentials and local paths. */
  allowHostManagement?: boolean
  /** Explicit profile namespace for installation credentials and browser run records. */
  pairingProfile?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
  /** Dedicated workspace path for extension-created sessions. Empty disables grouping. */
  sessionWorkspacePath?: string
  /** Defer real session creation until the first prompt. Defaults to true. */
  deferSessionCreate?: boolean
}

export const Config: z<Config> = z.object({
  token: z.string(),
  allowHostManagement: z.boolean().default(false),
  pairingProfile: z.string().default('web'),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspacePath: z.string().default(DEFAULT_SESSION_WORKSPACE_PATH),
  deferSessionCreate: z.boolean().default(DEFAULT_DEFER_SESSION_CREATE),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`bridge-browser: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    allowHostManagement: config.allowHostManagement ?? false,
    pairingProfile: config.pairingProfile ?? 'web',
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
    sessionWorkspacePath: config.sessionWorkspacePath ?? DEFAULT_SESSION_WORKSPACE_PATH,
    deferSessionCreate: config.deferSessionCreate ?? DEFAULT_DEFER_SESSION_CREATE,
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(resolved.pairingProfile)) {
    throw new Error('bridge-browser: pairingProfile must contain 1–64 letters, digits, underscores or hyphens')
  }
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const gateway = ctx.get('typertGateway') as unknown as GatewayCandidate | undefined
  const connection = ctx.get('connection') as unknown as HostConnectionLike | undefined
  if (gateway === undefined || !hasRemoteWireStream(gateway)) {
    throw new Error('bridge-browser: dsh 0.2.1-rc.2 or a compatible newer runtime is required (Gateway wireStream unavailable)')
  }
  if (connection === undefined || typeof connection.createPeer !== 'function') {
    throw new Error('bridge-browser: dsh 0.2.1-rc.2 connection service with createPeer is required')
  }
  const storage = ctx.get('storageDomain')
  if (storage === undefined || typeof storage.open !== 'function') {
    throw new Error('bridge-browser: DSH storageDomain service is required for browser run records')
  }
  const runs = await BrowserRunStore.open(storage, resolved.pairingProfile)
  const lifetime: { server?: BridgeServer } = {}
  // Cordis disposes separate effects concurrently. Keep this ordering inside
  // one effect so receipt writes drain before their storage domain closes.
  ctx.effect(() => async () => {
    try { await lifetime.server?.close() } finally { await runs.close() }
  }, 'bridge-browser: server and durable records')
  ctx.provide('browserRuns', runs)
  const tokenRes = await resolveToken(resolved.token)
  mountBridge(ctx, resolved, tokenRes, createRemoteHostApi(gateway, connection), runs, lifetime)
}

function mountBridge(
  ctx: Context,
  resolved: ResolvedConfig,
  tokenRes: Awaited<ReturnType<typeof resolveToken>>,
  hostApi: BrowserHostApi,
  runs: BrowserRunStore,
  lifetime: { server?: BridgeServer },
): void {
  // Workspace grouping wraps the gateway create; session deferral wraps the
  // result so materialization at first prompt still flows through grouping.
  const api = withSessionDeferral(
    withSessionWorkspace(
      hostApi,
      resolved.sessionWorkspacePath,
      message => { ctx.logger.warn(message) },
    ),
    resolved.deferSessionCreate,
    ctx.get('attachments')?.imageLimits,
  )
  const browserContext = new BrowserContextInjector(ctx.agents)
  // DSH 0.1.7+ replaced `agent/session-start` with `agent/created` as the
  // startup-driving extension point (agent registered with live session and
  // completed setup); bind there so deferred sessions still receive their
  // pending browser snapshot at materialization.
  ctx.on('agent/created', ({ agent }) => {
    browserContext.activate(agent)
  })

  const purgeSession = async (sessionId: string): Promise<void> => {
    const runningSessionIds = new Set<string>()
    try {
      const listed = await api.call({
        rpcId: randomUUID(),
        method: 'session.list',
        payload: {},
        signal: new AbortController().signal,
      })
      if (listed.ok && isRecord(listed.value) && Array.isArray(listed.value.items)) {
        for (const entry of listed.value.items) {
          if (isRecord(entry) && entry.running === true && typeof entry.sessionId === 'string') {
            runningSessionIds.add(entry.sessionId)
          }
        }
      }
    } catch {
      // Listing is advisory; the required exclusive persistence handle below
      // protects both active and idle sessions, including in other processes.
    }
    const deps: SessionPurgeDeps = {
      sessionsRoot: SESSIONS_ROOT,
      runningSessionIds,
      acquireOwnership: async (id) => {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          throw new Error('browser bridge: session persistence is required to safely purge a session')
        }
        return persistence.open(id as Parameters<typeof persistence.open>[0], 'write')
      },
      archiveSession: async (id) => {
        const archived = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.archiveSession',
          payload: { sessionId: id },
          signal: new AbortController().signal,
        })
        if (!archived.ok) throw new Error(archived.error.message)
      },
    }
    await runs.dispatches.purgeSession(sessionId, () => purgeSessionFiles(deps, sessionId))
  }

  const pairing = new PairingStore(dshHomePath('browser-bridge-pairings', `${resolved.pairingProfile}.json`))
  const server = new BridgeServer({
    token: tokenRes.token,
    pairing,
    allowHostManagement: resolved.allowHostManagement,
    api,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
    injectBrowserSnapshot: (sessionId, snapshot) => { browserContext.inject(sessionId, snapshot) },
    purgeSession,
    dispatches: runs.dispatches,
  })
  lifetime.server = server

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-browser: /ext/bridge upgrade route')
  ctx.effect(() => ctx.webServer.register(createPairingRoute(pairing, server, tokenRes.token)), 'bridge-browser: pairing administration')

  // Discovery contains no secret and is only exposed to local clients.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (req, res) => {
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
        res.writeHead(403)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-browser: /ext/bridge-config route')

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-browser: browser tools')

  // Optional model guidance complements, but cannot replace, runtime guards.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: BROWSER_SYSTEM_PROMPT,
    }), 'bridge-browser: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: administrator token generated at ${tokenRes.file} (chmod 0600); use the pairing command to connect an extension`
      : `browser bridge: administrator token configured; use the pairing command to connect an extension`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}

type GatewayCandidate = Pick<TypertGatewayLike, 'invoke'> & {
  readonly wireStream?: TypertGatewayLike['wireStream']
}

/** Check the minimum supported Gateway contract before mounting the bridge. */
function hasRemoteWireStream(gateway: GatewayCandidate): gateway is TypertGatewayLike {
  return gateway.wireStream !== undefined
    && typeof gateway.wireStream.open === 'function'
    && typeof gateway.wireStream.failure === 'function'
}
