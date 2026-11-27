import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { z } from 'zod'
import type { BrowserDispatchLedger, DispatchRecord } from './dispatch-ledger.ts'
import { LOCAL_BROWSER_PATH, LOCAL_REQUEST_PREFIX, documentReadGuidance, isAutonomousWikiUrl, localBrowserRequest, localDocumentResult, localOperationId, localPageUrl } from './local-browser-contract.ts'
import { BridgeToolError, isLoopbackAddress, isLoopbackHost, type BridgeServer } from './server.ts'
import { verifyToken } from './token.ts'
import { toolCommandMaterial } from './tool-identity.ts'
import { allowsIframeOrigin, type IframeScope } from './iframe-scopes.ts'

const session = z.string().min(1).max(200).refine(value => value === value.trim())
const localOrigin = z.string().refine(value => {
  const parsed = localPageUrl.safeParse(value)
  return parsed.success && new URL(parsed.data).origin === value
})
export const localBrowserConfig = z.strictObject({
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  sessionId: session,
  documentSessionIds: z.array(session).max(10).optional(),
  allowedOrigins: z.array(localOrigin).min(1).max(30),
  autonomousWiki: z.strictObject({ sessionId: session, origins: z.array(localOrigin).min(1).max(30) }).optional(),
  allowActions: z.boolean().optional(),
  allowGuardedForms: z.boolean().optional(),
}).refine(config => config.autonomousWiki === undefined || (config.autonomousWiki.sessionId !== config.sessionId
  && config.autonomousWiki.origins.every(origin => config.allowedOrigins.includes(origin))),
'Autonomous Wiki requires a separate selected session and a subset of the configured origins')
export type LocalBrowserConfig = z.infer<typeof localBrowserConfig>

const SECRET = /^[A-Za-z0-9_-]{32,256}$/
const MAX_BODY_BYTES = 128_000
const TEXT_RESULT = z.object({ text: z.string().max(250_000) })

