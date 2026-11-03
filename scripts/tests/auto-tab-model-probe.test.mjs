import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, MODEL_REQUEST_LIMIT, BROWSER_CALL_LIMIT } from '../fixtures/auto-tab-model-probe.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stride-model-probe-test-'))
  const trigger = join(root, 'start.json'), result = join(root, 'result.json')
  const events = new Map(), stops = [], guards = []
  t.after(async () => {
    for (const stop of stops.reverse()) await stop()
    await rm(root, { recursive: true, force: true })
  })
  const ctx = {
    tools: { guard(fn) { guards.push(fn); return () => {} } },
    browserRuns: { list: () => [] },
    on(name, fn) { events.set(name, fn) },
    effect(fn) { stops.push(fn()) },
  }
  const sessionId = 'synthetic-session', url = 'http://fixture.test/settings'
  await writeFile(trigger, JSON.stringify({ sessionId, url }))
  apply(ctx, { trigger, result })
  async function read(check = () => true) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        await readFile(`${result}.ready`)
        const value = JSON.parse(await readFile(result, 'utf8'))
        if (check(value)) return value
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      await delay(5)
    }
    throw new Error('Probe evidence did not settle')
  }
  await read()
  return { events, read, url, guard: guards[0], agent: Object.freeze({ id: sessionId }) }
}

test('the real-model guard confines only its own session to the synthetic browser tools', async t => {
  const h = await fixture(t)
  assert.equal(h.guard({ agent: h.agent, name: 'run_code' }), undefined)
  assert.equal(h.guard({ agent: h.agent, name: 'browser_open_tab', arguments: { url: h.url } }), undefined)
  assert.equal(h.guard({ agent: { id: 'other-session' }, name: 'bash' }), undefined)
  for (const call of [
    { name: 'browser_navigate', arguments: { url: 'https://outside.example/' } },
    { name: 'browser_follow_tab', arguments: { tabId: 1 } },
    { name: 'browser_close_tab', arguments: { tabId: 1 } },
    { name: 'bash', arguments: { command: 'synthetic-argument' } },
  ]) assert.equal(typeof h.guard({ ...call, agent: h.agent }), 'string')
  const evidence = await h.read(value => value.blockedTools.length === 4)
  assert.deepEqual(evidence.blockedTools, ['browser_navigate', 'browser_follow_tab', 'browser_close_tab', 'bash'])
  assert.doesNotMatch(JSON.stringify(evidence), /outside\.example|synthetic-argument/)
})

test('evidence records the final tool outcome without arguments or page content', async t => {
  const h = await fixture(t)
  const exec = Object.freeze({ agent: h.agent, name: 'browser_click', arguments: { value: 'synthetic-argument' } })
  await h.events.get('tools/execute')(exec, async () => ({ isError: false }))
  assert.deepEqual((await h.read()).browserResults, [])
  h.events.get('tools/result')(exec, Object.freeze({ isError: true, content: [{ type: 'text', text: 'synthetic-page-content' }] }))
  const evidence = await h.read(value => value.browserResults.length === 1)
  assert.deepEqual(evidence.browserCalls, ['browser_click'])
  assert.deepEqual(evidence.browserResults, [{ name: 'browser_click', ok: false, chars: 'synthetic-page-content'.length, savedMessage: false }])
  assert.doesNotMatch(JSON.stringify(evidence), /synthetic-argument|synthetic-page-content/)
})

test('diagnostics distinguish a browser observation from the outer program output', async t => {
  const h = await fixture(t)
  h.events.get('tools/result')({ agent: h.agent, name: 'browser_snapshot' }, { isError: false, content: [{ type: 'text', text: '设置已保存' }] })
  h.events.get('tools/result')({ agent: h.agent, name: 'run_code' }, { isError: false, content: [{ type: 'text', text: '(run_code completed with no output)' }] })
  const evidence = await h.read(value => value.ptcResults.length === 1)
  assert.equal(evidence.browserResults[0].savedMessage, true)
  assert.equal(evidence.ptcResults[0].savedMessage, false)
  assert.doesNotMatch(JSON.stringify(evidence), /设置已保存|run_code completed/)
})

test('the model request limit refuses the next provider request', async t => {
  const h = await fixture(t)
  let dispatched = 0
  const request = () => h.events.get('agent/request')({ agent: h.agent }, async () => { dispatched++ })
  for (let i = 0; i < MODEL_REQUEST_LIMIT; i++) await request()
  await assert.rejects(request, /synthetic-model-budget/)
  assert.equal(dispatched, MODEL_REQUEST_LIMIT)
})

test('the browser call limit refuses the next browser dispatch', async t => {
  const h = await fixture(t)
  let dispatched = 0
  const call = () => h.events.get('tools/execute')({ agent: h.agent, name: 'browser_snapshot' }, async () => { dispatched++ })
  for (let i = 0; i < BROWSER_CALL_LIMIT; i++) await call()
  await assert.rejects(call, /synthetic-browser-budget/)
  assert.equal(dispatched, BROWSER_CALL_LIMIT)
})
