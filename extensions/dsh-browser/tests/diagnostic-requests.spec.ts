// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DiagnosticRequests } from '../src/panel/diagnostic-requests.ts'

describe('diagnostic panel reply ownership', () => {
  it('rejects an earlier disabled status after native start, including its late failure', () => {
    const owner = new DiagnosticRequests(), before = owner.read()!, action = owner.mutate()!
    expect(before.current()).toBe(false)
    expect(action.current()).toBe(true)
    expect(owner.read()).toBeUndefined(); expect(owner.mutate()).toBeUndefined()
    expect(action.finish()).toBe(true); expect(action.finish()).toBe(false)
    expect(before.current()).toBe(false)
    const after = owner.read()!; expect(action.current()).toBe(false); expect(after.current()).toBe(true)
  })
  it('accepts only the newest poll even when responses finish in reverse order', () => {
    const owner = new DiagnosticRequests(), first = owner.read()!, second = owner.read()!
    expect(second.current()).toBe(true); expect(first.current()).toBe(false)
  })
  it('does not let an old cleanup release the successor action or revive after away-and-back', () => {
    const owner = new DiagnosticRequests(), old = owner.mutate()!
    owner.invalidate()
    const current = owner.mutate()!
    expect(old.current()).toBe(false); expect(old.finish()).toBe(false)
    expect(owner.read()).toBeUndefined(); expect(owner.mutate()).toBeUndefined()
    expect(current.finish()).toBe(true); expect(owner.read()).toBeDefined()
  })
  it('retires pending replies on unmount or scope loss without replaying an action', () => {
    const owner = new DiagnosticRequests(), action = owner.mutate()!
    owner.invalidate()
    expect(action.current()).toBe(false); expect(action.finish()).toBe(false)
    expect(owner.read()?.current()).toBe(true)
    const nextScope = new DiagnosticRequests()
    expect(nextScope.read()?.current()).toBe(true); expect(action.current()).toBe(false)
  })
})
