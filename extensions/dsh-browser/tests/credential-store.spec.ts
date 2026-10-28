// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { readBridgeCredential, writeBridgeCredential } from '../src/background/credential-store.ts'

describe('extension-origin credential storage', () => {
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
