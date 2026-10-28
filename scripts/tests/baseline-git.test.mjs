import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRepositoryBaselines } from '../baseline-git.mjs'

function gitAt(cwd) {
  return (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
}

test('counts from the actual history baseline while retaining original upstream provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stride-baseline-history-'))
  try {
    const git = gitAt(root)
    assert.equal(git('init', '-q', '-b', 'upstream'), '')
    assert.equal(git('config', 'user.name', 'Synthetic Contributor'), '')
    assert.equal(git('config', 'user.email', 'test@users.noreply.github.com'), '')
    assert.equal(git('config', 'commit.gpgsign', 'false'), '')
    await writeFile(join(root, 'README.md'), 'upstream\n')
    assert.equal(git('add', 'README.md'), '')
    assert.equal(git('commit', '-q', '-m', 'upstream baseline'), '')
    const upstream = git('rev-parse', 'HEAD')
    await writeFile(join(root, 'README.md'), 'upstream plus one\n')
    assert.equal(git('commit', '-q', '-am', 'upstream change'), '')
    assert.deepEqual(resolveRepositoryBaselines(upstream, null, git), {
      upstreamCommit: upstream, publicationCommit: null,
      historyBaselineCommit: upstream, historyBaselineKind: 'upstream', commitsAhead: 1,
    })

    assert.equal(git('switch', '--orphan', 'publication'), '')
    await writeFile(join(root, 'README.md'), 'clean baseline\n')
    assert.equal(git('add', 'README.md'), '')
    assert.equal(git('commit', '-q', '-m', 'publication baseline'), '')
    const publication = git('rev-parse', 'HEAD')
    await writeFile(join(root, 'README.md'), 'clean baseline plus one\n')
    assert.equal(git('commit', '-q', '-am', 'publication change'), '')
    assert.deepEqual(resolveRepositoryBaselines(upstream, publication, git), {
      upstreamCommit: upstream, publicationCommit: publication,
      historyBaselineCommit: publication, historyBaselineKind: 'publication', commitsAhead: 1,
    })
    assert.equal(resolveRepositoryBaselines(upstream, null, git).historyBaselineKind, null)

    const clone = join(root, 'isolated-clone')
    assert.equal(git('clone', '-q', '--no-local', '--single-branch', '--branch', 'publication', root, clone), '')
    const cloned = resolveRepositoryBaselines(upstream, publication, gitAt(clone))
    assert.equal(cloned.upstreamCommit, null)
    assert.equal(cloned.historyBaselineCommit, publication)
    assert.equal(cloned.historyBaselineKind, 'publication')
    assert.equal(cloned.commitsAhead, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
