import { createInterface } from 'node:readline'

// Minimal disposable MCP server: exercises the SDK calls used by DSH without
// network, accounts, real tools or side effects.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stride-test', version: '1.0.0' } }
      break
    case 'tools/list':
      result = { tools: [{ name: 'echo', description: 'Echo a test value', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: request.params.arguments.value }] }
      break
    default:
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`)
      continue
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
}
