// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { localBridgeUrl } from '../src/background/bridge-address.ts'

describe('local bridge address', () => {
  it('normalizes a literal loopback Host address', () => {
    expect(localBridgeUrl('http://127.0.0.1:3080')).toBe('ws://127.0.0.1:3080/ext/bridge')
    expect(localBridgeUrl('ws://127.0.0.1:3080/ext/bridge')).toBe('ws://127.0.0.1:3080/ext/bridge')
  })

  it('rejects remote endpoints, credentials and altered paths before sending a token', () => {
    for (const value of ['ws://example.test/ext/bridge', 'ws://127.0.0.1.evil.test/ext/bridge',
      'ws://user:pass@127.0.0.1:3080/ext/bridge', 'ws://127.0.0.1:3080/other',
      'ws://127.0.0.1:3080/ext/bridge?token=secret']) {
      expect(localBridgeUrl(value)).toBeUndefined()
    }
  })
})
