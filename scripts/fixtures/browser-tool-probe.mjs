// Loaded only by smoke-browser.mjs into a disposable DSH Host. It executes the
// registered browser tools through the real Host tool runtime, without a model.
import { access, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'stride-browser-smoke-probe'
export const inject = ['tools', 'browserRuns', 'agents']

export function apply(ctx, config) {
  const controller = new AbortController()
  let started = false
  let callNumber = 0
  let blocked = 0

  async function tool(name, args = {}, agent) {
    const result = await ctx.tools.execute({
      callId: `stride-browser-smoke-${++callNumber}`,
      name,
      arguments: args,
      signal: controller.signal,
      ...(agent === undefined ? {} : { agent }),
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

  async function waitFor(check, label) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted()
      if (await check()) return
      await delay(100)
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  async function exists(path) { try { await access(path); return true } catch { return false } }

  async function run() {
    try {
      const { sessionId } = JSON.parse(await readFile(config.trigger, 'utf8'))
      assert.equal(typeof sessionId, 'string')
      const queued = await ctx.browserRuns.create({ sessionId, requiredCriteriaIds: ['saved'] })
      const active = await ctx.browserRuns.transition(queued.runId, queued.version, 'running')
      const denied = async () => {
        const result = await ctx.tools.execute({ callId: `stride-blocked-${++blocked}`, name: 'browser_snapshot', arguments: {}, signal: controller.signal })
        assert.equal(result.isError, true, 'old execution context must not dispatch')
      }
      await ctx.browserRuns.withExecution(active.runId, 0, async () => {
        const initial = await tool('browser_snapshot')
        const checkbox = reference(initial, '邮件通知')
        await tool('browser_click', { elementRef: checkbox })
        await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'pause-ready', runId: active.runId, sessionId }), { mode: 0o600 })
        await waitFor(() => ctx.browserRuns.get(active.runId).state === 'paused', 'panel pause')
        const paused = ctx.browserRuns.get(active.runId)
        await denied()
        await waitFor(() => ctx.browserRuns.get(active.runId).state === 'running', 'explicit selected-page task handoff')
        const resumed = ctx.browserRuns.get(active.runId)
        assert.equal(resumed.controlRevision, paused.controlRevision + 2)
        await denied()
        await ctx.browserRuns.withExecution(active.runId, resumed.controlRevision, async () => {
          const updated = await tool('browser_snapshot')
          await tool('browser_click', { elementRef: reference(updated, '邮件通知') })
          const readyToSave = await tool('browser_snapshot')
          await tool('browser_click', { elementRef: reference(readyToSave, '保存设置') })
        })
        await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'stop-ready', runId: active.runId, sessionId }), { mode: 0o600 })
        await waitFor(() => ctx.browserRuns.get(active.runId).state === 'stopping', 'panel stop')
        const stopping = ctx.browserRuns.get(active.runId)
        await waitFor(() => exists(`${config.trigger}.ack-stop`), 'executor stop acknowledgement')
        await ctx.browserRuns.transition(active.runId, stopping.version, 'stopped')
      })
      const records = ctx.browserRuns.dispatches.list()
      assert.equal(records.length, 6)
      assert.equal(records.filter(row => row.effect === 'read').length, 3)
      assert.equal(records.filter(row => row.effect === 'write').length, 3)
      for (const row of records) {
        assert.equal(row.state, 'returned')
        assert.equal(row.receipt.ok, true)
        assert.match(row.requestDigest, /^[a-f0-9]{64}$/)
        assert.equal(row.runId, active.runId)
        assert.equal(row.sessionId, sessionId)
        assert.ok(row.controlRevision === 0 || row.controlRevision === 3)
        assert.equal(Object.hasOwn(row, 'args'), false)
        assert.equal(Object.hasOwn(row, 'result'), false)
      }
      assert.equal(new Set(records.map(row => row.actionId)).size, 6)
      assert.equal(records.filter(row => row.controlRevision === 0).length, 2)
      assert.equal(records.filter(row => row.controlRevision === 3).length, 4)
      const target = records.filter(row => row.controlRevision === 3).map(row => row.targetBinding)
      assert.equal(typeof target[0], 'string', 'handoff pin must be reserved before the first new call')
      assert.equal(new Set(target).size, 1)
      assert.notEqual(target[0], records.find(row => row.controlRevision === 0 && row.targetBinding)?.targetBinding)
      assert.equal(ctx.browserRuns.get(active.runId).state, 'stopped')
      assert.equal(ctx.browserRuns.get(active.runId).facts.length, 0, 'transport success must not become business verification')
      await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'auto-open-ready' }), { mode: 0o600 })
      await waitFor(() => exists(`${config.trigger}.auto-open`), 'new-tab control opt-in')
      const automatic = JSON.parse(await readFile(`${config.trigger}.auto-open`, 'utf8'))
      const agent = ctx.agents.get(sessionId)
      assert.ok(agent, 'the original DSH conversation must still exist')
      const opened = await tool('browser_open_tab', { url: automatic.url, active: false }, agent)
      assert.match(opened, /Opened a new background tab/)
      const snapshot = await tool('browser_snapshot', {}, agent)
      await tool('browser_click', { elementRef: reference(snapshot, '邮件通知') }, agent)
      await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'auto-opened' }), { mode: 0o600 })
      await waitFor(() => exists(`${config.trigger}.auto-navigate`), 'cross-site automatic page navigation')
      const navigated = await tool('browser_navigate', { url: automatic.nextUrl }, agent)
      assert.match(navigated, /Navigation completed/)
      await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'auto-navigated' }), { mode: 0o600 })
      await waitFor(() => exists(`${config.trigger}.auto-verified`), 'new-tab control browser verification')
      await waitFor(() => exists(`${config.trigger}.cleanup-fault`), 'new-tab cleanup fault injection')
      const fault = JSON.parse(await readFile(`${config.trigger}.cleanup-fault`, 'utf8'))
      const failed = await ctx.tools.execute({ callId: `stride-browser-smoke-${++callNumber}`,
        name: 'browser_open_tab', arguments: { url: fault.url, active: false }, agent, signal: controller.signal })
      assert.equal(failed.isError, true)
      assert.match(failed.error.message, /Tab closure is unconfirmed/)
      assert.doesNotMatch(failed.error.message, /was closed/)
      await writeFile(`${config.result}.phase`, JSON.stringify({ phase: 'cleanup-failed' }), { mode: 0o600 })
      await waitFor(() => exists(`${config.trigger}.cleanup-verified`), 'new-tab cleanup browser verification')
      await writeFile(config.result, JSON.stringify({ ok: true, calls: callNumber, recorded: records.length, blocked, automaticCalls: 4, cleanupFaults: 1 }), { mode: 0o600 })
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
