import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
/** Installed package metadata, with no home paths or credentials in the wire. */
export function bridgeRelease(): { bridgeVersion: string; dshVersion: string } {
  const require = createRequire(import.meta.url)
  const bridgeVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
  const dshVersion = (require('@deepseek-ai/dsh-agent/package.json') as { version: string }).version
  return { bridgeVersion, dshVersion }
}
