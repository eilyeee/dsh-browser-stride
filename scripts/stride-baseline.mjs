#!/usr/bin/env node
/**
 * Collect the M0 environment baseline as machine-readable evidence.
 *
 * Record the actual runtime, browser and profile facts. This script gathers
 * only local, non-secret facts: tool versions, OS, detected browsers, the
 * pinned dependency versions, the Harness CLI version, and which profiles
 * exist and whether they have the bridge installed.
 *
 * It deliberately does not read profile patches, session content, tokens or
 * cookies; nothing here may carry a credential.
 *
 * Usage:
 *   node scripts/stride-baseline.mjs             # write evidence + print summary
 *   node scripts/stride-baseline.mjs --json      # print JSON only
 *   node scripts/stride-baseline.mjs --no-write  # print summary without writing
 *   node scripts/stride-baseline.mjs --out <p>   # write to a specific path
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectProfiles } from './baseline-profiles.mjs'
import { resolveRepositoryBaselines } from './baseline-git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT_DIR = join(ROOT, '.stride-private', 'baseline')

const args = process.argv.slice(2)
const jsonOnly = args.includes('--json')
const noWrite = args.includes('--no-write')
const outIndex = args.indexOf('--out')
const outOverride = outIndex >= 0 ? args[outIndex + 1] : undefined

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Collect DSH Stride M0 environment baseline.\n\nFlags: --json, --no-write, --out <path>\n')
  process.exit(0)
}

function safe(command, commandArgs, options = {}) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: options.timeout ?? 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    }).trim()
  } catch (error) {
    options.onError?.(error)
    return undefined
  }
}

function readJson(relativeOrAbsolute) {
  const path = isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : join(ROOT, relativeOrAbsolute)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function localDate(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function versionOf(command, commandArgs = ['--version'], options = {}) {
  const output = safe(command, commandArgs, options)
  if (output === undefined) return undefined
  const match = output.match(/\d+\.\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?/)
  return match ? match[0] : output.split('\n')[0]
}

function majorOf(version) {
  const match = /^(\d+)/.exec(version ?? '')
  return match ? Number(match[1]) : undefined
}

function git(...gitArgs) {
  return safe('git', ['-C', ROOT, ...gitArgs])
}

/**
 * Resolve the executable a bare command would run.
 *
 * The workspace exposes a pinned `dsh` through `node_modules/.bin`, so inside a
 * `pnpm run` script the name resolves to the workspace copy while a plain shell
 * resolves the globally installed CLI. Both facts matter, so evidence
 * records the resolved path instead of only the version.
 */
function resolveCommand(command) {
  const output = safe(process.platform === 'win32' ? 'where' : 'which', [command])
  const first = output?.split('\n')[0]?.trim()
  return first ? first : undefined
}

/**
 * Shorten a path for committed evidence: workspace-relative or home-relative,
 * so the file never records an absolute user directory.
 */
function displayPath(value) {
  if (value === undefined) return null
  for (const [base, prefix] of [[ROOT, '<workspace>'], [homedir(), '~']]) {
    const suffix = relative(base, value)
    if (suffix === '') return prefix
    if (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
      return `${prefix}/${suffix.split(sep).join('/')}`
    }
  }
  return value
}

