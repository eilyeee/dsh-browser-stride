// Loaded only by smoke-browser.mjs into a disposable DSH Host. It executes the
// registered browser tools through the real Host tool runtime, without a model.
import { access, writeFile } from 'node:fs/promises'

export const name = 'stride-browser-smoke-probe'
export const inject = ['tools']

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
      await writeFile(config.result, JSON.stringify({ ok: true, calls: callNumber }), { mode: 0o600 })
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
