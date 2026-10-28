import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { BRIDGE_PAIRING_PATH } from './protocol.ts'
import { isLoopbackAddress, isLoopbackHost, type BridgeServer } from './server.ts'
import type { PairingStore } from './pairing.ts'
import { verifyToken } from './token.ts'

const MAX_BODY_BYTES = 2_048

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
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
export function createPairingRoute(store: PairingStore, server: BridgeServer, adminToken: string): WebRoute {
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
