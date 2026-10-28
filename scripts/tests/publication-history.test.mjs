import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checker = resolve(dirname(fileURLToPath(import.meta.url)), '../check-publication-history.mjs')

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stride-publication-test-'))
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'Synthetic Contributor')
  git(root, 'config', 'user.email', 'test@users.noreply.github.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, '.gitignore'), '.stride-private/\n')
  await writeFile(join(root, 'README.md'), 'Fixture\n')
  git(root, 'add', 'README.md', '.gitignore')
  git(root, 'commit', '-q', '-m', 'baseline')
  const base = git(root, 'rev-parse', 'HEAD')
  await mkdir(join(root, 'docs/stride/baseline'), { recursive: true })
  await writeFile(join(root, 'docs/stride/baseline/publication-base.txt'), `${base}\n`)
  return root
}

function check(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
}

test('accepts a clean publication branch and its pending files', async () => {
  const root = await fixture()
  try {
    const result = check(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /targeted check/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('detects a sensitive historical file even after it was deleted', async () => {
  const root = await fixture()
  try {
    const path = 'packages/browser/bridge-browser/coverage/old.txt'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), 'generated data\n')
    git(root, 'add', path)
    git(root, 'commit', '-q', '-m', 'add historical file')
    git(root, 'rm', '-q', path)
    git(root, 'commit', '-q', '-m', 'delete historical file')
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /removed historical file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('detects a prohibited historical path even when its blob is shared with a permitted file', async () => {
  const root = await fixture()
  try {
    const path = 'packages/browser/bridge-browser/coverage/duplicate.txt'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), 'Fixture\n')
    git(root, 'add', path)
    git(root, 'commit', '-q', '-m', 'add duplicate content')
    git(root, 'rm', '-q', path)
    git(root, 'commit', '-q', '-m', 'delete duplicate content')
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /removed historical file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a prohibited path staged for a future commit', async () => {
  const root = await fixture()
  try {
    const path = 'packages/browser/bridge-browser/coverage/pending.txt'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), 'generated data\n')
    git(root, 'add', path)
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /prohibited staged file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a generated baseline record staged under a different date', async () => {
  const root = await fixture()
  try {
    const path = 'docs/stride/m0/evidence/2030-01-01-baseline.json'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), '{}\n')
    git(root, 'add', path)
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /prohibited staged file/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects private planning documents in history even after deletion', async () => {
  const root = await fixture()
  try {
    const path = 'docs/stride/backlog/tasks.md'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), 'Private planning fixture\n')
    git(root, 'add', path)
    git(root, 'commit', '-q', '-m', 'add planning fixture')
    git(root, 'rm', '-q', path)
    git(root, 'commit', '-q', '-m', 'remove planning fixture')
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /removed historical file: docs\/stride\/backlog\/tasks\.md/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects a private contract planning document staged for publication', async () => {
  const root = await fixture()
  try {
    const path = 'packages/browser/bridge-browser/src/contracts/README.md'
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), 'Private contract planning fixture\n')
    git(root, 'add', path)
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /prohibited staged file: packages\/browser\/bridge-browser\/src\/contracts\/README\.md/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('asks for review of non-noreply commit identities without printing the address', async () => {
  const root = await fixture()
  try {
    git(root, 'config', 'user.email', 'synthetic-private@example.com')
    await writeFile(join(root, 'next.txt'), 'next\n')
    git(root, 'add', 'next.txt')
    git(root, 'commit', '-q', '-m', 'next')
    const result = check(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /non-GitHub-noreply author\/committer/)
    assert.doesNotMatch(result.stdout, /synthetic-private@example\.com/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('detects sensitive content in the index even when the working file is clean', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'pending.txt'), ['/Users', 'private-person', 'project'].join('/'))
    git(root, 'add', 'pending.txt')
    await writeFile(join(root, 'pending.txt'), 'clean working copy\n')
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /machine-specific path: index\/pending\.txt/)
    assert.doesNotMatch(result.stderr, /private-person/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reports a working-tree machine path without printing its value', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'local.txt'), ['/Users', 'private-person', 'project'].join('/'))
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /machine-specific path: local\.txt/)
    assert.doesNotMatch(result.stderr, /private-person/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('does not exempt placeholder usernames outside known test fixtures', async () => {
  const root = await fixture()
  try {
    await writeFile(join(root, 'local.txt'), ['/Users', 'tester', 'private'].join('/'))
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /machine-specific path: local\.txt/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('finds a configured private email in a deleted historical file', async () => {
  const root = await fixture()
  try {
    const email = 'old-private@example.test'
    await writeFile(join(root, 'old.txt'), `Contact ${email}\n`)
    git(root, 'add', 'old.txt')
    git(root, 'commit', '-q', '-m', 'old content')
    git(root, 'rm', '-q', 'old.txt')
    git(root, 'commit', '-q', '-m', 'remove old content')
    await mkdir(join(root, '.stride-private/history-backup'), { recursive: true })
    await writeFile(join(root, '.stride-private/history-backup/private-emails.txt'), `${email}\n`)
    const result = check(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /private email: history\/old\.txt/)
    assert.doesNotMatch(result.stderr, /old-private@example\.test/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
