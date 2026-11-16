// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { TargetLeaseRegistry, type ToolTargetIdentity } from '../src/background/target-leases.ts'

const target = (): ToolTargetIdentity => ({ tabId: 7, windowId: 3, url: 'https://example.test/form' })

describe('receive-time browser target leases', () => {
  it('revokes input/observation on native intervention while preserving page authority for diagnostics', () => {
    const registry = new TargetLeaseRegistry(), value = target(), old = registry.capture('a', value, () => value)
    registry.invalidateObservation(value.tabId)
    expect(old.current()).toBe(true); expect(old.sameBinding()).toBe(true); expect(old.observationCurrent()).toBe(false)
    const fresh = registry.capture('a', value, () => value)
    expect(fresh.observationCurrent()).toBe(true); expect(fresh.observationScope).not.toBe(old.observationScope)
  })
  it('keeps an observation owner stable for one binding and rotates it across session/tab/worker ownership changes', () => {
    const registry = new TargetLeaseRegistry(), value = target()
    const capture = (sid = 'a') => registry.capture(sid, value, () => value).observationScope
    const initial = capture()
    expect(capture()).toBe(initial); expect(capture('b')).not.toBe(initial)
    registry.invalidateDocument(value.tabId)
    expect(capture()).toBe(initial) // Native frame/reset state owns document identity separately.
    registry.invalidateSession('a'); expect(capture()).not.toBe(initial)
    const beforeClose = capture(); registry.forgetTab(value.tabId); expect(capture()).not.toBe(beforeClose)
    const beforeRestart = capture(); registry.revokeAll(); expect(capture()).not.toBe(beforeRestart)
  })
  it('fences a page creation before any target exists, including away-and-back and owner changes', () => {
    const registry = new TargetLeaseRegistry()
    const before = registry.captureSession('session-a')
    registry.invalidateSession('session-b')
    expect(before()).toBe(true)
    registry.invalidateSession('session-a')
    expect(before()).toBe(false)
    const bound = registry.captureSession('session-a')
    registry.forgetTab(7)
    expect(bound()).toBe(true) // Revoking our page grant must not impersonate a session rebind.
    registry.revokeAll()
    expect(bound()).toBe(false)
  })
  it('pins tab, window and URL without trusting mutable metadata or titles', () => {
    const registry = new TargetLeaseRegistry()
    const original = target()
    let selected: ToolTargetIdentity | undefined = target()
    const lease = registry.capture('session-a', original, () => selected)
    original.tabId = 9
    expect(lease.target.tabId).toBe(7)
    expect(lease.current()).toBe(true)
    selected = { ...target(), windowId: 4 }
    expect(lease.current()).toBe(false)
    expect(lease.sameBinding()).toBe(false)
    selected = undefined
    expect(lease.current()).toBe(false)
  })

  it('never revives a request after a binding changes away and back', () => {
    const registry = new TargetLeaseRegistry()
    let selected = target()
    const lease = registry.capture('session-a', target(), () => selected)
    registry.invalidateSession('session-a')
    selected = { ...target(), tabId: 8 }
    selected = target()
    expect(lease.current()).toBe(false)
    expect(lease.sameBinding()).toBe(false)
    expect(registry.capture('session-a', target(), () => selected).current()).toBe(true)
  })

  it('fences same-URL reloads/history changes while preserving a committed action binding', () => {
    const registry = new TargetLeaseRegistry()
    let selected = target()
    const lease = registry.capture('session-a', selected, () => selected)
    registry.invalidateDocument(7)
    expect(lease.current()).toBe(false)
    expect(lease.sameBinding()).toBe(true)
    selected = { ...target(), url: 'https://example.test/next' }
    expect(lease.current()).toBe(false)
    expect(lease.sameBinding()).toBe(true)
    expect(registry.capture('session-a', selected, () => selected).current()).toBe(true)
  })

  it('does not let closed, replaced or moved tab ids regain an old lease', () => {
    const registry = new TargetLeaseRegistry()
    const selected = target()
    const old = registry.capture('session-a', selected, () => selected)
    registry.forgetTab(7)
    expect(registry.capture('session-a', selected, () => selected).current()).toBe(true)
    expect(old.current()).toBe(false)
    expect(old.sameBinding()).toBe(false)
  })

  it('keeps other session bindings and unrelated tabs independent', () => {
    const registry = new TargetLeaseRegistry()
    const a = registry.capture('session-a', target(), target)
    const bTarget = { ...target(), tabId: 8 }
    const b = registry.capture('session-b', bTarget, () => bTarget)
    registry.invalidateSession('session-a')
    registry.invalidateDocument(7)
    expect(a.current()).toBe(false)
    expect(b.current()).toBe(true)
  })

  it('does not revoke another session on the same page for a session-only handoff', () => {
    const registry = new TargetLeaseRegistry()
    const a = registry.capture('session-a', target(), target)
    const b = registry.capture('session-b', target(), target)
    registry.invalidateSession('session-a')
    expect(a.current()).toBe(false)
    expect(b.current()).toBe(true)
    registry.invalidateDocument(7)
    expect(b.current()).toBe(false)
  })

  it('detects a changed URL even before a navigation epoch is reported', () => {
    const registry = new TargetLeaseRegistry()
    let selected = target()
    const lease = registry.capture('session-a', selected, () => selected)
    selected = { ...target(), url: 'https://example.test/other' }
    expect(lease.current()).toBe(false)
    expect(lease.sameBinding()).toBe(true)
  })

  it('does not acquire a successor connection owner even when every target field is identical', () => {
    const registry = new TargetLeaseRegistry()
    const old = registry.capture(undefined, target(), target)
    registry.revokeAll()
    expect(registry.capture(undefined, target(), target).current()).toBe(true)
    expect(old.current()).toBe(false)
    expect(old.sameBinding()).toBe(false)
  })
})