function detectBrowsers() {
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Google Chrome', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Google Chrome Canary', binary: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' },
      { name: 'Microsoft Edge', binary: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', binary: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Chromium', binary: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
    )
  } else if (process.platform === 'linux') {
    candidates.push(
      { name: 'Google Chrome', binary: 'google-chrome' },
      { name: 'Google Chrome', binary: 'google-chrome-stable' },
      { name: 'Chromium', binary: 'chromium' },
      { name: 'Chromium', binary: 'chromium-browser' },
      { name: 'Microsoft Edge', binary: 'microsoft-edge' },
    )
  }
  if (process.env.CHROME_PATH) candidates.unshift({ name: 'Chrome (CHROME_PATH)', binary: process.env.CHROME_PATH })

  const found = []
  const probes = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (candidate.binary.startsWith('/') && !existsSync(candidate.binary)) continue
    let failure
    const version = versionOf(candidate.binary, ['--version'], {
      onError: error => { failure = error.code === 'ETIMEDOUT' ? 'timeout' : error.code === 'ENOENT' ? 'not-found' : 'failed' },
    })
    if (version === undefined) {
      probes.push({ name: candidate.name, source: displayPath(candidate.binary), result: failure ?? 'unparseable' })
      continue
    }
    const identity = `${candidate.name}:${version}`
    if (seen.has(identity)) continue
    seen.add(identity)
    found.push({ name: candidate.name, version, major: majorOf(version), source: displayPath(candidate.binary) })
  }
  return { browsers: found, probes }
}

