import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

test('DSH MCP client dependencies can initialize, list and call a disposable server', { timeout: 15_000 }, async () => {
  const workspaceRequire = createRequire(new URL('../../package.json', import.meta.url))
  const dshRequire = createRequire(workspaceRequire.resolve('@deepseek-ai/dsh/package.json'))
  const clientRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-mcp-client/package.json'))
  const { Client, StreamableHTTPClientTransport, specTypeSchemas } = await import(pathToFileURL(clientRequire.resolve('@modelcontextprotocol/client')).href)
  const { StdioClientTransport } = await import(pathToFileURL(clientRequire.resolve('@modelcontextprotocol/client/stdio')).href)
  assert.equal(typeof StreamableHTTPClientTransport, 'function')
  assert.ok(specTypeSchemas)
  const client = new Client({ name: 'dsh-mcp-client', version: '0.0.1' }, {
    capabilities: {}, versionNegotiation: { mode: 'auto' },
    listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {} } },
  })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../fixtures/mcp-smoke-server.mjs', import.meta.url))],
  })
  try {
    await client.connect(transport)
    assert.ok(client.getServerCapabilities()?.tools)
    assert.equal((await client.listTools(undefined, { cacheMode: 'refresh' })).tools[0].name, 'echo')
    assert.deepEqual((await client.callTool({ name: 'echo', arguments: { value: 'fixture' } })).content, [{ type: 'text', text: 'fixture' }])
  } finally { await client.close() }
})
