// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

describe('TabAffinityController', () => {
  it('unbinds only the displayed session and never lets implicit binding restore it', () => {
    const affinity = new TabAffinityController()
    affinity.bindNewSession('other', tab(2))
    affinity.bindNewSession('selected', tab(1))
    const revision = affinity.snapshot().revision
    expect(affinity.unbindSession('other', revision)).toBe(false)
    expect(affinity.unbindSession('selected', revision - 1)).toBe(false)
    expect(affinity.unbindSession('selected', revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'lost', controlled: null, detached: true })
    expect(affinity.getSessionTab('other')?.tabId).toBe(2)
    expect(affinity.resolveTarget('selected')).toEqual({ kind: 'lost' })
    expect(affinity.bindInitial(tab(1), 'selected')).toBe(false)
    expect(affinity.bindNewSession('selected', tab(1))).toBe(false)
    expect(affinity.bindNewSession('automatic-new', tab(1))).toBe(false)
    affinity.focusSession('automatic-new')
    affinity.focusSession('other')
    expect(affinity.isDetached('automatic-new')).toBe(true)
    affinity.focusSession('selected')
    affinity.bindSession('selected', tab(1))
    expect(affinity.allowsTarget(1, 'selected')).toBe(false)
    affinity.rebindActive(tab(1), 'selected')
    expect(affinity.isDetached('selected')).toBe(false)
    expect(affinity.resolveTarget('selected')).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('restores explicit revocation independently of stale session target records', () => {
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ selected: tab(1), other: tab(2) })
    affinity.restoreDetachedSessions(['selected'])
    affinity.restoreDetached()
    affinity.focusSession('selected')
    affinity.observeActive(tab(1))
    expect(affinity.resolveTarget('selected')).toEqual({ kind: 'lost' })
    expect(affinity.bindNewSession('automatic-new', tab(1))).toBe(false)
    expect(affinity.getSessionTab('other')?.tabId).toBe(2)
    expect(affinity.rebindActive(tab(1), 'selected')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following' })
    expect(affinity.snapshot().detached).toBeUndefined()
    expect(affinity.detachedSessionIds()).toEqual([])
  })

  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })

    affinity.observeTab(tab(1, 'Updated title'))
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1, title: 'Updated title' } })
  })

  it('keeps the selected group page across arbitrary human tab and window switches', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 's1')
    const revision = affinity.snapshot().revision
    for (const next of [tab(2), { ...tab(3), windowId: 9 }, tab(1), tab(4)]) {
      affinity.observeActive(next)
      expect(affinity.snapshot().revision).toBe(revision)
      expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
      expect(affinity.resolveTarget('s1')).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
      expect(affinity.allowsTarget(next.tabId)).toBe(next.tabId === 1)
    }
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 4 } })
  })

  it('does not make binding a background group page change the human active page', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(9))
    affinity.bindNewSession('s1', tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 9 } })
    affinity.bindInitial(tab(2), 's2')
    affinity.focusSession('s2')
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 2 }, active: { tabId: 9 } })
    const revision = affinity.snapshot().revision
    expect(affinity.focusSession('s2')).toBe(false)
    expect(affinity.snapshot().revision).toBe(revision)
  })

  it('supports explicit rebindActive when starting new chat', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
  })

  it('rebinds control to a listed background tab without changing the active tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1), 'session-1')

    expect(affinity.rebindControlled(tab(2), 'session-1')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 2 },
      active: { tabId: 1 },
    })
    expect(affinity.resolveTarget('session-1')).toMatchObject({ kind: 'target', tab: { tabId: 2 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot().status).toBe('background')
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'lost', controlled: null, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.bindInitial(tab(2))).toBe(false)

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('updates visibility if the user returns to the controlled tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.observeActive(tab(1, 'Tab 1 again'))

    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { title: 'Tab 1 again' } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    expect(restored.restoreControlled(tab(4))).toBe(true)
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 4 }, active: { tabId: 5 } })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
  })

  it('supports independent per-session tab affinity for concurrent sessions', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.bindInitial(tab(1), 'session-1')).toBe(true)

    affinity.observeActive(tab(2))
    expect(affinity.rebindActive(tab(2), 'session-2')).toBe(true)

    expect(affinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })

    expect(affinity.allowsTarget(1, 'session-1')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-1')).toBe(false)
    expect(affinity.allowsTarget(2, 'session-2')).toBe(true)
    expect(affinity.allowsTarget(1, 'session-2')).toBe(false)

    expect(affinity.focusSession('session-1')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 1 } })
    expect(affinity.focusSession('session-2')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 2 } })

    const sessionMap = affinity.sessionMap()
    expect(sessionMap['session-1']).toEqual(tab(1))
    expect(sessionMap['session-2']).toEqual(tab(2))

    const restoredAffinity = new TabAffinityController()
    restoredAffinity.restoreSessionTabs(sessionMap)
    expect(restoredAffinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(restoredAffinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })
    expect(restoredAffinity.resolveTarget('session-missing')).toEqual({ kind: 'lost' })
    expect(restoredAffinity.allowsTarget(2, 'session-missing')).toBe(false)
  })
})
