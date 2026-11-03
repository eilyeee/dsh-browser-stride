// Test-only limits and metadata for ordinary real-model chat. No task runtime is created.
import { readFile, writeFile } from 'node:fs/promises'

export const name = 'stride-auto-tab-model-probe'
export const inject = ['tools', 'agents', 'browserRuns']
export const MODEL_REQUEST_LIMIT = 12
export const BROWSER_CALL_LIMIT = 20

export function apply(ctx, config) {
  let expected, writes = Promise.resolve()
  const evidence = { modelRequests: 0, ptcCalls: 0, browserCalls: [], browserResults: [], blockedTools: [], terminal: false }
  const belongs = agent => expected !== undefined && String(agent?.id) === expected.sessionId
  const save = () => (writes = writes.then(() => writeFile(config.result, JSON.stringify(evidence), { mode: 0o600 })).catch(() => {}))
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!belongs(exec.agent)) return
    const browser = exec.name.startsWith('browser_')
    let refused = !browser && exec.name !== 'run_code'
    if (['browser_open_tab', 'browser_navigate'].includes(exec.name)) refused ||= exec.arguments?.url !== expected.url
    if (['browser_follow_tab', 'browser_close_tab'].includes(exec.name)) refused = true
    if (refused) {
      evidence.blockedTools.push(exec.name)
      void save()
      return 'This acceptance session permits only the synthetic page and browser tools.'
    }
  }), 'synthetic ordinary-chat tool scope')
  ctx.on('agent/request', async (payload, next) => {
    if (belongs(payload.agent)) {
      if (++evidence.modelRequests > MODEL_REQUEST_LIMIT) throw new Error('synthetic-model-budget')
      await save()
    }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (belongs(exec.agent)) {
      if (exec.name === 'run_code' && ++evidence.ptcCalls > MODEL_REQUEST_LIMIT) throw new Error('synthetic-ptc-budget')
      if (exec.name.startsWith('browser_')) {
        if (evidence.browserCalls.length >= BROWSER_CALL_LIMIT) throw new Error('synthetic-browser-budget')
        evidence.browserCalls.push(exec.name)
      }
      await save()
    }
    const result = await next()
    if (belongs(exec.agent) && exec.name.startsWith('browser_')) {
      evidence.browserResults.push({ name: exec.name, ok: !result.isError, ...(result.isError ? { code: result.error?.code } : {}) })
      await save()
    }
    return result
  })
  ctx.on('session/event', (session, event) => {
    if (!belongs({ id: session.id })) return
    if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') {
      const source = event.data.message.source
      evidence.model = { provider: source.provider, model: source.model }
    }
    if (event.type === 'turn/end') {
      evidence.terminal = true
      evidence.reason = event.data.reason.kind
      evidence.managedRuns = ctx.browserRuns.list(expected.sessionId).length
    }
    void save()
  })
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (expected !== undefined) return
      void readFile(config.trigger, 'utf8').then(async text => {
        if (expected !== undefined) return
        expected = JSON.parse(text)
        await save()
        await writeFile(`${config.result}.ready`, 'ready', { mode: 0o600 })
      }).catch(() => {})
    }, 50)
    return async () => { clearInterval(timer); await writes }
  })
}
