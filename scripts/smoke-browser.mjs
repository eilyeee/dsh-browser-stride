// Opt-in infrastructure smoke: real DSH Host + built extension + a synthetic
// local site. No model is called and no user's DSH or browser profile is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startDshBackend } from '../benchmark/lib/dsh-process.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { makeTaskInstance } from '../benchmark/lib/tasks.mjs'
import { startBenchmarkSite } from '../benchmark/site/server.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const benchmarkRoot = join(repoRoot, 'benchmark')
const require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'stride-browser-smoke-'))
const home = join(root, 'home')
const runtimeRoot = join(root, 'runtime')
const trigger = join(root, 'start')
const result = join(root, 'result.json')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
delete env.DSH_BRIDGE_ADMIN_TOKEN
process.env.DSH_HOME = home
delete process.env.DSH_EXT_TOKEN
delete process.env.DSH_BROWSER_SESSION_WORKSPACE
delete process.env.DSH_BRIDGE_ADMIN_TOKEN
let site
let host
let browser

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timer) }
}

async function freePort() {
  const socket = createServer()
  await new Promise((resolveListen, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolveListen)
  })
  const port = socket.address().port
  await new Promise((resolveClose) => socket.close(resolveClose))
  return port
}

async function waitForResult() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (host.child.exitCode !== null) throw new Error('DSH exited during the browser smoke')
    try { return JSON.parse(await readFile(result, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await delay(100)
  }
  throw new Error('timed out waiting for the Host browser tools')
}

try {
  await mkdir(home, { recursive: true })
  await command(['plugin', '--profile', 'web', 'add', '-w', `@yuxianglin/dsh-bridge-browser@link:${join(repoRoot, 'packages/browser/bridge-browser')}`])
  site = await startBenchmarkSite({ port: 0 })
  const port = await freePort()
  host = await startDshBackend({
    backend: 'extension', port, repoRoot, benchmarkRoot, runtimeRoot,
    startUrl: `${site.origin}/health`,
    toolProbe: { plugin: join(repoRoot, 'scripts/fixtures/browser-tool-probe.mjs'), trigger, result },
  })
  browser = await startExtensionBrowser({
    repoRoot, benchmarkRoot, bridgeUrl: `ws://127.0.0.1:${port}/ext/bridge`,
    pairingCode: await host.issuePairingCode(), trustedOrigin: site.origin,
  })
  const instance = makeTaskInstance('notification_toggle', 1, 'stride-browser-smoke', site.origin)
  await browser.prepare(instance.url)
  const session = await host.client.rpc('session.create', { cwd: root })
  await browser.bindSession(session.sessionId)
  await writeFile(trigger, '', { mode: 0o600 })
  const outcome = await waitForResult()
  assert.equal(outcome.ok, true, outcome.error)
  assert.equal(outcome.calls, 4)
  const response = await fetch(`${site.origin}/api/state?run=${encodeURIComponent(instance.runId)}`)
  assert.equal(response.ok, true)
  const state = await response.json()
  assert.equal(state.notificationSaved, true)
  assert.equal(state.emailNotifications, true)
  const installations = await host.listInstallations()
  assert.equal(installations.length, 1)
  assert.equal(await host.revokeInstallation(installations[0].installationId), true)
  assert.equal((await host.listInstallations()).length, 0)
  await browser.panel.locator('.connection .dot.connected').waitFor({ state: 'hidden', timeout: 15_000 })
  console.log('Browser smoke passed: real DSH tool runtime, installation pairing and revocation, extension snapshots and writes, independently verified local site state (no model)')
} finally {
  await browser?.close().catch(() => {})
  await host?.close().catch(() => {})
  await site?.close().catch(() => {})
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
