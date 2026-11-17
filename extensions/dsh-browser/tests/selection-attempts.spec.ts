// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { SelectionAttempts } from '../src/background/selection-attempts.ts'

describe('native selection evidence', () => {
  it('isolates conversations and rejects stale completions without returning identities or raw errors', () => {
    const attempts = new SelectionAttempts()
    const old = attempts.begin('private-session-a'), latest = attempts.begin('private-session-a')
    const other = attempts.begin('private-session-b')
    old(); expect(attempts.snapshot('private-session-a')).toEqual({ state: 'pending' })
    latest('stale-binding'); other()
    expect(attempts.snapshot('private-session-a')).toEqual({ state: 'failed', code: 'stale-binding' })
    expect(attempts.snapshot('private-session-b')).toEqual({ state: 'selected' })
    const unsafe = attempts.begin('private-session-a'); unsafe('secret URL or page title')
    expect(attempts.snapshot('private-session-a')).toEqual({ state: 'failed', code: 'no-active-tab' })
    expect(JSON.stringify(attempts.snapshot('private-session-a'))).not.toContain('private-session')
    expect(attempts.snapshot()).toEqual({ state: 'not-observed' })
  })
  it('expires evidence and bounds retained conversations; expired completions cannot restore it', () => {
    let now = 0
    const attempts = new SelectionAttempts(() => now, 10, 2)
    const first = attempts.begin('a'); attempts.begin('b'); attempts.begin('c')
    first(); expect(attempts.snapshot('a')).toEqual({ state: 'not-observed' })
    const late = attempts.begin('b'); now = 10; late()
    expect(attempts.snapshot('b')).toEqual({ state: 'not-observed' })
    expect(attempts.snapshot('c')).toEqual({ state: 'not-observed' })
  })
})
