import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'

test('the archive dependency used by the office adapter retains its ZIP and zlib interfaces', async () => {
  const workspace = createRequire(new URL('../../package.json', import.meta.url))
  const dsh = createRequire(workspace.resolve('@deepseek-ai/dsh/package.json'))
  const web = createRequire(dsh.resolve('@deepseek-ai/dsh-web-app/package.json'))
  const pdf = createRequire(web.resolve('@deepseek-ai/dsh-office-to-pdf/package.json'))
  const office = createRequire(pdf.resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const { zipSync, unzipSync, strFromU8, zlibSync } = await import(pathToFileURL(office.resolve('fflate')).href)
  const bytes = new TextEncoder().encode('fixture')
  assert.equal(strFromU8(unzipSync(zipSync({ 'document.xml': bytes }))['document.xml']), 'fixture')
  assert.equal(inflateSync(zlibSync(bytes)).toString('utf8'), 'fixture')
})
