// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { readBridgeCredential, readBridgeDisconnected, writeBridgeCredential } from '../src/background/credential-store.ts'

describe('extension-origin credential storage', () => {
  it('keeps a durable disconnect marker until explicit pairing and rejects superseded writes', async () => {
    await writeBridgeCredential('old', 'enable')
    await writeBridgeCredential('', 'disable')
    expect(await readBridgeCredential()).toBeUndefined()
    expect(await readBridgeDisconnected()).toBe(true)
    await expect(writeBridgeCredential('late', 'enable', () => false)).rejects.toThrow('superseded')
    expect(await readBridgeCredential()).toBeUndefined()
    expect(await readBridgeDisconnected()).toBe(true)
    await writeBridgeCredential('new', 'enable')
    expect(await readBridgeCredential()).toBe('new')
    expect(await readBridgeDisconnected()).toBe(false)
  })

  it('persists, replaces and deletes a credential across separate database connections', async () => {
    expect(await readBridgeCredential()).toBeUndefined()
    await writeBridgeCredential('first')
    expect(await readBridgeCredential()).toBe('first')
    await writeBridgeCredential('second')
    expect(await readBridgeCredential()).toBe('second')
    await writeBridgeCredential('')
    expect(await readBridgeCredential()).toBeUndefined()
  })
})
