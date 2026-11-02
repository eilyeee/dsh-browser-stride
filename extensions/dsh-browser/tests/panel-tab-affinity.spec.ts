// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TabAffinityBanner } from '../src/panel/App.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'

describe('page binding controls', () => {
  it('keeps page information without exposing connection unpairing in the page banner', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container=document.createElement('div');document.body.append(container)
    const root=createRoot(container)
    const tab={tabId:1,windowId:1,title:'Synthetic page',url:'https://example.com/'}
    try {
      await act(async()=>root.render(createElement(TabAffinityBanner,{state:{revision:1,status:'following',controlled:tab,active:tab,pinned:false},copy:PANEL_COPY.zh,onDecision:vi.fn()})))
      expect(container.textContent).toContain('Synthetic page')
      expect(container.querySelector('.unbind')).toBeNull()
      await act(async()=>root.render(createElement(TabAffinityBanner,{state:{revision:2,status:'lost',controlled:null,active:tab,pinned:false,detached:true},copy:PANEL_COPY.zh,onDecision:vi.fn()})))
      expect(container.textContent).toContain('页面已解绑')
      expect(container.textContent).toContain('使用当前页面')
      expect(container.querySelector('.unbind')).toBeNull()
    } finally { await act(async()=>root.unmount());container.remove() }
  })
})
