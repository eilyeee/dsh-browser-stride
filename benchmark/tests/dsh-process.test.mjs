import test from 'node:test'
import assert from 'node:assert/strict'
import { redactHostLogLine } from '../lib/dsh-process.mjs'

test('Host logs redact launch, administrator and bearer credentials', () => {
  const line = 'dsh web: http://127.0.0.1:3000/?token=launch-secret&next=1 Bearer header-secret admin-secret'
  const sanitized = redactHostLogLine(line, ['admin-secret', 'launch-secret'])
  for (const secret of ['launch-secret', 'header-secret', 'admin-secret']) assert.equal(sanitized.includes(secret), false)
  assert.match(sanitized, /token=\[redacted\]/u)
})
