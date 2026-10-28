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
      dependencies: { '@yuxianglin/dsh-bridge-browser': '1.0.0' },
    }))
    assert.equal(profileRoot({}, home), join(home, '.dsh', 'profiles'))
    assert.equal(profileRoot({ DSH_HOME: '~/other' }, home), join(home, 'other', 'profiles'))
    assert.deepEqual(detectProfiles({ DSH_HOME: custom }, home).map(({ name, bridgeInstalled }) => ({ name, bridgeInstalled })), [
      { name: 'web', bridgeInstalled: true },
    ])
    assert.deepEqual(detectProfiles({}, home), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
