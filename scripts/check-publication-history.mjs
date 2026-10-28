import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'

// This check intentionally scans only the branch being published. Local
// upstream refs and private backups may still contain the original history.
const MAX_BUFFER = 128 * 1024 * 1024
const MAX_FILE_BYTES = 8_000_000
const SYNTHETIC_HOMES = new Map([
  ['benchmark/tests/chromium.test.mjs', 'tester'],
  ['extensions/dsh-browser/tests/updates.spec.ts', 'example'],
  ['packages/browser/bridge-browser/tests/remote-host-api.spec.ts', 'test'],
])
const RESTRICTED_PATHS = [
  'packages/browser/bridge-browser/coverage/',
  'packages/browser/bridge-browser/src/contracts/README.md',
  'docs/stride/',
]
const PUBLIC_BASELINE_PATHS = new Set([
  'docs/stride/baseline/publication-base.txt',
  'docs/stride/baseline/upstream-commit.txt',
])
const PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
]

function isRestrictedPath(path) {
  return path.startsWith('packages/browser/bridge-browser/coverage/')
    || path === 'packages/browser/bridge-browser/src/contracts/README.md'
    || (path.startsWith('docs/stride/') && !PUBLIC_BASELINE_PATHS.has(path))
}

function git(args, input) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    input, maxBuffer: MAX_BUFFER,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed; confirm the repository and baseline are available`)
  return result.stdout
}

function readPrivateEmails() {
  const file = '.stride-private/history-backup/private-emails.txt'
  const stored = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : []
  return [...new Set(stored.map(email => email.trim().toLowerCase()).filter(email => email !== '' && !email.endsWith('@users.noreply.github.com')))]
}

function inspect(data, path, privateEmails, issues) {
  const value = data.toString('latin1')
  const syntheticHome = SYNTHETIC_HOMES.get(path.replace(/^(?:history|index)\//, ''))
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(value)) issues.add(`${label}: ${path}`)
  }
  for (const match of value.matchAll(/\/(?:Users|home)\/([^/\s"'<>]+)(?=\/|[\s"'<>]|$)/g)) {
    if (match[1].toLowerCase() !== syntheticHome) issues.add(`machine-specific path: ${path}`)
  }
  for (const match of value.matchAll(/[A-Za-z]:\\{1,2}Users\\{1,2}([^\\\s"'<>]+)/g)) {
    if (match[1].toLowerCase() !== syntheticHome) issues.add(`machine-specific path: ${path}`)
  }
  const lower = value.toLowerCase()
  if (privateEmails.some(email => lower.includes(email))) issues.add(`private email: ${path}`)
}

function check() {
  const base = readFileSync('docs/stride/baseline/publication-base.txt', 'utf8').trim()
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('publication baseline must be a complete commit hash')
  git(['merge-base', '--is-ancestor', base, 'HEAD'])
  const issues = new Set()
  // rev-list --objects reports a shared blob only once, so it cannot prove
  // that a restricted path never existed. Inspect path history separately.
  const historicalPaths = git(['log', '--full-history', '-m', '--no-renames', '--format=', '--name-only', '-z', 'HEAD', '--', ...RESTRICTED_PATHS])
    .toString('utf8').split('\0').filter(Boolean)
  for (const path of historicalPaths) {
    if (isRestrictedPath(path)) issues.add(`removed historical file: ${path}`)
  }
  const objectLines = git(['rev-list', '--objects', 'HEAD']).toString('utf8').split('\n').filter(Boolean)
  const paths = new Map()
  const addPath = (oid, path) => {
    if (!paths.has(oid)) paths.set(oid, new Set())
    paths.get(oid).add(path)
  }
  for (const line of objectLines) {
    const split = line.indexOf(' ')
    if (split < 0) continue
    const oid = line.slice(0, split)
    const path = line.slice(split + 1)
    addPath(oid, `history/${path}`)
  }
  for (const entry of git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^\d{6} ([0-9a-f]{40}) [0-3]\t([\s\S]+)$/.exec(entry)
    if (match === null) throw new Error('invalid Git index entry')
    if (isRestrictedPath(match[2])) issues.add(`prohibited staged file: ${match[2]}`)
    addPath(match[1], `index/${match[2]}`)
  }
  const checks = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], `${[...paths.keys()].join('\n')}\n`)
    .toString('utf8').trim().split('\n').filter(Boolean)
  const blobs = []
  for (const row of checks) {
    const [oid, kind, sizeText] = row.split(' ')
    if (kind !== 'blob') continue
    const size = Number(sizeText)
    if (size > MAX_FILE_BYTES) {
      for (const path of paths.get(oid)) issues.add(`Git object exceeds scan limit: ${path}`)
    }
    else blobs.push(oid)
  }
  const result = git(['cat-file', '--batch'], `${blobs.join('\n')}\n`)
  const privateEmails = readPrivateEmails()
  let offset = 0
  for (const oid of blobs) {
    const end = result.indexOf(0x0a, offset)
    if (end < 0) throw new Error('invalid Git object stream')
    const [actual, kind, sizeText] = result.subarray(offset, end).toString('utf8').split(' ')
    const size = Number(sizeText)
    if (actual !== oid || kind !== 'blob' || !Number.isSafeInteger(size)) throw new Error('invalid Git object header')
    const start = end + 1
    const finish = start + size
    if (result[finish] !== 0x0a) throw new Error('invalid Git object boundary')
    for (const path of paths.get(oid)) inspect(result.subarray(start, finish), path, privateEmails, issues)
    offset = finish + 1
  }
  const worktreePaths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0').filter(Boolean)
  let scannedFiles = 0
  for (const path of new Set(worktreePaths)) {
    let stat
    try { stat = lstatSync(path) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (isRestrictedPath(path)) issues.add(`prohibited working-tree file: ${path}`)
    if (stat.isSymbolicLink()) { inspect(Buffer.from(readlinkSync(path)), path, privateEmails, issues); scannedFiles += 1 }
    else if (stat.isFile() && stat.size <= MAX_FILE_BYTES) { inspect(readFileSync(path), path, privateEmails, issues); scannedFiles += 1 }
    else if (stat.isFile()) issues.add(`working-tree file exceeds scan limit: ${path}`)
  }
  const emails = git(['log', '--format=%ae%x00%ce', `${base}..HEAD`]).toString('utf8').split(/[\0\n]/).filter(Boolean)
  const nonAnonymous = emails.filter(email => !email.toLowerCase().endsWith('@users.noreply.github.com')).length
  const messages = git(['log', '--format=%B%x00%ae%x00%ce', 'HEAD']).toString('utf8').toLowerCase()
  if (privateEmails.some(email => messages.includes(email))) issues.add('private email in reachable commit metadata')
  if (issues.size > 0) {
    for (const issue of issues) console.error(issue)
    throw new Error('publication history check failed; review the listed paths and identities')
  }
  if (nonAnonymous > 0) console.log(`Review ${nonAnonymous} non-GitHub-noreply author/committer entries after the baseline; the addresses may be intentionally public.`)
  console.log(`Publication branch checked: ${blobs.length} historical/index blobs and ${scannedFiles} tracked/untracked files; no configured private email or selected secret patterns found.`)
  console.log('This is a targeted check, not proof that all sensitive data is absent. Do not publish private backups or unfiltered refs.')
}

try { check() } catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
