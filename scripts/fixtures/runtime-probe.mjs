// Loaded only by smoke-runtime.mjs into its isolated real DSH profile.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'runtime-smoke-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjectionCache', 'browserRuns']

export async function apply(ctx, config) {
  // DSH 0.1.7 resolves profile packages through process-local module hooks.
  // Inspect providers inside the host where those hooks are installed.
  const resolve = createRequire(config.profileManifest)
  for (const [name, service] of [
    ['dsh-session-query', 'sessionQuery'],
    ['dsh-session-projection-cache', 'sessionProjectionCache'],
  ]) {
    const packageName = `@deepseek-ai/${name}`
    const path = resolve.resolve(`${packageName}/package.json`)
    const { version } = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(version, config.expectedVersion, `Profile resolved an incompatible ${name} at ${path}`)
    const { default: Provider } = await import(pathToFileURL(resolve.resolve(packageName)).href)
    assert.ok(ctx.get(service) instanceof Provider, `${service} must use the profile's resolved provider`)
  }
  const runs = ctx.browserRuns
  const dispatches = runs.dispatches
  if (config.reopen) {
    assert.equal(dispatches.get('synthetic-prepared').state, 'not_sent')
    assert.equal(dispatches.get('synthetic-sent').state, 'unresolved')
    assert.equal(dispatches.get('synthetic-returned').state, 'returned')
  } else {
    for (const requestId of ['synthetic-prepared', 'synthetic-sent', 'synthetic-returned']) {
      await dispatches.prepare({ requestId, connectionId: 'synthetic-connection', sessionId: config.sessionId,
        name: 'browser_click', args: { elementRef: 'synthetic-ref:1' }, expiresAt: Date.now() + 60_000 })
      if (requestId !== 'synthetic-prepared') await dispatches.markSent(requestId)
      if (requestId === 'synthetic-returned') await dispatches.settle(requestId, { state: 'returned', receipt: { ok: true } })
    }
  }
  if (config.reopen) {
    const records = runs.list(config.sessionId)
    assert.equal(records.length, 2)
    const interrupted = records.find(run => run.state === 'blocked')
    assert.ok(interrupted, 'interrupted browser run must be fenced on restart')
    assert.equal(interrupted.recoveryRequired, true)
    assert.equal(interrupted.controlRevision, 1)
    assert.equal(interrupted.facts.length, 1)
    assert.equal(interrupted.facts[0].actionId, 'synthetic-runtime-action')
    assert.equal(interrupted.facts[0].outcome, 'verified')
    await assert.rejects(runs.control(interrupted.runId, interrupted.version, 'resume'), { code: 'reconciliation-required' })
    assert.ok(records.some(run => run.state === 'stopped' && !run.recoveryRequired))
  } else {
    const created = await runs.create({ sessionId: config.sessionId, requiredCriteriaIds: ['saved'] })
    const active = await runs.transition(created.runId, created.version, 'running')
    await runs.recordFact(active.runId, active.version, {
      actionId: 'synthetic-runtime-action', requestDigest: 'a'.repeat(64), controlRevision: active.controlRevision,
      dispatchState: 'accepted', outcome: 'verified', verifiedCriteriaIds: ['saved'],
      evidence: { observedText: ['Synthetic save confirmed'] },
    })
    const queued = await runs.create({ sessionId: config.sessionId, requiredCriteriaIds: ['saved'] })
    await runs.control(queued.runId, queued.version, 'stop')
  }
  if (config.reopen) {
    assert.equal(ctx.sessions.get(config.sessionId), undefined, 'session must be cold after restart')
    // A prepared observation calls the real cache.hydratePrepared, the exact
    // failing boundary in #71. No mocked query, cache, or persistence services.
    const observation = await ctx.sessionQuery.observeSession(config.sessionId)
    try {
      assert.equal(observation.source, 'prepared')
      assert.ok(observation.projections)
      await writeFile(config.marker, JSON.stringify({ source: observation.source }))
    } finally {
      observation[Symbol.dispose]()
    }
    return
  }
  ctx.on('session/created', async (session) => {
    if (session.id !== config.sessionId) return
    // A durable Session choice must survive catalog refreshes and cold reads,
    // independently of the deployment default. No model request is needed.
    session.append('model/selection', { provider: 'smoke-provider', model: 'smoke-model' })
    // Persist a blank session without an LLM call so restart exercises reads
    // from disk even though normal empty sessions may be deferred.
    // AgentLoop owns writes through its SessionHandle; the service flush
    // barrier drains those handles and materializes even an empty session.
    await ctx.sessionPersistence.flush()
    await writeFile(config.marker, JSON.stringify({ sessionId: session.id }))
  })
}
