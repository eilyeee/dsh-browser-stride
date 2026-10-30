import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const BRIDGE_PACKAGES = ['@eilyeee/dsh-browser-stride', '@eilyeee/dsh-stride-browser-bridge', '@yuxianglin/dsh-bridge-browser', '@deepseek-ai/dsh-bridge-browser']

export function profileRoot(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME?.trim()
  const dshHome = !configured ? join(home, '.dsh')
    : configured === '~' ? home
      : /^~[/\\]/.test(configured) ? join(home, configured.slice(2)) : resolve(configured)
  return join(dshHome, 'profiles')
}

export function detectProfiles(env = process.env, home = homedir()) {
  const base = profileRoot(env, home)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const dir = join(base, entry.name)
      let manifest = {}
      try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { /* no readable manifest */ }
      const dependencies = Object.keys(manifest.dependencies ?? {})
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const bridgeInstalled = BRIDGE_PACKAGES.some(name => dependencies.includes(name)
        || existsSync(join(dir, 'node_modules', ...name.split('/'))))
      return { name: entry.name, bundles, dependencies, bridgeInstalled, hasPatchLayer: existsSync(join(dir, 'cordis.patch.yml')) }
    })
}
