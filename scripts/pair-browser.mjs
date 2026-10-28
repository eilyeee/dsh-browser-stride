#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const urlIndex = args.indexOf('--url')
const rawUrl = urlIndex < 0 ? 'http://127.0.0.1:3080' : args[urlIndex + 1]
if (urlIndex >= 0) args.splice(urlIndex, 2)
const action = args[0] ?? 'issue'
if (rawUrl === undefined || !['issue', 'list', 'revoke'].includes(action)
  || (action === 'revoke' && (args.length !== 2 || !/^[a-zA-Z0-9_-]{16,128}$/.test(args[1])))
  || (action !== 'revoke' && args.length > 1)) {
  throw new Error('Usage: pnpm run pair:browser -- [issue|list|revoke INSTALLATION_ID] [--url http://127.0.0.1:PORT]')
}
const target = new URL(rawUrl)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password
  || target.search || target.hash || (target.pathname !== '/' && target.pathname !== '')) {
  throw new Error('Pairing administration requires a literal local HTTP Host address')
}
target.pathname = '/ext/bridge-pairing'
const configuredHome = process.env.DSH_HOME?.trim()
const home = configuredHome === undefined || configuredHome === '' ? join(homedir(), '.dsh')
  : configuredHome === '~' ? homedir()
    : configuredHome.startsWith('~/') ? join(homedir(), configuredHome.slice(2)) : resolve(configuredHome)
const adminToken = process.env.DSH_BRIDGE_ADMIN_TOKEN ?? (await readFile(join(home, 'ext-bridge-token'), 'utf8')).trim()
const response = await fetch(target, {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ action, ...(action === 'revoke' ? { installationId: args[1] } : {}) }),
  signal: AbortSignal.timeout(10_000),
})
if (!response.ok) throw new Error(`Pairing administration failed (HTTP ${response.status})`)
const result = await response.json()
if (action === 'issue') {
  console.log(`One-time pairing code: ${result.code}\nExpires: ${new Date(result.expiresAt).toISOString()}\nEnter it in the extension settings; do not share it.`)
} else if (action === 'list') {
  console.log(JSON.stringify(result.installations, null, 2))
} else {
  console.log(result.revoked ? 'Installation revoked.' : 'Installation was not registered.')
}
