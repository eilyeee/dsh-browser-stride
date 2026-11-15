// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAction, waitForPageSettled } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { observedRef } from './observed-ref.ts'

const policy = { minimumMs: 20, quietMs: 20, maxAfterReadyMs: 60, timeoutMs: 100 }
function component(parent: Node = document.body): ShadowRoot {
  const host = document.createElement('div'); parent.appendChild(host)
  const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<p>initial</p>'
  return root
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

describe('bounded open-component settling', () => {
  it.each(['attributes', 'childList', 'characterData'])('extends quiet time for nested shadow %s changes', async kind => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const root = component(component()), p = root.querySelector('p')!
    let resolved = false
    const pending = waitForPageSettled(policy).then(result => { resolved = true; return result })
    setTimeout(() => {
      if (kind === 'attributes') p.setAttribute('data-ready', 'yes')
      else if (kind === 'childList') p.append(' update')
      else p.firstChild!.nodeValue = 'updated'
    }, 15)
    await vi.advanceTimersByTimeAsync(34); expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toBe(true)
  })

  it('discovers a root attached to an existing host without a document mutation', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const host = document.createElement('div'); document.body.append(host)
    let resolved = false
    const pending = waitForPageSettled(policy).then(result => { resolved = true; return result })
    setTimeout(() => {
      const root = host.attachShadow({ mode: 'open' }); root.innerHTML = '<p>initial</p>'
      setTimeout(() => { root.querySelector('p')!.textContent = 'updated' }, 15)
    }, 15)
    await vi.advanceTimersByTimeAsync(49); expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toBe(true)
  })

  it('observes roots of newly inserted components', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    let resolved = false
    const pending = waitForPageSettled(policy).then(result => { resolved = true; return result })
    setTimeout(() => {
      const root = component()
      setTimeout(() => { root.querySelector('p')!.textContent = 'updated' }, 15)
    }, 10)
    await vi.advanceTimersByTimeAsync(44); expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toBe(true)
  })

  it('caps a continuously changing component instead of reporting quiet', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const root = component(); let tick = 0
    const timer = setInterval(() => { root.querySelector('p')!.textContent = String(++tick) }, 10)
    const pending = waitForPageSettled(policy)
    await vi.advanceTimersByTimeAsync(60); clearInterval(timer); await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['roots', 'depth', 'elements'])('cannot claim quiet when the %s inspection bound is exceeded', async kind => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    if (kind === 'roots') for (let i = 0; i < 65; i++) component()
    else if (kind === 'depth') { let root: Node = document.body; for (let i = 0; i < 17; i++) root = component(root) }
    else document.body.innerHTML = '<i></i>'.repeat(50_001)
    const pending = waitForPageSettled(policy)
    await vi.advanceTimersByTimeAsync(60); await expect(pending).resolves.toBe(false)
  }, 15_000)

  it('ignores mutations in a detached old root', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const root = component(), pending = waitForPageSettled(policy)
    setTimeout(() => { root.host.remove() }, 10)
    setTimeout(() => { root.querySelector('p')!.textContent = 'detached' }, 25)
    await vi.advanceTimersByTimeAsync(30); await expect(pending).resolves.toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds cumulative subscriptions when many short-lived components replace each other', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    let root = component(), replacements = 0
    const timer = setInterval(() => {
      root.host.remove(); root = component()
      if (++replacements === 70) clearInterval(timer)
    }, 4)
    const pending = waitForPageSettled({ ...policy, quietMs: 30, maxAfterReadyMs: 400 })
    await vi.advanceTimersByTimeAsync(401); clearInterval(timer)
    await expect(pending).resolves.toBe(false); expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['document', 'shadow'])('does not let high-frequency %s changes postpone the deadline', async kind => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const target = kind === 'shadow' ? component().querySelector('p')! : document.body
    let tick = 0, result: boolean | 'pending' = 'pending'
    const timer = setInterval(() => { target.setAttribute('data-tick', String(++tick)) }, 1)
    const pending = waitForPageSettled(policy).then(value => { result = value })
    await vi.advanceTimersByTimeAsync(61); const atDeadline = result
    clearInterval(timer); await vi.advanceTimersByTimeAsync(100); await pending
    expect(atDeadline).toBe(false); expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the quiet window after document readiness', async () => {
    vi.useFakeTimers()
    const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
    const root = component(); let resolved = false
    const pending = waitForPageSettled(policy).then(result => { resolved = true; return result })
    setTimeout(() => { ready.mockReturnValue('complete'); document.dispatchEvent(new Event('readystatechange')) }, 30)
    setTimeout(() => { root.querySelector('p')!.textContent = 'updated' }, 45)
    await vi.advanceTimersByTimeAsync(64); expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toBe(true)
  })

  it('disconnects component observers and timers after returning', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const root = component(), disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const pending = waitForPageSettled(policy)
    await vi.advanceTimersByTimeAsync(20); await expect(pending).resolves.toBe(true)
    expect(disconnect).toHaveBeenCalledOnce()
    root.querySelector('p')!.textContent = 'after completion'
    await vi.advanceTimersByTimeAsync(100); expect(vi.getTimerCount()).toBe(0)
  })

  it('withholds an automatic delta and retires references after a component fails to settle', async () => {
    vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
    const root = component(); root.innerHTML = '<button>Anchor</button><p>initial</p>'
    const ids = new ElementIds(), ctx = { ids, budget: { maxItems: 20, maxForms: 10, maxChars: 4_000 }, includePageDelta: true }
    const snapshot = await runAction('browser_snapshot', {}, ctx)
    const ref = observedRef(snapshot, ids, root.querySelector('button')!)
    let tick = 0
    const timer = setInterval(() => { root.querySelector('p')!.textContent = String(++tick) }, 20)
    const pending = runAction('browser_wait', {}, ctx)
    await vi.advanceTimersByTimeAsync(1_000); clearInterval(timer); await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result.text).toContain('did not become quiet'); expect(result.pageContent).toBeUndefined()
    expect(ids.resolveReference(ref)).toBeUndefined()
  })
})
