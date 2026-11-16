// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { PageAuthorizationAttempts } from '../src/page-authorization.ts'
import { PageAccessDiagnostics, authorizationNotice } from '../src/panel/PageAccessDiagnostics.tsx'
const empty = { activeGranted: false, controlledGranted: false, controlledTabId: null, revocableTabId: null }
describe('native authorization feedback', () => {
  it('does not let a slow old attempt replace a later native click or another window', () => {
    const tracker = new PageAuthorizationAttempts(), old = tracker.begin(1, 4), other = tracker.begin(2, 7), next = tracker.begin(1, 5)
    next(); old('page-access-denied'); other('pinned-tab')
    expect(tracker.get(1)).toEqual({ tabId: 5, phase: 'granted' })
    expect(tracker.get(2)).toEqual({ tabId: 7, phase: 'failed', code: 'pinned-tab' })
    expect(tracker.get(3)).toBeUndefined()
    tracker.get(1)!.tabId = 500
    expect(tracker.get(1)!.tabId).toBe(5)
  })
  it('forgets closed windows and refuses their late completion', () => {
    const tracker = new PageAuthorizationAttempts(), finish = tracker.begin(1, 4)
    tracker.forget(1); finish('page-access-denied'); expect(tracker.get(1)).toBeUndefined()
  })
  it('bounds retained native window outcomes', () => {
    const tracker = new PageAuthorizationAttempts(), old = tracker.begin(0, 1)
    for (let i=1;i<=32;i++) tracker.begin(i, i)
    old('page-access-denied')
    expect(tracker.get(0)).toBeUndefined()
    expect(tracker.get(32)).toMatchObject({ phase: 'authorizing' })
  })
  it.each([true, false])('explains pinned tabs and does not interpret an unselected target as missing permission: zh=%s', zh => {
    const message = authorizationNotice({ ...empty, authorization: { phase: 'failed', tabId: 4, code: 'pinned-tab' } }, zh)
    expect(message).toContain(zh ? '取消固定' : 'Unpin')
    expect(authorizationNotice(empty, zh)).toContain(zh ? '本窗口' : 'this window')
  })
  it('renders a zero-page state and refreshes without requesting page authority', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host), refreshPageAccess=vi.fn(async()=>{})
    try {
      await act(async()=>root.render(createElement(PageAccessDiagnostics,{api:{refreshPageAccess},access:{...empty,authorizedPageCount:0,authorization:{phase:'failed',tabId:4,code:'page-access-denied'}},locale:'zh'})))
      expect(host.querySelector('details')!.open).toBe(true);expect(host.textContent).toContain('0 个已授权页面');expect(host.textContent).toContain('网站访问权限')
      await act(async()=>host.querySelector('button')!.click())
      expect(refreshPageAccess).toHaveBeenCalledTimes(1);expect(host.textContent).toContain('页面列表已刷新')
    }finally{await act(async()=>root.unmount());host.remove()}
  })
})
