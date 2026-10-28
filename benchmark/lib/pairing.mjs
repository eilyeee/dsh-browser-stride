async function requestPairing(baseUrl, adminToken, request) {
  const target = new URL(baseUrl)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
    || target.username !== '' || target.password !== '' || target.search !== '' || target.hash !== ''
    || (target.pathname !== '/' && target.pathname !== '')) {
    throw new Error('benchmark pairing requires a literal local HTTP Host address')
  }
  target.pathname = '/ext/bridge-pairing'
  const response = await fetch(target, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`benchmark pairing failed (HTTP ${response.status})`)
  return response.json()
}

/** Issue a browser pairing code without exposing the Host administrator token. */
export async function issuePairingCode(baseUrl, adminToken) {
  const result = await requestPairing(baseUrl, adminToken, { action: 'issue' })
  if (typeof result?.code !== 'string' || !/^[a-f0-9]{32}$/u.test(result.code)
    || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) {
    throw new Error('benchmark pairing returned an invalid code')
  }
  return result.code
}

/** Enumerate the test Host's paired installations without returning credentials. */
export async function listInstallations(baseUrl, adminToken) {
  const result = await requestPairing(baseUrl, adminToken, { action: 'list' })
  if (!Array.isArray(result?.installations)
    || result.installations.some((item) => typeof item?.installationId !== 'string')) {
    throw new Error('benchmark pairing returned an invalid installation list')
  }
  return result.installations
}

/** Revoke a test installation and disconnect its active bridge connection. */
export async function revokeInstallation(baseUrl, adminToken, installationId) {
  if (typeof installationId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(installationId)) {
    throw new Error('invalid benchmark installation ID')
  }
  const result = await requestPairing(baseUrl, adminToken, { action: 'revoke', installationId })
  if (typeof result?.revoked !== 'boolean') throw new Error('benchmark pairing returned an invalid revocation result')
  return result.revoked
}
