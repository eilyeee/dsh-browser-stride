import { readFile, writeFile } from 'node:fs/promises'
import { createReadbackVerifier } from '../../packages/browser/bridge-browser/src/readback-verifier.ts'
import { taskSiteBaseline } from './task-site.mjs'

export const name = 'stride-task-runtime-probe'
export const inject = ['browserRuns', 'browserTasks', 'agents']
export function apply(ctx, config) {
  let expected
  let output = Promise.resolve()
  const registered = new Set()
  const admittedRevisions = new Set()
  let heldSnapshot = false
  let ptcCalls = 0, nestedBrowserCalls = 0, directBrowserCalls = 0, scopeChecks = 0
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
      const readState = async signal => {
        const response = await fetch(expected.verificationUrl ?? new URL('/state', expected.url), { signal, cache: 'no-store' })
        if (!response.ok) throw Error('readback-unavailable')
        const body = await response.text()
        return { body, value: JSON.parse(body) }
      }
      ctx.browserTasks.registerVerifier(run.runId, createReadbackVerifier({
        targetUrl: expected.url, contextKey: 'synthetic-setting',
        versionPath: ['updateTime'], baselineVersion: taskSiteBaseline.updateTime,
        checks: [
          { path: ['id'], equalsInt64: taskSiteBaseline.id },
          { path: ['enabled'], equals: true },
          { path: ['saved'], equals: true },
        ],
        readScope: async ({ signal }) => {
          const { value } = await readState(signal)
          scopeChecks++
          return { contextKey: value.contextKey, observedAt: Date.now() }
        },
        read: async ({ signal }) => {
          const { body, value } = await readState(signal)
          const artifactRef = `readback_fixture_${value.version}`
          await writeFile(`${config.result}.${artifactRef}.json`, body, { mode: 0o600 })
          return { body, contextKey: value.contextKey, observedAt: Date.now(), artifactRef }
        },
      }))
    }
    const rows = ctx.browserRuns.dispatches.list(run.sessionId).filter(row => row.runId === run.runId)
    const value = { ptcCalls, nestedBrowserCalls, directBrowserCalls, scopeChecks, state: run.state, version: run.version, controlRevision: run.controlRevision, task: run.task,
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