function respond(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Server-to-server ingress. The selected DSH session and origin limit come from Host configuration. */
export function createLocalBrowserRoute(config: LocalBrowserConfig, server: Pick<BridgeServer, 'requestTool'>,
  ledger: Pick<BrowserDispatchLedger, 'get'>, credential: string, bridgeToken: string, iframeScopes?: readonly IframeScope[]): WebRoute {
  if (!SECRET.test(credential) || verifyToken(bridgeToken, credential)) {
    throw new Error('bridge-browser: local browser client requires a separate service credential')
  }
  const inFlight = new Map<string, string>()
  const allowedOrigins = new Set(config.allowedOrigins)
  const documentSessions = [...new Set([config.sessionId, ...(config.documentSessionIds ?? [])])]
  let wikiReading = false
  const digest = (operationId: string, name: string, args: Record<string, unknown>, row?: DispatchRecord) =>
    createHash('sha256').update(toolCommandMaterial({ actionId: row?.actionId ?? operationId, name, args, sessionId: config.sessionId,
      ...(row?.runId === undefined ? {} : { execution: { kind: 'run', runId: row.runId, controlRevision: row.controlRevision! } }),
      ...(row?.targetBinding === undefined ? {} : { targetBinding: row.targetBinding }) })).digest('hex')
  const receipt = (operationId: string) => {
    const row = ledger.get(`${LOCAL_REQUEST_PREFIX}${operationId}`)
    if (row === undefined || row.sessionId !== config.sessionId) {
      return { operationId, status: inFlight.has(operationId) ? 'pending' : 'not-recorded' }
    }
    if (row.state === 'prepared' || row.state === 'sent_unconfirmed') return { operationId, status: 'pending' }
    if (row.state === 'not_sent' || row.receipt?.notApplied === true) return { operationId, status: 'not-applied' }
    if (row.receipt?.ok === true && !row.receipt.readbackUnconfirmed) {
      return { operationId, status: 'returned', ...(row.receipt.jenkinsQueueId === undefined ? {} : { jenkinsQueueId: row.receipt.jenkinsQueueId }) }
    }
    return { operationId, status: 'unknown' }
  }
  async function readDocument(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let busy: BridgeToolError | undefined
    for (const sessionId of documentSessions) {
      try { return await server.requestTool(tool, args, signal, undefined, sessionId, { local: true }) }
      catch (error) {
        if (!(error instanceof BridgeToolError)) throw error
        if (error.code === 'session-busy') busy = error
        else if (error.code !== 'permission-required') throw error
      }
    }
    throw busy ?? new BridgeToolError('permission-required', 'Select the requested document in a configured DSH session.', true)
  }
  async function readAutonomousWiki(expectedUrl: string, args: Record<string, unknown>, signal: AbortSignal) {
    const sessionId = config.autonomousWiki!.sessionId
    if (wikiReading) throw new BridgeToolError('session-busy', 'The autonomous Wiki session is currently reading.', true)
    wikiReading = true
    const client = { local: true } as const
    const wikiArgs = { ...args, localAutonomousWiki: true }
    const open = () => server.requestTool('browser_open_tab', { url: expectedUrl, active: false, localAutonomousWiki: true },
      signal, undefined, sessionId, client)
    const read = () => server.requestTool('browser_get_text', wikiArgs, signal, undefined, sessionId, client)
    try {
      await open()
      try { return await read() }
      catch (error) {
        if (!(error instanceof BridgeToolError) || error.code !== 'document-version-stale') throw error
      }
      await server.requestTool('browser_reload', { localPageUrl: expectedUrl, frame: 0, localAutonomousWiki: true },
        signal, undefined, sessionId, client)
      await open()
      return await read()
    } finally { wikiReading = false }
  }
  return {
    kind: 'exact', path: LOCAL_BROWSER_PATH,
    handler: async (req, res) => {
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)
        || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
        respond(res, 403, { error: 'local-service-required' }); return
      }
      if (!verifyToken(`Bearer ${credential}`, req.headers.authorization ?? '')) {
        respond(res, 401, { error: 'service-credential-required' }); return
      }
      const query = new URLSearchParams((req.url ?? '').split('?')[1])
      if (req.method === 'GET') {
        const id = localOperationId.safeParse(query.get('operationId'))
        if (!id.success || query.size !== 1) { respond(res, 400, { error: 'bad-args' }); return }
        try { respond(res, 200, receipt(id.data)) }
        catch { respond(res, 503, { error: 'receipt-unavailable' }) }
        return
      }
      if (req.method !== 'POST') { respond(res, 405, { error: 'GET-or-POST-required' }); return }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        respond(res, 415, { error: 'JSON-required' }); return
      }
      const parsed = localBrowserRequest.safeParse(await jsonBody(req).catch(() => undefined))
      if (!parsed.success || query.size !== 0) { respond(res, 400, { error: 'bad-args' }); return }
      const { action, expectedUrl, ...operation } = parsed.data
      const origin = new URL(expectedUrl).origin
      if (!allowedOrigins.has(origin) || parsed.data.action === 'navigate' && new URL(parsed.data.url).origin !== origin) {
        respond(res, 403, { error: 'origin-not-allowed' }); return
      }
      const autonomousWiki = parsed.data.action === 'document' && parsed.data.autoOpen === true
      if (autonomousWiki && (!config.autonomousWiki?.origins.includes(origin) || !isAutonomousWikiUrl(expectedUrl))) {
        respond(res, 403, { error: 'autonomous-wiki-not-allowed' }); return
      }
      const operationId = 'operationId' in operation ? operation.operationId : undefined
      const formFill = parsed.data.action === 'click' ? parsed.data.formFill : undefined
      const iframe = 'iframe' in operation ? operation.iframe : undefined
      if (iframe !== undefined && (!allowedOrigins.has(iframe.origin) || !allowsIframeOrigin(iframeScopes, expectedUrl, iframe.origin))) {
        respond(res, 403, { error: 'iframe-origin-not-allowed' }); return
      }
      if (iframe !== undefined && formFill !== undefined) { respond(res, 400, { error: 'bad-args' }); return }
      if ((action === 'json' || action === 'jenkins-log' || formFill !== undefined) && config.allowGuardedForms !== true) {
        respond(res, 403, { error: 'guarded-forms-disabled' }); return
      }
      if (parsed.data.action === 'json' && new URL(parsed.data.url).origin !== origin
        || parsed.data.action === 'jenkins-log' && new URL(parsed.data.log.url).origin !== origin) {
        respond(res, 403, { error: 'origin-not-allowed' }); return
      }
      const args: Record<string, unknown> = { ...operation, localPageUrl: expectedUrl, frame: iframe !== undefined && 'frame' in iframe ? iframe.frame : 0 }
      delete args.iframe
      delete args.operationId
      delete args.formFill
      delete args.autoOpen
      if (iframe !== undefined) args.localIframeOrigin = iframe.origin
      if (formFill !== undefined) args.localFormFill = formFill
      if (parsed.data.action === 'json') {
        delete args.url
        args.localJsonUrl = parsed.data.url
      }
      if (parsed.data.action === 'jenkins-log') {
        delete args.log
        args.localJenkinsLog = parsed.data.log
      }
      if (parsed.data.action === 'document') {
        delete args.document
        args.localDocument = parsed.data.document
      }
      const tool = action === 'document' || action === 'text' || action === 'json' || action === 'jenkins-log' ? 'browser_get_text' : `browser_${action}`
      if (operationId !== undefined) {
        if (config.allowActions !== true) { respond(res, 403, { error: 'actions-disabled' }); return }
        try {
          const row = ledger.get(`${LOCAL_REQUEST_PREFIX}${operationId}`)
          const current = inFlight.get(operationId)
          const fingerprint = digest(operationId, tool, args)
          if ((current !== undefined && current !== fingerprint)
            || (row !== undefined && (row.sessionId !== config.sessionId || row.requestDigest !== digest(operationId, tool, args, row)))) {
            respond(res, 409, { error: 'operation-id-conflict' }); return
          }
          const existing = receipt(operationId)
          if (existing.status !== 'not-recorded') { respond(res, 200, existing); return }
          inFlight.set(operationId, fingerprint)
        } catch { respond(res, 503, { error: 'receipt-unavailable' }); return }
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      if (res.destroyed) abort()
      try {
        const value = autonomousWiki ? await readAutonomousWiki(expectedUrl, args, controller.signal)
          : action === 'document' ? await readDocument(tool, args, controller.signal)
          : await server.requestTool(tool, args, controller.signal, undefined, config.sessionId,
            { local: true, ...(operationId === undefined ? {} : { requestId: `${LOCAL_REQUEST_PREFIX}${operationId}` }) })
        if (operationId !== undefined) {
          const state = receipt(operationId)
          const result = TEXT_RESULT.safeParse(value)
          respond(res, 200, { ...state, ...(state.status === 'returned' && result.success ? { result: result.data } : {}) })
        } else {
          const result = action === 'document' ? localDocumentResult.safeParse((value as { document?: unknown } | null)?.document) : TEXT_RESULT.safeParse(value)
          respond(res, result.success ? 200 : 502, result.success ? { result: result.data } : { error: 'invalid-browser-result' })
        }
      } catch (error) {
        if (operationId === undefined) {
          const code = error instanceof BridgeToolError ? error.code : 'browser-unavailable'
          const message = action === 'document' ? documentReadGuidance(code) : undefined
          respond(res, 409, { error: code, ...(message === undefined ? {} : { message }) })
        } else {
          inFlight.delete(operationId)
          try {
            const state = receipt(operationId)
            const rejectedBeforeSend = state.status === 'not-recorded' && error instanceof BridgeToolError && error.notDispatched
            respond(res, 200, { ...state, ...(rejectedBeforeSend ? { status: 'not-applied' } : {}),
              ...(error instanceof BridgeToolError ? { error: error.code } : {}) })
          } catch { respond(res, 503, { error: 'receipt-unavailable' }) }
        }
      } finally {
        res.removeListener('close', abort)
        if (operationId !== undefined) inFlight.delete(operationId)
      }
    },
  }
}
