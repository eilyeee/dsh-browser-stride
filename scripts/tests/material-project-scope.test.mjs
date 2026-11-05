import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialProjectScope, guardMaterialProjectFile } from '../fixtures/material-project-scope.mjs'

test('the project fixture exposes editing only on its one pinned disposable file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stride-project-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'), file = join(project, 'README.md'), outside = join(root, 'outside.txt')
  await mkdir(project); await writeFile(file, 'synthetic'); await writeFile(outside, 'outside')
  const scope = await materialProjectScope(file)
  for (const file_path of [file, scope.canonicalFile, './README.md', 'README.md']) {
    assert.equal(guardMaterialProjectFile(scope, { file_path }), undefined, 'The guard must synchronously allow the valid file')
  }
  for (const args of [{}, { file_path: outside }, { file_path: '../outside.txt' }, { file_path: project },
    { file_path: file, sandbox_permissions: 'danger-full-access', justification: 'test' }]) {
    assert.equal(typeof await guardMaterialProjectFile(scope, args), 'string')
  }
  await unlink(file); await symlink(outside, file)
  assert.equal(typeof await guardMaterialProjectFile(scope, { file_path: file }), 'string')
  assert.equal(typeof await guardMaterialProjectFile(scope, { file_path: outside }), 'string')
  await assert.rejects(materialProjectScope(file), /regular file/u)
})
