// Install the prepared Host tarball into a disposable DSH home; never restart a user Host.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { waitForDsh } from '../benchmark/lib/dsh-client.mjs'
import { issuePairingCode } from '../benchmark/lib/pairing.mjs'
const repoRoot = resolve(import.meta.dirname, '..'), input = process.argv.indexOf('--dir')
const currentVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
const folder = input < 0 ? join(repoRoot, '.stride-private/releases', currentVersion) : resolve(process.argv[input + 1])
const versions = JSON.parse(await readFile(join(folder, 'versions.json'), 'utf8'))
const sums = (await readFile(join(folder, 'SHA256SUMS'), 'utf8')).trim().split('\n')
for (const line of sums) {
  const [hash, name] = line.split('  ')
  assert.ok(name && !name.includes('/') && !name.includes('\\'))
  assert.equal(createHash('sha256').update(await readFile(join(folder, name))).digest('hex'), hash)
}
const root = await mkdtemp(join(tmpdir(), 'stride-release-install-')), home = join(root, 'home')
const require = createRequire(join(repoRoot, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
let host, client, socket
try {
  await mkdir(home)
  const install = spawn(process.execPath, [join(folder, 'install-host.mjs')], {
    cwd: root, env: { ...process.env, DSH_BIN: join(repoRoot, 'node_modules/.bin/dsh'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: 'ignore',
  })
  const timer = setTimeout(() => install.kill('SIGKILL'), 180000)
  try { assert.equal((await once(install, 'exit'))[0], 0, 'Standalone Host package did not install') } finally { clearTimeout(timer) }
  const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
  assert.ok(profile.dependencies?.['@eilyeee/dsh-browser-stride'])
  const installed = createRequire(join(home, 'profiles/web/package.json')).resolve('@eilyeee/dsh-browser-stride/package.json')
  const manifest = JSON.parse(await readFile(installed, 'utf8'))
  assert.equal(manifest.version, versions.version)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const bundled = await readFile(join(dirname(installed), 'lib/index.js'), 'utf8')
  assert.ok(bundled.includes('browser_task_notes'))
  assert.ok(!bundled.includes(repoRoot), 'Published bundle must not embed the checkout path')
  await assert.rejects(readFile(join(dirname(installed), 'src/contracts/README.md')), { code: 'ENOENT' })
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port; await new Promise(done => listener.close(done))
  const admin = randomBytes(32).toString('hex'), baseUrl = `http://127.0.0.1:${port}`
  let launchUrl
  host = spawn(process.execPath, [cli, '--profile', 'web', '--', '--no-open', '--port', String(port)], {
    cwd: root, env: { ...process.env, DSH_HOME: home, DSH_EXT_TOKEN: admin, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  })
  let stdout = ''
  host.stdout.on('data', data => { stdout += data; const found = stdout.match(/dsh web: (https?:\/\/\S+)/); if (found) launchUrl = found[1] })
  client = await waitForDsh(baseUrl, { process: host, getLaunchUrl: () => launchUrl })
  const pairing = await issuePairingCode(baseUrl, admin)
  const WebSocket = createRequire(join(repoRoot, 'packages/browser/bridge-browser/package.json'))('ws')
  socket = new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`)
  const hello = await new Promise((done, failed) => {
    const timer = setTimeout(() => failed(new Error('Standalone plugin handshake timed out')), 10000)
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', token: pairing, installationId: 'release-smoke-' + randomBytes(12).toString('hex'), protocolVersion: versions.wireProtocol,
      caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60, taskNotes: true } })))
    socket.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.t === 'hello.ok') { clearTimeout(timer); done(frame) } })
    socket.on('error', error => { clearTimeout(timer); failed(error) })
  })
  assert.equal(hello.caps.release.bridgeVersion, versions.version)
  assert.equal(hello.caps.release.dshVersion, versions.dshVersion)
  assert.equal(hello.caps.taskNotes, true)
  const summary = { passed: true, checksumFiles: sums.length, installedStandalone: true, packagedHostStarted: true,
    authenticatedVersionHandshake: true, originalHostUntouched: true, ignoredPlanningFileExcluded: true, version: versions.version }
  const artifacts = join(repoRoot, '.stride-private/validation/release')
  await mkdir(artifacts, { recursive: true }); await readFile(join(folder, versions.chrome))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(summary))
} finally {
  socket?.close(); client?.close()
  if (host && host.exitCode === null) {
    host.kill('SIGTERM')
    const timer = setTimeout(() => host.kill('SIGKILL'), 3000)
    await once(host, 'exit').catch(() => {}); clearTimeout(timer)
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
