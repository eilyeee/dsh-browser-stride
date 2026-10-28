import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { issuePairingCode, listInstallations, revokeInstallation } from '../lib/pairing.mjs'

test('benchmark obtains a one-time code through local administrator authentication', async (t) => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      body,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body.action === 'issue'
      ? { code: 'a'.repeat(32), expiresAt: Date.now() + 60_000 }
      : body.action === 'list' ? { installations: [{ installationId: 'synthetic-installation-1234' }] }
        : { revoked: body.installationId === 'synthetic-installation-1234' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`

  assert.equal(await issuePairingCode(base, 'synthetic-administrator'), 'a'.repeat(32))
  assert.deepEqual(requests, [{
    url: '/ext/bridge-pairing',
    authorization: 'Bearer synthetic-administrator',
    origin: undefined,
    body: { action: 'issue' },
  }])
  for (const url of ['https://127.0.0.1', 'http://localhost', 'http://127.0.0.1/other', 'http://127.0.0.1/?token=test']) {
    await assert.rejects(issuePairingCode(url, 'synthetic-administrator'), /literal local HTTP Host/u)
  }
  assert.equal(requests.length, 1)
  assert.deepEqual(await listInstallations(base, 'synthetic-administrator'), [{ installationId: 'synthetic-installation-1234' }])
  assert.equal(await revokeInstallation(base, 'synthetic-administrator', 'synthetic-installation-1234'), true)
  await assert.rejects(revokeInstallation(base, 'synthetic-administrator', 'invalid'), /invalid benchmark installation ID/u)
  assert.deepEqual(requests.slice(1).map((request) => request.body), [
    { action: 'list' },
    { action: 'revoke', installationId: 'synthetic-installation-1234' },
  ])
})
