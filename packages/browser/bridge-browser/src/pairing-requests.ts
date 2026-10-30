import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PairingStore } from './pairing.ts'
import { PAIRING_CODE_TTL_MS } from './pairing.ts'
import { verifyToken } from './token.ts'

export { BRIDGE_PAIRING_REQUEST_PATH as PAIRING_REQUEST_PATH, BRIDGE_PAIRING_OWNER_PATH as PAIRING_OWNER_PATH } from './protocol.ts'
export const MAX_PAIRING_REQUESTS = 8

interface PendingPairing {
  requestId: string
  installationId: string
  verificationCode: string
  expiresAt: number
  status: 'pending' | 'approved' | 'denied'
  proofHash: string
}

export type PairingRequestView = Omit<PendingPairing, 'proofHash'>

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Short-lived requests are not authorization. Only the authenticated owner may decide. */
export class PairingRequests {
  private readonly requests = new Map<string, PendingPairing>()
  private readonly enrollments = new Set<Promise<string>>()
  private closed = false

  constructor(
    private readonly store: PairingStore,
    private readonly revokeConnection: (installationId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  request(installationId: string, proofKey: string): PairingRequestView {
    if (this.closed) throw new Error('pairing-unavailable')
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(installationId) || !/^[a-f0-9]{64}$/.test(proofKey)) {
      throw new Error('invalid-request')
    }
    this.prune()
    if (this.requests.size >= MAX_PAIRING_REQUESTS) throw new Error('pairing-busy')
    if ([...this.requests.values()].some(request => request.installationId === installationId)) throw new Error('pairing-busy')
    const request: PendingPairing = {
      requestId: randomUUID(), installationId, proofHash: hash(proofKey),
      verificationCode: randomBytes(4).toString('hex').toUpperCase(),
      expiresAt: this.now() + PAIRING_CODE_TTL_MS, status: 'pending',
    }
    this.requests.set(request.requestId, request)
    return this.view(request)
  }

  list(): PairingRequestView[] {
    this.prune()
    return [...this.requests.values()].filter(request => request.status !== 'denied').map(request => this.view(request))
  }

  decide(requestId: string, verificationCode: string, decision: 'approve' | 'deny'): boolean {
    this.prune()
    const request = this.requests.get(requestId)
    if (request === undefined || request.status !== 'pending' || request.verificationCode !== verificationCode) return false
    request.status = decision === 'approve' ? 'approved' : 'denied'
    return true
  }

  async claim(requestId: string, proofKey: string): Promise<{ status: 'pending' | 'denied' } | { status: 'paired'; credential: string }> {
    const request = this.owned(requestId, proofKey)
    if (request.status !== 'approved') return { status: request.status }
    // Consume synchronously, before storage I/O. A lost response requires a new
    // explicit approval; neither polling nor a restart replays a credential.
    this.requests.delete(requestId)
    const enrollment = this.store.enroll(request.installationId)
    this.enrollments.add(enrollment)
    try {
      const credential = await enrollment
      this.revokeConnection(request.installationId)
      return { status: 'paired', credential }
    } finally { this.enrollments.delete(enrollment) }
  }

  cancel(requestId: string, proofKey: string): void {
    this.owned(requestId, proofKey)
    this.requests.delete(requestId)
  }

  revokeInstallation(installationId: string): void {
    for (const [id, request] of this.requests) if (request.installationId === installationId) this.requests.delete(id)
  }

  async close(): Promise<void> {
    this.closed = true
    this.requests.clear()
    await Promise.allSettled([...this.enrollments])
  }

  private owned(requestId: string, proofKey: string): PendingPairing {
    this.prune()
    if (this.closed) throw new Error('pairing-unavailable')
    const request = this.requests.get(requestId)
    if (request === undefined || !/^[a-f0-9]{64}$/.test(proofKey) || !verifyToken(request.proofHash, hash(proofKey))) {
      throw new Error('pairing-unavailable')
    }
    return request
  }

  private prune(): void {
    for (const [id, request] of this.requests) if (this.now() >= request.expiresAt) this.requests.delete(id)
  }

  private view({ proofHash: _proof, ...request }: PendingPairing): PairingRequestView { return request }
}
