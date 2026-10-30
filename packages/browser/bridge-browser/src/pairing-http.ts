import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { BRIDGE_PAIRING_PATH, BRIDGE_PROTOCOL_VERSION } from './protocol.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { PAIRING_OWNER_PATH, PAIRING_REQUEST_PATH, type PairingRequests } from './pairing-requests.ts'
import { isLoopbackAddress, isLoopbackHost, type BridgeServer } from './server.ts'
import type { PairingStore } from './pairing.ts'
import { verifyToken } from './token.ts'

const MAX_BODY_BYTES = 2_048

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

/** Public admission creates only a bounded request; it never authorizes a browser. */
export function createPairingRequestRoute(requests: PairingRequests): WebRoute {
  return {
    kind: 'exact', path: PAIRING_REQUEST_PATH,
    handler: async (req, res) => {
      const origin = req.headers.origin
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)
        || (origin !== undefined && !/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-zA-Z0-9-]+)$/.test(origin))) {
        respond(res, 403, { error: 'local-extension-required' })
        return
      }
      if (req.method !== 'POST') { respond(res, 405, { error: 'POST-required' }); return }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') {
        respond(res, 415, { error: 'JSON-required' }); return
      }
      try {
        const input = await body(req)
        if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('invalid-request')
        const request = input as Record<string, unknown>
        if (request.action === 'request') {
          if (request.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
            respond(res, 409, { error: typeof request.protocolVersion === 'number' && request.protocolVersion > BRIDGE_PROTOCOL_VERSION
              ? 'protocol-upgrade-host' : 'protocol-upgrade-extension' })
            return
          }
          if (typeof request.installationId !== 'string' || typeof request.proofKey !== 'string') throw new Error('invalid-request')
          respond(res, 200, requests.request(request.installationId, request.proofKey))
        } else {
          if (typeof request.requestId !== 'string' || typeof request.proofKey !== 'string') throw new Error('invalid-request')
          if (request.action === 'claim') respond(res, 200, await requests.claim(request.requestId, request.proofKey))
          else if (request.action === 'cancel') {
            requests.cancel(request.requestId, request.proofKey)
            respond(res, 200, { cancelled: true })
          } else throw new Error('invalid-request')
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'pairing-busy') respond(res, 429, { error: code })
        else if (code === 'pairing-unavailable') respond(res, 410, { error: code })
        else respond(res, 400, { error: 'pairing-request-failed' })
      }
    },
  }
}

/** Register through Connection.fetch, whose carrier requires an authenticated owner. */
export function createPairingOwnerRoute(requests: PairingRequests): ConnectionFetchRoute {
  const json = (status: number, value: unknown): Response => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
  return {
    path: PAIRING_OWNER_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      const origin = request.headers.get('origin')
      if (origin !== null) {
        // Connection preserves the authenticated physical Host header, but its
        // Fetch adapter intentionally uses http://dsh.internal as request.url.
        let sameOrigin = false
        try {
          const protocol = new URL(origin).protocol
          const host = request.headers.get('host')
          sameOrigin = host !== null && (protocol === 'http:' || protocol === 'https:')
            && origin === new URL(`${protocol}//${host}`).origin
        } catch { /* malformed origins fail closed */ }
        if (!sameOrigin) return json(403, { error: 'same-origin-required' })
      }
      if (request.method === 'GET') return json(200, { requests: requests.list() })
      if (request.method !== 'POST') return json(405, { error: 'POST-required' })
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') return json(415, { error: 'JSON-required' })
      try {
        const text = await request.text()
        if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('request too large')
        const input = JSON.parse(text) as Record<string, unknown> | null
        if (input === null || typeof input !== 'object' || typeof input.requestId !== 'string'
          || typeof input.verificationCode !== 'string' || (input.decision !== 'approve' && input.decision !== 'deny')) {
          return json(400, { error: 'invalid-decision' })
        }
        return requests.decide(input.requestId, input.verificationCode, input.decision)
          ? json(200, { decided: true }) : json(409, { error: 'request-no-longer-pending' })
      } catch { return json(400, { error: 'invalid-decision' }) }
    },
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string)
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** The administrator credential is never a browser credential. */
export function createPairingRoute(store: PairingStore, server: BridgeServer, adminToken: string, requests?: PairingRequests): WebRoute {
  return {
    kind: 'exact',
    path: BRIDGE_PAIRING_PATH,
    handler: (req, res) => {
      if (!isLoopbackAddress(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host) || req.headers.origin !== undefined) {
        respond(res, 403, { error: 'local administrator required' })
        return
      }
      if (req.method !== 'POST') {
        respond(res, 405, { error: 'POST required' })
        return
      }
      const authorization = req.headers.authorization ?? ''
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!verifyToken(adminToken, supplied)) {
        respond(res, 401, { error: 'administrator authentication required' })
        return
      }
      void (async () => {
        try {
          const input = await body(req)
          if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            respond(res, 400, { error: 'invalid request' })
            return
          }
          const request = input as { action?: unknown; installationId?: unknown }
          if (request.action === 'issue') {
            respond(res, 200, store.issue())
          } else if (request.action === 'list') {
            respond(res, 200, { installations: await store.list() })
          } else if (request.action === 'revoke' && typeof request.installationId === 'string') {
            requests?.revokeInstallation(request.installationId)
            const revoked = await store.revoke(request.installationId)
            if (revoked) server.revokeInstallation(request.installationId)
            respond(res, 200, { revoked })
          } else {
            respond(res, 400, { error: 'invalid action' })
          }
        } catch {
          respond(res, 400, { error: 'pairing request failed' })
        }
      })()
    },
  }
}
