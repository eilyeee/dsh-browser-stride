import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, MODEL_BROWSER_TOOLS, matchesLayerReport, matchesLayoutReport } from '../fixtures/visual-probe.mjs'

const expected = { layer: 'background', textLayer: 'text-Medium', color: '#2563eb', width: 320, height: 144, radius: 14,
  text: { width: 126, height: 24, fontSize: 18, fontWeight: 400, lineHeight: 24, color: '#ffffff' } }
const report = { background: { layer: expected.layer, width: '320px', height: 144, fill: expected.color, radius: '14px' },
  text: { layer: expected.textLayer, ...expected.text } }
test('visual acceptance requires separate exact background and text metrics', () => {
  assert.equal(matchesLayerReport(JSON.stringify(report), expected), true)
  for (const patch of [{ width: 320 }, { width: '126rem' }, { width: '126px guessed' }, { fontWeight: 500 }, { fontWeight: '400px' }, { layer: expected.layer }, { color: '#000000' }]) {
    assert.equal(matchesLayerReport(JSON.stringify({ ...report, text: { ...report.text, ...patch } }), expected), false)
  }
  assert.equal(matchesLayerReport(JSON.stringify({ background: report.background }), expected), false)
  assert.equal(matchesLayerReport('Cannot inspect the page.', expected), false)
})

test('layout acceptance requires measured before/after gaps without coercing missing values to zero', () => {
  const value = { before: { verticalGap: 0, marginTop: '0px', oldSelectorMatched: false }, after: { verticalGap: 50, marginTop: '50px' } }
  assert.equal(matchesLayoutReport(JSON.stringify(value)), true)
  for (const verticalGap of [null, false, '', '0', undefined]) {
    assert.equal(matchesLayoutReport(JSON.stringify({ ...value, before: { ...value.before, verticalGap } })), false)
  }
  assert.equal(matchesLayoutReport(JSON.stringify({ ...value, after: { verticalGap: 0, marginTop: '50px' } })), false)
  assert.equal(matchesLayoutReport('No measurement'), false)
})

for (const reportKind of ['styles', 'layout']) test(`${reportKind} model tools are restricted only in the test Agent scope before arming`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'stride-visual-scope-'))
  const trigger = join(root, 'trigger.json'), result = join(root, 'result.json'), stops = []
  let restriction, released = false, guard
  const agent = { ctx: { tools: { restrict(value) { restriction = value; return () => { released = true } } } } }
  const ctx = {
    agents: { get: id => id === 'synthetic-model' ? agent : undefined },
    tools: { guard(fn) { guard = fn; return () => {} }, restrict() { assert.fail('Global tools must not be restricted') } },
    on() {}, effect(fn) { stops.push(fn()) },
  }
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(root, { recursive: true, force: true }) })
  await writeFile(trigger, JSON.stringify({ sequence: 1, mode: 'model', sessionId: 'synthetic-model', reportKind, allowedUrls: ['http://stride-layout.test/fixed'] }))
  apply(ctx, { trigger, result })
  let ready
  for (let i = 0; i < 200; i++) {
    try { ready = JSON.parse(await readFile(result, 'utf8')); if (ready.modelReady) break } catch {}
    await delay(10)
  }
  assert.equal(ready?.modelReady, true)
  assert.deepEqual(restriction, { allow: reportKind === 'layout' ? ['browser_snapshot', 'browser_measure_layout', 'browser_navigate', 'browser_wait'] : MODEL_BROWSER_TOOLS })
  assert.equal(guard({ agent: { id: 'other' }, name: 'bash' }), undefined)
  assert.equal(typeof guard({ agent: { id: 'synthetic-model' }, name: 'browser_list_tabs' }), 'string')
  if (reportKind === 'layout') {
    assert.equal(guard({ agent: { id: 'synthetic-model' }, name: 'browser_navigate', arguments: { url: 'http://stride-layout.test/fixed' } }), undefined)
    assert.equal(typeof guard({ agent: { id: 'synthetic-model' }, name: 'browser_navigate', arguments: { url: 'https://example.com/' } }), 'string')
    assert.equal(typeof guard({ agent: { id: 'synthetic-model' }, name: 'browser_navigate', arguments: {} }), 'string')
  }
  for (const stop of stops.splice(0).reverse()) await stop()
  assert.equal(released, true)
})

test('direct visual preparation restores the scoped presentation after success or failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stride-visual-direct-'))
  const trigger = join(root, 'trigger.json'), result = join(root, 'result.json'), stops = []
  let mode = 'ptc', restored = 0, throwDispatch = false, calls = 0
  const agent = { id: 'synthetic-direct', status: 'idle', ctx: { tools: {
    presentAs(value) { assert.equal(value, 'native'); mode = value; return () => { mode = 'ptc'; restored++ } },
  } } }
  const ctx = {
    agents: { get: id => id === agent.id ? agent : undefined },
    tools: {
      guard() { return () => {} },
      presentAs() { assert.fail('Global presentation must not change') },
      async execute(exec) {
        calls++; assert.equal(exec.agent, agent); assert.equal(exec.name, 'browser_get_text'); assert.equal(mode, 'native')
        if (throwDispatch) throw new Error('Synthetic dispatch failed')
        return { isError: false, value: { text: 'Synthetic inspector' }, content: [{ type: 'text', text: 'Synthetic inspector' }] }
      },
    },
    on() {}, effect(fn) { stops.push(fn()) },
  }
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(root, { recursive: true, force: true }) })
  apply(ctx, { trigger, result })
  async function command(sequence) {
    await writeFile(trigger, JSON.stringify({ sequence, sessionId: agent.id, name: 'browser_get_text', args: {} }))
    for (let i = 0; i < 200; i++) {
      try { const value = JSON.parse(await readFile(result, 'utf8')); if (value.sequence === sequence) return value } catch {}
      await delay(10)
    }
    assert.fail('Direct preparation did not settle')
  }
  assert.equal((await command(1)).ok, true)
  assert.equal(mode, 'ptc'); assert.equal(restored, 1)
  throwDispatch = true
  assert.equal((await command(2)).probeError, true)
  assert.equal(mode, 'ptc'); assert.equal(restored, 2)
  agent.status = 'running'
  assert.equal((await command(3)).probeError, true)
  assert.equal(calls, 2); assert.equal(restored, 2)
})
