// Loaded only by smoke-browser.mjs into a disposable DSH Host. It executes the
// registered browser tools through the real Host tool runtime, without a model.
import { access, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

export const name = 'stride-browser-smoke-probe'
export const inject = ['tools', 'browserRuns']

export function apply(ctx, config) {
  const controller = new AbortController()
  let started = false
  let callNumber = 0

  async function tool(name, args = {}) {
    const result = await ctx.tools.execute({
      callId: `stride-browser-smoke-${++callNumber}`,
      name,
      arguments: args,
      signal: controller.signal,
    })
    if (result.isError) throw new Error(`${name}: ${result.error.message}`)
    if (typeof result.value?.text !== 'string') throw new Error(`${name} returned no text`)
    return result.value.text
  }

  function reference(text, label) {
    const line = text.split('\n').find((item) => item.includes(label) && item.includes('ref='))
    const ref = line?.match(/ref=(obs_[a-f0-9-]+:\d+)/iu)?.[1]
    if (ref === undefined) throw new Error(`snapshot is missing the expected ${label} control`)
    return ref
  }

  async function run() {
    try {
      const initial = await tool('browser_snapshot')
      const checkbox = reference(initial, '邮件通知')
      await tool('browser_click', { elementRef: checkbox })
      const updated = await tool('browser_snapshot')
      const save = reference(updated, '保存设置')
      await tool('browser_click', { elementRef: save })
      const records = ctx.browserRuns.dispatches.list()
      assert.equal(records.length, 4)
      assert.equal(records.filter(row => row.effect === 'read').length, 2)
      assert.equal(records.filter(row => row.effect === 'write').length, 2)
      for (const row of records) {
        assert.equal(row.state, 'returned')
        assert.equal(row.receipt.ok, true)
        assert.match(row.requestDigest, /^[a-f0-9]{64}$/)
        assert.equal(Object.hasOwn(row, 'args'), false)
        assert.equal(Object.hasOwn(row, 'result'), false)
      }
      assert.equal(new Set(records.map(row => row.actionId)).size, 4)
      await writeFile(config.result, JSON.stringify({ ok: true, calls: callNumber, recorded: records.length }), { mode: 0o600 })
    } catch (error) {
      await writeFile(config.result, JSON.stringify({ ok: false, error: String(error) }), { mode: 0o600 })
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (started) return
      void access(config.trigger).then(() => {
        if (started) return
        started = true
        void run().catch(() => {})
      }).catch(() => {})
    }, 100)
    return () => { clearInterval(timer); controller.abort() }
  }, 'stride-browser-smoke-probe')
}
