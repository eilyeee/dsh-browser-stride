import { readFile, writeFile } from 'node:fs/promises'

export const name = 'stride-task-runtime-probe'
export const inject = ['browserRuns', 'browserTasks', 'agents']
export function apply(ctx, config) {
  let expected
  let output = Promise.resolve()
  const registered = new Set()
  const admittedRevisions = new Set()
  let heldSnapshot = false
  let ptcCalls = 0, nestedBrowserCalls = 0, directBrowserCalls = 0
  ctx.on('tools/execute', async (exec, next) => {
    if (String(exec.agent?.id) === expected?.sessionId) {
      if (exec.name === 'run_code') ptcCalls += 1
      if (exec.name.startsWith('browser_')) { if (exec.parent === undefined) directBrowserCalls += 1; else nestedBrowserCalls += 1 }
    }
    const result = await next()
    // Fault injection only: hold one completed read so the real browser can
    // lose its connection or page before any synthetic-site write is needed.
    if ((expected?.disconnectOnce === true || expected?.targetLossOnce === true) && !heldSnapshot && String(exec.agent?.id) === expected.sessionId
      && exec.name === 'browser_snapshot' && !result.isError && exec.signal !== undefined) {
      heldSnapshot = true
      await writeFile(`${config.result}.${expected.targetLossOnce ? 'target-loss-ready' : 'disconnect-ready'}`, 'ready', { mode: 0o600 })
      await new Promise(resolve => {
        if (exec.signal.aborted) resolve()
        else exec.signal.addEventListener('abort', resolve, { once: true })
      })
    }
    return result
  })
  const stop = ctx.browserRuns.onChange(run => {
    if (run.sessionId !== expected?.sessionId || run.task === undefined) return
    if (run.state === 'running') admittedRevisions.add(run.controlRevision)
    if (run.state === 'queued' && !registered.has(run.runId)) {
      registered.add(run.runId)
      ctx.browserTasks.registerVerifier(run.runId, {
        acceptsTarget: url => url === expected.url,
        verify: async ({ signal }) => {
          const response = await fetch(expected.verificationUrl ?? new URL('/state', expected.url), { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) })
          const value = await response.json()
          return value.enabled === true && value.saved === true
            ? { fieldValues: { testSetting: 'enabled', persisted: 'true' } } : undefined
        },
      })
    }
    const rows = ctx.browserRuns.dispatches.list(run.sessionId).filter(row => row.runId === run.runId)
    const value = { ptcCalls, nestedBrowserCalls, directBrowserCalls, state: run.state, version: run.version, controlRevision: run.controlRevision, task: run.task,
      ...(run.pauseReason === undefined ? {} : { pauseReason: run.pauseReason }),
      agentIdle: ctx.agents?.get(run.sessionId)?.status === 'idle',
      facts: run.facts.length, verified: run.facts.some(fact => fact.outcome === 'verified'),
      dispatches: rows.length, returned: rows.filter(row => row.state === 'returned' && row.receipt?.ok).length,
      dispatchRevisions: [...new Set(rows.map(row => row.controlRevision))].sort((a, b) => a - b),
      runBound: rows.every(row => row.runId === run.runId && admittedRevisions.has(row.controlRevision)),
      terminal: ['completed', 'failed', 'blocked', 'stopped'].includes(run.state) }
    output = output.then(() => writeFile(config.result, JSON.stringify(value), { mode: 0o600 })).catch(() => {})
  })
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (expected !== undefined) return
      void readFile(config.trigger, 'utf8').then(async text => {
        if (expected !== undefined) return
        expected = JSON.parse(text)
        await writeFile(`${config.result}.ready`, 'ready', { mode: 0o600 })
      }).catch(() => {})
    }, 50)
    return async () => { clearInterval(timer); stop(); await output }
  })
}
