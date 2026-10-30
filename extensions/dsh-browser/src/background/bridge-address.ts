import { BRIDGE_PATH } from '@eilyeee/dsh-stride-browser-bridge/src/protocol.ts'

/** Only literal local addresses can receive the bridge credential. */
export function localBridgeUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:') url.protocol = 'ws:'
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1'
      || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
    if (url.pathname === '/' || url.pathname === '') url.pathname = BRIDGE_PATH
    if (url.pathname !== BRIDGE_PATH) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
