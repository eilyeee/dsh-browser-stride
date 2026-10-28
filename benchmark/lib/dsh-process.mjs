import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { waitForDsh } from './dsh-client.mjs'
import { issuePairingCode, listInstallations, revokeInstallation } from './pairing.mjs'

export function redactHostLogLine(line, secrets = []) {
  let safe = line
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[redacted]')
  return safe
    .replace(/([?&](?:token|access_token|api_key)=)[^\s&'"<>]+/giu, '$1[redacted]')
    .replace(/(\bBearer\s+)[^\s,;]+/giu, '$1[redacted]')
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

async function waitForPlaywrightStatus(baseUrl, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited while the Playwright plugin was loading (exit ${child.exitCode})`)
    try {
      const response = await fetch(`${baseUrl}/benchmark/playwright/status`, { signal: AbortSignal.timeout(1_500) })
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.json()
        if (response.ok && body.ok === true) return body
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Playwright plugin did not become ready: ${lastError instanceof Error ? lastError.message : 'status route unavailable'}`)
}

export async function startDshBackend({
  backend,
  port,
  repoRoot,
  benchmarkRoot,
  runtimeRoot,
  startUrl,
  toolProbe,
}) {
  const backendRoot = join(runtimeRoot, backend)
  const sessionRoot = join(backendRoot, 'sessions')
  const storageRoot = join(backendRoot, 'storages')
  const logsRoot = join(runtimeRoot, 'logs')
  await Promise.all([mkdir(sessionRoot, { recursive: true }), mkdir(storageRoot, { recursive: true }), mkdir(logsRoot, { recursive: true })])
  const patchTemplate = resolve(benchmarkRoot, 'patches', `${backend}.patch.yml`)
  const patch = join(backendRoot, 'effective.patch.yml')
  const pluginUrl = pathToFileURL(resolve(benchmarkRoot, 'plugin/playwright-browser.mjs')).href
  const bridgePluginUrl = pathToFileURL(resolve(repoRoot, 'packages/browser/bridge-browser/lib/index.js')).href
  let patchText = (await readFile(patchTemplate, 'utf8'))
    .replace('__BENCHMARK_PLAYWRIGHT_PLUGIN__', pluginUrl)
    .replace('__BENCHMARK_BRIDGE_PLUGIN__', bridgePluginUrl)
  if (toolProbe !== undefined) {
    if (backend !== 'extension') throw new Error('the tool probe requires the extension backend')
    patchText += [
      '',
      '- insert:',
      '    - id: stride-browser-smoke-probe',
      `      name: ${JSON.stringify(pathToFileURL(toolProbe.plugin).href)}`,
      '      config:',
      `        trigger: ${JSON.stringify(toolProbe.trigger)}`,
      `        result: ${JSON.stringify(toolProbe.result)}`,
      '',
    ].join('\n')
  }
  await writeFile(patch, patchText)
  const logPath = join(logsRoot, `dsh-${backend}.log`)
  const log = createWriteStream(logPath, { flags: 'a' })
  // This is the Host administrator credential, never the browser credential.
  const adminToken = randomBytes(32).toString('hex')
  const require = createRequire(join(repoRoot, 'package.json'))
  const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
  // Own the actual Host process, rather than a pnpm wrapper that can orphan it.
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--', '--no-open', '--port', String(port)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BENCHMARK_SESSION_ROOT: sessionRoot,
      BENCHMARK_STORAGE_ROOT: storageRoot,
      BENCHMARK_START_URL: startUrl,
      DSH_BROWSER_SESSION_WORKSPACE: resolve(benchmarkRoot, 'workspace'),
      DSH_EXT_TOKEN: adminToken,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const baseUrl = `http://127.0.0.1:${port}`
  let launchUrl
  let launchToken
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  const logStreamsClosed = Promise.all([stdout, stderr].map((stream) => new Promise((done) => stream.once('close', done))))
  stdout.on('line', (line) => {
    for (const match of line.matchAll(/dsh web: (https?:\/\/\S+)/gu)) {
      try {
        const url = new URL(match[1])
        if (url.origin === baseUrl && url.searchParams.has('token')) {
          launchUrl = url.href
          launchToken = url.searchParams.get('token')
        }
      } catch { /* Startup diagnostics are not necessarily URLs. */ }
    }
    log.write(`${redactHostLogLine(line, [adminToken, launchToken])}\n`)
  })
  stderr.on('line', (line) => log.write(`${redactHostLogLine(line, [adminToken, launchToken])}\n`))
  let client
  try {
    client = await waitForDsh(baseUrl, { process: child, getLaunchUrl: () => launchUrl })
    if (backend === 'playwright') {
      await waitForPlaywrightStatus(baseUrl, child)
    }
  } catch (error) {
    child.kill('SIGTERM')
    if (!await waitForExit(child, 3_000)) {
      child.kill('SIGKILL')
      await waitForExit(child, 2_000)
    }
    await logStreamsClosed
    await new Promise((resolveLog) => log.end(resolveLog))
    throw new Error(`${backend} backend failed to start; see ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    backend,
    baseUrl,
    child,
    client,
    logPath,
    async issuePairingCode() {
      if (backend !== 'extension') throw new Error('pairing is only available for the extension backend')
      return issuePairingCode(baseUrl, adminToken)
    },
    async listInstallations() {
      if (backend !== 'extension') throw new Error('pairing is only available for the extension backend')
      return listInstallations(baseUrl, adminToken)
    },
    async revokeInstallation(installationId) {
      if (backend !== 'extension') throw new Error('pairing is only available for the extension backend')
      return revokeInstallation(baseUrl, adminToken, installationId)
    },
    async close() {
      client.close()
      child.kill('SIGTERM')
      if (!await waitForExit(child, 5_000)) {
        child.kill('SIGKILL')
        await waitForExit(child, 2_000)
      }
      await logStreamsClosed
      await new Promise((resolveLog) => log.end(resolveLog))
    },
  }
}
