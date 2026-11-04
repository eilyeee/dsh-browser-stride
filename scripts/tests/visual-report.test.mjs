import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply, MODEL_BROWSER_TOOLS, matchesLayerReport } from '../fixtures/visual-probe.mjs'

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

test('visual model tools are restricted only in the test Agent scope before arming', async t => {
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
  await writeFile(trigger, JSON.stringify({ sequence: 1, mode: 'model', sessionId: 'synthetic-model' }))
  apply(ctx, { trigger, result })
  let ready
  for (let i = 0; i < 200; i++) {
    try { ready = JSON.parse(await readFile(result, 'utf8')); if (ready.modelReady) break } catch {}
    await delay(10)
  }
  assert.equal(ready?.modelReady, true)
  assert.deepEqual(restriction, { allow: MODEL_BROWSER_TOOLS })
  assert.equal(guard({ agent: { id: 'other' }, name: 'bash' }), undefined)
  assert.equal(typeof guard({ agent: { id: 'synthetic-model' }, name: 'browser_list_tabs' }), 'string')
  for (const stop of stops.splice(0).reverse()) await stop()
  assert.equal(released, true)
})
