// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { RunTargetRegistry } from '../src/background/run-targets.ts'
import { TargetLeaseRegistry, type ToolTargetIdentity } from '../src/background/target-leases.ts'

const scope = { kind: 'run' as const, runId: 'run-a', controlRevision: 0 }
function fixture(capacity = 5000) {
  const targets = new TargetLeaseRegistry()
  let selected: ToolTargetIdentity = { tabId: 1, windowId: 1, url: 'https://example.test/a' }
  let next = 0
  const runs = new RunTargetRegistry(capacity, () => `page_synthetic_${++next}`)
  const capture = () => targets.capture('session-a', selected, () => selected)
  return { targets, runs, capture, select: (tab: Partial<ToolTargetIdentity>) => { selected = { ...selected, ...tab } } }
}
describe('run target pins', () => {
  it('requires the exact prepared target before a handoff can enter browser dispatch', () => {
    const { runs, capture, targets, select } = fixture()
    const prepared = runs.prepare(scope, 'session-a', capture())!
    expect(runs.join(scope, 'session-a', capture())).toBeUndefined()
    expect(runs.join(scope, 'session-a', capture(), 'foreign')).toBeUndefined()
    const accepted = runs.join(scope, 'session-a', capture(), prepared.id)!
    expect(accepted.accept()).toBe(true)
    targets.invalidateDocument(1)
    select({ url: 'https://example.test/next' })
    expect(accepted.current()).toBe(true)
  })
  it('does not follow a document change before prepared-target confirmation', () => {
    const { runs, capture, targets } = fixture()
    const prepared = runs.prepare(scope, 'session-a', capture())!
    const pending = runs.join(scope, 'session-a', capture(), prepared.id)!
    targets.invalidateDocument(1)
    expect(pending.accept()).toBe(false)
    expect(pending.current()).toBe(false)
    expect(runs.join(scope, 'session-a', capture(), prepared.id)).toBeDefined()
    expect(runs.join(scope, 'session-a', capture(), prepared.id)!.accept()).toBe(false)
  })
  it('cannot restore prepared handoffs after owner replacement or move them into another revision', () => {
    const { runs, capture } = fixture()
    const prepared = runs.prepare(scope, 'session-a', capture())!
    expect(runs.join({ ...scope, controlRevision: 1 }, 'session-a', capture(), prepared.id)).toBeUndefined()
    runs.revokeAll()
    expect(prepared.current()).toBe(false)
    expect(runs.join(scope, 'session-a', capture(), prepared.id)).toBeUndefined()
  })
  it('keeps the original tab across observed navigation while fencing an older document request', () => {
    const { runs, targets, capture, select } = fixture()
    const before = capture()
    const pin = runs.join(scope, 'session-a', before)!
    targets.invalidateDocument(1)
    select({ url: 'https://example.test/next' })
    expect(before.current()).toBe(false)
    expect(pin.current()).toBe(true)
    expect(runs.join(scope, 'session-a', capture(), pin.id)?.id).toBe(pin.id)
  })
  it('never follows a rebind away and back in the same control revision', () => {
    const { runs, targets, capture, select } = fixture()
    const pin = runs.join(scope, 'session-a', capture())!
    targets.invalidateSession('session-a')
    select({ tabId: 2 })
    expect(pin.current()).toBe(false)
    expect(runs.join(scope, 'session-a', capture(), pin.id)).toBeUndefined()
    select({ tabId: 1 })
    expect(runs.join(scope, 'session-a', capture(), pin.id)).toBeUndefined()
    expect(runs.join({ ...scope, controlRevision: 2 }, 'session-a', capture())?.id).not.toBe(pin.id)
  })
  it.each(['same-url tab', 'moved window', 'reused id'])('rejects a lookalike target after %s', kind => {
    const { runs, targets, capture, select } = fixture()
    const pin = runs.join(scope, 'session-a', capture())!
    if (kind === 'same-url tab') select({ tabId: 2 })
    else if (kind === 'moved window') select({ windowId: 2 })
    else targets.forgetTab(1)
    expect(runs.join(scope, 'session-a', capture(), pin.id)).toBeUndefined()
  })
  it('does not reconstruct an expected id after connection/worker loss', () => {
    const { runs, capture } = fixture()
    const pin = runs.join(scope, 'session-a', capture())!
    runs.revokeAll()
    expect(pin.current()).toBe(false)
    expect(runs.join(scope, 'session-a', capture(), pin.id)).toBeUndefined()
  })
  it('rejects a different session or forged expected id', () => {
    const { runs, capture } = fixture()
    const pin = runs.join(scope, 'session-a', capture())!
    expect(runs.join(scope, 'other-session', capture(), pin.id)).toBeUndefined()
    expect(runs.join(scope, 'session-a', capture(), 'page_foreign')).toBeUndefined()
  })
  it('bounds state without evicting an old pin or letting an unconfirmed revision replace it', () => {
    const { runs, capture } = fixture(2)
    const pin = runs.join(scope, 'session-a', capture())!
    runs.join({ ...scope, controlRevision: 10 }, 'session-a', capture())
    expect(pin.current()).toBe(true)
    expect(runs.join({ ...scope, runId: 'run-b' }, 'session-a', capture())).toBeUndefined()
    expect(runs.join(scope, 'session-a', capture(), pin.id)?.id).toBe(pin.id)
  })
})
