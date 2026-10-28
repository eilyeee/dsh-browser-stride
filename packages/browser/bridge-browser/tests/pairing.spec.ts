import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PAIRING_CODE_TTL_MS, PairingStore } from '../src/pairing.ts'

let directory: string | undefined
afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function store(now?: () => number): Promise<{ file: string; pairing: PairingStore }> {
  directory = await mkdtemp(join(tmpdir(), 'stride-pairing-'))
  const file = join(directory, 'pairings.json')
  return { file, pairing: new PairingStore(file, now) }
}

describe('installation pairing authority', () => {
  it('consumes a code once, stores only a hash, and survives a restart', async () => {
    const { file, pairing } = await store()
    const { code } = pairing.issue()
    const [first, second] = await Promise.all([
      pairing.authenticate('installation-111111111111', code),
      pairing.authenticate('installation-222222222222', code),
    ])
    expect(first?.credential).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toBeUndefined()
    const persisted = await readFile(file, 'utf8')
    expect(persisted).not.toContain(code)
    expect(persisted).not.toContain(first!.credential!)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    const restarted = new PairingStore(file)
    expect(await restarted.authenticate('installation-111111111111', first!.credential!)).toEqual({})
    expect(await restarted.authenticate('installation-222222222222', first!.credential!)).toBeUndefined()
    expect(await restarted.authenticate('installation-111111111111', code)).toBeUndefined()
    expect(await restarted.revoke('installation-111111111111')).toBe(true)
    expect(await new PairingStore(file).authenticate('installation-111111111111', first!.credential!)).toBeUndefined()
  })

  it('expires and supersedes unused codes and rejects invalid installation identifiers', async () => {
    let now = 1000
    const { pairing } = await store(() => now)
    const old = pairing.issue()
    const current = pairing.issue()
    expect(await pairing.authenticate('installation-111111111111', old.code)).toBeUndefined()
    expect(await pairing.authenticate('short', current.code)).toBeUndefined()
    now += PAIRING_CODE_TTL_MS
    expect(await pairing.authenticate('installation-111111111111', current.code)).toBeUndefined()
    expect(await pairing.list()).toEqual([])
  })

  it('fails closed on a corrupted store instead of silently losing revocations', async () => {
    const { file } = await store()
    await writeFile(file, '{"version":1,"installations":{"bad":{}}}')
    const pairing = new PairingStore(file)
    await expect(pairing.authenticate('installation-111111111111', pairing.issue().code)).rejects.toThrow('invalid pairing record')
    await expect(pairing.list()).rejects.toThrow('invalid pairing record')
  })
})
