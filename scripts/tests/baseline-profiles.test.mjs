import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectProfiles, profileRoot } from '../baseline-profiles.mjs'

test('detects profiles under the configured DSH_HOME, not the default home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stride-profiles-'))
  try {
    const home = join(root, 'user')
    const custom = join(root, 'custom')
    await mkdir(join(custom, 'profiles', 'web'), { recursive: true })
    await writeFile(join(custom, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { '@eilyeee/dsh-stride-browser-bridge': '1.0.0' },
    }))
    assert.equal(profileRoot({}, home), join(home, '.dsh', 'profiles'))
    assert.equal(profileRoot({ DSH_HOME: '~/other' }, home), join(home, 'other', 'profiles'))
    assert.deepEqual(detectProfiles({ DSH_HOME: custom }, home).map(({ name, bridgeInstalled }) => ({ name, bridgeInstalled })), [
      { name: 'web', bridgeInstalled: true },
    ])
    assert.deepEqual(detectProfiles({}, home), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('recognizes current and legacy bridge names without accepting lookalike packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stride-profile-package-names-'))
  try {
    const names = ['@eilyeee/dsh-stride-browser-bridge', '@yuxianglin/dsh-bridge-browser', '@deepseek-ai/dsh-bridge-browser', 'unrelated-dsh-bridge-browser-helper']
    for (const [index, name] of names.entries()) {
      const dir = join(root, 'profiles', `profile-${index}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: '1.0.0' } }))
    }
    assert.deepEqual(detectProfiles({ DSH_HOME: root }).map(profile => profile.bridgeInstalled), [true, true, true, false])
  } finally { await rm(root, { recursive: true, force: true }) }
})
