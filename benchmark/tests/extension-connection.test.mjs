import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { configurePanelConnection, installConnectionProbe, within } from '../lib/extension-connection.mjs'

const url = 'ws://127.0.0.1:45678/ext/bridge'
function event() {
  const listeners = new Set()
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: value => { for (const fn of [...listeners]) fn(value) }, count: () => listeners.size }
}
function panel(options = {}) {
  const onMessage = event(), onDisconnect = event(), sent = []
  let disconnected = false
  const port = { onMessage, onDisconnect, postMessage: value => {
    if (options.throwSend) throw Error('synthetic secret-bearing transport failure')
    sent.push(value)
  }, disconnect: () => { disconnected = true; onDisconnect.emit() } }
  const input = { bridgeUrl: url, pairingCode: 'a'.repeat(32), origin: 'http://127.0.0.1:45679', timeoutMs: 1000, ...options }
  const context = vm.createContext({ chrome: { runtime: { connect: () => port } }, window: {}, crypto: { randomUUID }, setTimeout, clearTimeout, input })
  const pending = vm.runInContext(`(${configurePanelConnection.toString()})(input)`, context)
  const ack = ok => onMessage.emit({ type: 'settings.result', id: sent[0]?.id, ok, error: { message: 'Bearer synthetic-secret' } })
  return { pending, onMessage, onDisconnect, ack, sent, disconnected: () => disconnected }
}

test('fixture connection needs settings acknowledgement and the intended Host, in either arrival order', async () => {
  for (const statusFirst of [false, true]) {
    const h = panel()
    h.onMessage.emit({ type: 'status', state: 'connected', hostIdentity: 'ws://127.0.0.1:3080/ext/bridge' })
    let settled = false; void h.pending.then(() => { settled = true })
    if (statusFirst) h.onMessage.emit({ type: 'status', state: 'connected', hostIdentity: url })
    else h.ack(true)
    await Promise.resolve(); assert.equal(settled, false)
    if (statusFirst) h.ack(true)
    else h.onMessage.emit({ type: 'status', state: 'connected', hostIdentity: url })
    const result = await h.pending
    assert.equal(result.settingsSaved, true)
    assert.equal(h.disconnected(), false)
    assert.equal(h.onMessage.count() + h.onDisconnect.count(), 0)
  }
})

test('settings rejection fails promptly, removes listeners and omits the background error text', async () => {
  const h = panel()
  h.ack(false)
  await assert.rejects(h.pending, error => error.message === 'extension settings were rejected')
  assert.equal(h.disconnected(), true)
  assert.equal(h.onMessage.count() + h.onDisconnect.count(), 0)
})

test('timeout diagnostics are bounded metadata and never contain tokens, URLs or unknown peer strings', async () => {
  const h = panel({ timeoutMs: 5 })
  for (let i = 0; i < 40; i++) h.onMessage.emit({ type: 'status', state: 'reconnecting', hostIdentity: 'Bearer synthetic-secret' })
  h.onMessage.emit({ type: 'status', state: 'Bearer synthetic-secret' })
  await assert.rejects(h.pending, error => {
    assert.ok(!error.message.includes('synthetic-secret'))
    assert.ok(!error.message.includes('a'.repeat(32)))
    assert.ok(!error.message.includes(url))
    const metadata = JSON.parse(error.message.slice(error.message.indexOf('{')))
    assert.equal(metadata.states.length, 16)
    assert.equal(metadata.settingsSaved, false)
    return true
  })
  assert.equal(h.disconnected(), true)
})

test('deferred pairing still requires saved settings and does not send a credential', async () => {
  const h = panel({ deferred: true, pairingCode: undefined })
  assert.equal(Object.hasOwn(h.sent[0].settings, 'token'), false)
  h.ack(true)
  assert.equal((await h.pending).settingsSaved, true)
})

test('disconnected and synchronously broken ports fail without retaining their listeners', async () => {
  const h = panel()
  h.onDisconnect.emit()
  await assert.rejects(h.pending, /port disconnected/)
  const broken = panel({ throwSend: true })
  await assert.rejects(broken.pending, error => error.message === 'extension settings could not be sent')
  assert.equal(broken.onMessage.count() + broken.onDisconnect.count(), 0)
})

test('the parent deadline covers a renderer that never settles its own promise', async () => {
  await assert.rejects(within(new Promise(() => {}), 5, 'synthetic initialization'), /synthetic initialization timed out/)
  assert.equal(await within(Promise.resolve('ready'), 1000, 'initialization'), 'ready')
})

test('worker diagnostics contain only local socket outcomes and never credentials or error bodies', () => {
  class Socket extends EventTarget { static OPEN = 1 }
  const context = vm.createContext({ WebSocket: Socket, URL })
  vm.runInContext(`(${installConnectionProbe.toString()})()`, context)
  const socket = new context.WebSocket(url)
  socket.dispatchEvent(new Event('open'))
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'hello.ok', credential: 'synthetic-secret' }) }))
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'error', code: 'unauthorized', message: 'Bearer synthetic-secret' }) }))
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'error', code: 'a'.repeat(64) }) }))
  const encoded = JSON.stringify(context.__strideConnectionDiagnostics)
  assert.ok(!encoded.includes('synthetic-secret'))
  assert.ok(!encoded.includes('a'.repeat(64)))
  assert.ok(encoded.includes('unauthorized'))
  assert.equal(context.WebSocket.OPEN, 1)
  const before = context.__strideConnectionDiagnostics.length
  new context.WebSocket('wss://unrelated.example/')
  assert.equal(context.__strideConnectionDiagnostics.length, before)
})