function main() {
  const rootPackage = readJson('package.json') ?? {}
  const bridgePackage = readJson('packages/browser/bridge-browser/package.json') ?? {}
  const extensionPackage = readJson('extensions/dsh-browser/package.json') ?? {}
  const extensionManifest = readJson('extensions/dsh-browser/manifest.json') ?? {}
  const pinnedDsh = rootPackage.dependencies?.['@deepseek-ai/dsh'] ?? null
  const packageManager = rootPackage.packageManager ?? null
  const pinnedPnpm = packageManager ? packageManager.replace(/^pnpm@/, '') : null

  const fixedBaseline = readFileSync(join(ROOT, 'docs', 'stride', 'baseline', 'upstream-commit.txt'), 'utf8').trim()
  const publicationFile = join(ROOT, 'docs', 'stride', 'baseline', 'publication-base.txt')
  const fixedPublication = existsSync(publicationFile) ? readFileSync(publicationFile, 'utf8').trim() : null
  const baseline = resolveRepositoryBaselines(fixedBaseline, fixedPublication, git)
  const headCommit = git('rev-parse', 'HEAD') ?? null
  const status = git('status', '--porcelain') ?? ''
  const dirtyFiles = status === '' ? 0 : status.split('\n').filter(Boolean).length

  const remotes = (git('remote', '-v') ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => line.split(/\s+/))
    .filter(parts => parts[0] === 'upstream')
    .slice(0, 1)
    .map(parts => ({ name: parts[0], url: parts[1] }))

  const toolchain = {
    node: process.version,
    // pnpm rewrites its own version from `packageManager` unless this is off;
    // the probe must report the manager actually installed here.
    npm: versionOf('npm'),
    pnpm: versionOf('pnpm', ['--version'], { env: { npm_config_manage_package_manager_versions: 'false' } }),
    platform: process.platform,
    release: safe('uname', ['-r']),
    productVersion: (process.platform === 'darwin' ? safe('sw_vers', ['-productVersion']) : undefined) ?? null,
    arch: process.arch,
  }

  const { browsers, probes: browserProbes } = detectBrowsers()
  const profiles = detectProfiles()
  const cliPath = resolveCommand('dsh')
  const cliVersion = versionOf('dsh')
  const workspaceDshPackage = readJson(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const npmGlobalRoot = safe('npm', ['root', '-g'])
  const globalDshPackage = npmGlobalRoot === undefined
    ? undefined
    : readJson(join(npmGlobalRoot, '@deepseek-ai', 'dsh', 'package.json'))
  const cliSource = cliPath === undefined
    ? 'unresolved'
    : cliPath.startsWith(join(ROOT, 'node_modules')) ? 'workspace-bin' : 'global-bin'

  const evidence = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    generator: 'scripts/stride-baseline.mjs',
    repository: {
      // Only the directory name: even locally generated evidence should not
      // include an absolute home path when a directory name is sufficient.
      rootName: basename(ROOT),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD') ?? null,
      commit: headCommit,
      commitSubject: git('log', '-1', '--format=%s') ?? null,
      baselineCommit: baseline.upstreamCommit,
      expectedBaselineCommit: fixedBaseline,
      publicationBaselineCommit: baseline.publicationCommit,
      expectedPublicationBaselineCommit: fixedPublication,
      historyBaselineCommit: baseline.historyBaselineCommit,
      historyBaselineKind: baseline.historyBaselineKind,
      upstreamTrackingCommit: git('rev-parse', 'upstream/main') ?? null,
      commitsAheadOfBaseline: baseline.commitsAhead,
      dirtyFiles,
      remotes,
    },
    baseline: {
      upstreamRepository: remotes[0]?.url ?? null,
      rootVersion: rootPackage.version ?? null,
      pinnedDshDependency: pinnedDsh,
      packageManager,
      bridgePackage: bridgePackage.name ?? null,
      bridgeVersion: bridgePackage.version ?? null,
      extensionPackage: extensionPackage.name ?? null,
      extensionVersion: extensionPackage.version ?? null,
      extensionManifestVersion: extensionManifest.version ?? null,
      minimumChromeVersion: extensionManifest.minimum_chrome_version ?? null,
    },
    toolchain,
    browsers,
    browserProbes,
    harness: {
      cliPath: displayPath(cliPath),
      cliVersion: cliVersion ?? null,
      cliSource,
      workspaceCliVersion: workspaceDshPackage?.version ?? null,
      globalCliVersion: globalDshPackage?.version ?? null,
      pinnedDshDependency: pinnedDsh,
      profiles,
    },
    deviations: [],
  }

  const deviations = evidence.deviations
  if (baseline.historyBaselineCommit === null) {
    deviations.push({
      id: 'D01', field: 'repository.historyBaselineCommit', expected: fixedPublication ?? fixedBaseline,
      actual: 'neither recorded baseline is an ancestor of this checkout',
      impact: 'Restore the appropriate history baseline before using this record as repository evidence.',
    })
  }
  if (cliVersion !== undefined && pinnedDsh !== null && cliVersion !== pinnedDsh) {
    deviations.push({
      id: 'D01',
      field: 'harness.cliVersion',
      expected: pinnedDsh,
      actual: `${cliVersion} (${cliSource})`,
      impact: 'Target runtime is not frozen. Verify by installing the bridge into the profile actually in use and running one real tool call; a matching version number is not sufficient.',
    })
  }
  if (globalDshPackage?.version !== undefined && pinnedDsh !== null
    && globalDshPackage.version !== pinnedDsh && globalDshPackage.version !== cliVersion) {
    deviations.push({
      id: 'D01',
      field: 'harness.globalCliVersion',
      expected: pinnedDsh,
      actual: `${globalDshPackage.version} (global install; the workspace resolves ${cliVersion ?? 'nothing'})`,
      impact: 'The same command resolves different runtimes inside and outside the workspace. Freeze which runtime the desktop and CLI actually load before claiming M0.',
    })
  }
  if (workspaceDshPackage?.version !== undefined && pinnedDsh !== null
    && workspaceDshPackage.version !== pinnedDsh) {
    deviations.push({
      id: 'D01',
      field: 'harness.workspaceCliVersion',
      expected: pinnedDsh,
      actual: workspaceDshPackage.version,
      impact: 'The installed workspace no longer matches the pinned dependency; the lockfile or install is stale.',
    })
  }
  if (!profiles.some(profile => profile.bridgeInstalled)) {
    deviations.push({
      id: 'D01',
      field: 'harness.profiles[].bridgeInstalled',
      expected: 'bridge installed in the profile the desktop/CLI actually uses',
      actual: 'no profile has the bridge installed',
      impact: 'M0 installation and connection have not been verified in this environment.',
    })
  }
  const chrome = browsers.find(browser => browser.name === 'Google Chrome')
    ?? browsers.find(browser => browser.name === 'Chrome (CHROME_PATH)')
  const minChrome = majorOf(String(extensionManifest.minimum_chrome_version ?? ''))
  if (chrome === undefined) {
    deviations.push({
      id: 'D02',
      field: 'browsers',
      expected: 'a Chrome build at or above the manifest minimum',
      actual: 'Chrome was not detected; see browserProbes for command failures',
      impact: 'Probe failure does not prove Chrome is absent. Verify the supported build separately.',
    })
  } else if (minChrome !== undefined && chrome.major !== undefined && chrome.major < minChrome) {
    deviations.push({
      id: 'D02',
      field: 'browsers.major',
      expected: `>= ${minChrome} (extension manifest minimum)`,
      actual: String(chrome.major),
      impact: 'The extension may not load at all.',
    })
  } else if (chrome.major !== undefined && chrome.major < 125) {
    deviations.push({
      id: 'D02',
      field: 'browsers.major',
      expected: '>= 125 for CDP flat child sessions',
      actual: String(chrome.major),
      impact: 'CDP-dependent capabilities must degrade to unsupported (chrome-version).',
    })
  }
  if (pinnedPnpm !== null && toolchain.pnpm !== undefined && toolchain.pnpm !== pinnedPnpm) {
    deviations.push({
      id: 'ENV',
      field: 'toolchain.pnpm',
      expected: pinnedPnpm,
      actual: toolchain.pnpm,
      impact: 'The pinned pnpm is not in use; lockfile-compatible versions are fine for tests, but release builds must use the pinned manager.',
    })
  }
  const nodeMajor = majorOf(toolchain.node.replace(/^v/, ''))
  if (nodeMajor !== 24) {
    deviations.push({
      id: 'ENV',
      field: 'toolchain.node',
      expected: '24.x',
      actual: toolchain.node,
      impact: 'CI runs Node 24; local results on another major are not equivalent.',
    })
  }

  const date = localDate()
  const outPath = outOverride
    ? resolve(ROOT, outOverride)
    : join(DEFAULT_OUT_DIR, `${date}-baseline.json`)

  if (!noWrite) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  }

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    return
  }

  const lines = []
  lines.push('DSH Stride — M0 baseline')
  lines.push('')
  lines.push(`  repository   ${evidence.repository.branch ?? '?'} @ ${(evidence.repository.commit ?? '').slice(0, 12)}`)
  lines.push(`  baseline     upstream ${evidence.repository.expectedBaselineCommit.slice(0, 12)}; ${evidence.repository.historyBaselineKind ?? 'unavailable'} history (+${evidence.repository.commitsAheadOfBaseline ?? '?'} commits)`)
  lines.push(`  node/pnpm    ${toolchain.node} / ${toolchain.pnpm ?? 'not found'}`)
  lines.push(`  os           ${toolchain.platform} ${toolchain.productVersion ?? toolchain.release ?? ''} ${toolchain.arch}`)
  lines.push(`  dsh cli      ${cliVersion ?? 'not found'} (${cliSource}; pinned ${pinnedDsh ?? '?'}${globalDshPackage?.version !== undefined ? `, global ${globalDshPackage.version}` : ''})`)
  lines.push(`  chrome       ${chrome ? `${chrome.version} (${chrome.major})` : 'not detected'}`)
  lines.push(`  extension    ${evidence.baseline.extensionVersion ?? '?'}, minimum Chrome ${evidence.baseline.minimumChromeVersion ?? '?'}`)
  const profileText = profiles.length === 0
    ? 'none'
    : profiles.map(profile => `${profile.name}${profile.bridgeInstalled ? ' (bridge installed)' : ''}`).join(', ')
  lines.push(`  profiles     ${profileText}`)
  lines.push('')
  if (deviations.length === 0) {
    lines.push('  deviations   none')
  } else {
    lines.push('  deviations')
    for (const deviation of deviations) {
      lines.push(`    [${deviation.id}] ${deviation.field}: expected ${deviation.expected}, actual ${deviation.actual}`)
      lines.push(`           ${deviation.impact}`)
    }
  }
  lines.push('')
  lines.push(noWrite ? '  (--no-write: evidence not saved)' : `  evidence    ${outPath.replace(`${ROOT}/`, '')}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
