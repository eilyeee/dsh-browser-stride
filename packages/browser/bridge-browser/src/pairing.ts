import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { verifyToken } from './token.ts'

interface PairingRecord {
  credentialHash: string
  createdAt: number
}

/** A Host-issued one-time code is valid for five minutes. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000

function hashCredential(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function validInstallationId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{16,128}$/.test(value)
}

/** Per-profile pairing authority. Only credential hashes are persisted. */
export class PairingStore {
  private records: Record<string, PairingRecord> | undefined
  private pending: { code: string; expiresAt: number } | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  issue(): { code: string; expiresAt: number } {
    const code = randomBytes(16).toString('hex')
    this.pending = { code, expiresAt: this.now() + PAIRING_CODE_TTL_MS }
    return { ...this.pending }
  }

  /** Called only after a Host owner approves this exact installation request. */
  enroll(installationId: string): Promise<string> {
    return this.exclusive(async () => {
      if (!validInstallationId(installationId)) throw new Error('invalid installation identifier')
      const records = await this.load()
      const existing = records[installationId]
      const credential = randomBytes(32).toString('hex')
      records[installationId] = { credentialHash: hashCredential(credential), createdAt: this.now() }
      try { await this.save(records) } catch (error) {
        if (existing === undefined) delete records[installationId]
        else records[installationId] = existing
        throw error
      }
      return credential
    })
  }

  authenticate(installationId: string, token: string): Promise<{ credential?: string } | undefined> {
    return this.exclusive(async () => {
      if (!validInstallationId(installationId)) return undefined
      const records = await this.load()
      const existing = records[installationId]
      if (existing !== undefined && verifyToken(existing.credentialHash, hashCredential(token))) return {}
      const pending = this.pending
      if (pending === undefined || this.now() >= pending.expiresAt || !verifyToken(pending.code, token)) return undefined
      // Consume before any I/O: a code can never authorize two installations.
      this.pending = undefined
      const credential = randomBytes(32).toString('hex')
      records[installationId] = { credentialHash: hashCredential(credential), createdAt: this.now() }
      try {
        await this.save(records)
      } catch (error) {
        if (existing === undefined) delete records[installationId]
        else records[installationId] = existing
        throw error
      }
      return { credential }
    })
  }

  list(): Promise<Array<{ installationId: string; createdAt: number }>> {
    return this.exclusive(async () => Object.entries(await this.load())
      .map(([installationId, record]) => ({ installationId, createdAt: record.createdAt })))
  }

  revoke(installationId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const records = await this.load()
      const previous = records[installationId]
      if (previous === undefined) return false
      delete records[installationId]
      try {
        await this.save(records)
      } catch (error) {
        records[installationId] = previous
        throw error
      }
      return true
    })
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<Record<string, PairingRecord>> {
    if (this.records !== undefined) return this.records
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = Object.create(null) as Record<string, PairingRecord>
        return this.records
      }
      throw error
    }
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid pairing store')
    const data = value as { version?: unknown; installations?: unknown }
    if (data.version !== 1 || typeof data.installations !== 'object' || data.installations === null || Array.isArray(data.installations)) {
      throw new Error('invalid pairing store')
    }
    const records: Record<string, PairingRecord> = Object.create(null) as Record<string, PairingRecord>
    for (const [id, entry] of Object.entries(data.installations)) {
      if (!validInstallationId(id) || typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('invalid pairing record')
      const record = entry as Partial<PairingRecord>
      if (typeof record.credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.credentialHash)
        || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) throw new Error('invalid pairing record')
      records[id] = { credentialHash: record.credentialHash, createdAt: record.createdAt }
    }
    this.records = records
    return records
  }

  private async save(records: Record<string, PairingRecord>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, installations: records })}\n`, { mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
    } catch (error) {
      // No secret is present in the temporary file, but do not retain it after a failed write.
      const { rm } = await import('node:fs/promises')
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}
