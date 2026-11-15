// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'
import {runAction} from '../src/content/actions.ts'
import {ElementIds} from '../src/content/ids.ts'
import {observedRef} from './observed-ref.ts'

const budget={maxItems:20,maxForms:10,maxChars:8000}
function scroller(el:HTMLElement, height=200, total=1000){
  el.style.overflowY='auto'
  Object.defineProperties(el,{clientHeight:{configurable:true,value:height},scrollHeight:{configurable:true,value:total}})
  el.scrollTo=vi.fn((options:ScrollToOptions)=>{el.scrollTop=Math.max(0,Math.min(total-height,options.top??0))}) as typeof el.scrollTo
  return el
}
async function fixture(){
  document.body.innerHTML='<section id="outer"><div id="inner"><button>Item</button></div></section>'
  const inner=scroller(document.querySelector<HTMLElement>('#inner')!),outer=scroller(document.querySelector<HTMLElement>('#outer')!,400,2000)
  const button=document.querySelector('button')!,ids=new ElementIds(),ctx={ids,budget}
  const view=await runAction('browser_snapshot',{},ctx)
  return {inner,outer,button,ctx,view,elementRef:observedRef(view,ids,button)}
}
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren()})

describe('observation-bound nested scroll',()=>{
  it('shows the nearest vertical scroll context without assigning the container its own control reference',async()=>{
    const {view}=await fixture()
    expect(view.text).toContain('scroll-container top=0 max=800')
  })
  it.each(['down','bottom','up','top'])('scrolls only the nearest observed container: %s',async direction=>{
    const {inner,outer,ctx,elementRef}=await fixture();inner.scrollTop=100
    const viewport=vi.spyOn(window,'scrollBy').mockImplementation(()=>{})
    const result=await runAction('browser_scroll',{elementRef,direction,amount:75},ctx)
    expect(inner.scrollTop).toBe(({down:175,bottom:800,up:25,top:0} as Record<string,number>)[direction])
    expect(outer.scrollTop).toBe(0);expect(outer.scrollTo).not.toHaveBeenCalled();expect(viewport).not.toHaveBeenCalled()
    expect(result.text).toContain('Scroll position');expect(result.feedback?.state).toBe('observed')
  })
  it('uses the container height for the default increment and does not bubble at its boundary',async()=>{
    const {inner,outer,ctx,elementRef}=await fixture()
    await runAction('browser_scroll',{elementRef,direction:'down'},ctx);expect(inner.scrollTop).toBe(160)
    inner.scrollTop=800
    const result=await runAction('browser_scroll',{elementRef,direction:'down'},ctx)
    expect(result.text).toContain('already at the requested boundary');expect(outer.scrollTop).toBe(0)
  })
  it('rejects a control moved to a different container before dispatch without scrolling either',async()=>{
    const {inner,outer,button,ctx,elementRef}=await fixture();outer.append(button)
    await expect(runAction('browser_scroll',{elementRef,direction:'down'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(inner.scrollTo).not.toHaveBeenCalled();expect(outer.scrollTo).not.toHaveBeenCalled()
  })
  it('requires an observed container and never falls back to the window',async()=>{
    const {inner,outer,ctx,elementRef}=await fixture();inner.style.overflowY='hidden';outer.style.overflowY='clip'
    const viewport=vi.spyOn(window,'scrollBy').mockImplementation(()=>{})
    await expect(runAction('browser_scroll',{elementRef,direction:'down'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(viewport).not.toHaveBeenCalled()
  })
  it('rejects stale references from an earlier snapshot',async()=>{
    const {inner,ctx,elementRef}=await fixture();await runAction('browser_snapshot',{},ctx)
    await expect(runAction('browser_scroll',{elementRef,direction:'down'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(inner.scrollTo).not.toHaveBeenCalled()
  })
  it('marks a scroll rolled back by the page unconfirmed',async()=>{
    const {inner,ctx,elementRef}=await fixture();inner.scrollTo=vi.fn(()=>{inner.scrollTop=0})
    const result=await runAction('browser_scroll',{elementRef,direction:'down',amount:100},ctx)
    expect(result.feedback?.state).toBe('readback-unconfirmed');expect(result.text).toContain('read back 0')
  })
  it('retires references when the scroll handler replaces the container',async()=>{
    const {inner,ctx,elementRef}=await fixture();inner.scrollTo=vi.fn(()=>{inner.replaceWith(inner.cloneNode(true))})
    const result=await runAction('browser_scroll',{elementRef,direction:'down'},ctx)
    expect(result.feedback?.state).toBe('readback-unconfirmed');expect(ctx.ids.resolveReference(elementRef)).toBeUndefined()
  })
  it.each([0,-1,NaN,Infinity,100001])('rejects an invalid increment before any scroll: %s',async amount=>{
    const {inner,ctx,elementRef}=await fixture()
    await expect(runAction('browser_scroll',{elementRef,direction:'down',amount},ctx)).rejects.toMatchObject({code:'bad-args'})
    expect(inner.scrollTo).not.toHaveBeenCalled()
  })
  it('keeps viewport scrolling when no elementRef is supplied',async()=>{
    const {ctx}=await fixture();const viewport=vi.spyOn(window,'scrollBy').mockImplementation(()=>{})
    await runAction('browser_scroll',{direction:'down',amount:100},ctx)
    expect(viewport).toHaveBeenCalledWith({top:100,behavior:'instant'})
  })
})
