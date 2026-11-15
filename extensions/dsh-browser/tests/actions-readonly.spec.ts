// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {runAction} from '../src/content/actions.ts'
import {ElementIds} from '../src/content/ids.ts'
import {observedRef} from './observed-ref.ts'

const budget={maxItems:20,maxForms:10,maxChars:4000}
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks()})

describe('read-only field editing',()=>{
  it.each([
    '<select aria-label="Field" aria-readonly="true"><option>Small</option><option>Large</option></select>',
    '<section aria-readonly="true"><select aria-label="Field"><option>Small</option><option>Large</option></select></section>',
    '<input aria-label="Field" readonly value="old">',
    '<textarea aria-label="Field" aria-readonly="true">old</textarea>',
    '<div contenteditable="true" role="textbox" aria-label="Field" aria-readonly="true">old</div>',
  ])('refuses a direct edit before firing field events: %s',async markup=>{
    document.body.innerHTML=markup
    const field=document.querySelector('[aria-label="Field"]')!,ids=new ElementIds(),events=vi.fn()
    field.addEventListener('input',events);field.addEventListener('change',events)
    const snapshot=await runAction('browser_snapshot',{},{ids,budget})
    const select=field instanceof HTMLSelectElement
    await expect(runAction(select?'browser_select':'browser_type',{
      elementRef:observedRef(snapshot,ids,field),...(select?{optionIndex:1}:{text:'changed',replace:true}),
    },{ids,budget})).rejects.toMatchObject({code:'field-readonly'})
    expect(events).not.toHaveBeenCalled()
    if(select)expect(field.selectedIndex).toBe(0)
    else if(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement)expect(field.value).toBe('old')
    else expect(field.textContent).toBe('old')
    expect(snapshot.text).toContain('readonly')
  })

  it.each(['input','change','late'])('reports partial selection when %s makes it read-only',async stage=>{
    document.body.innerHTML='<select aria-label="Field"><option>Small</option><option>Large</option></select>'
    const field=document.querySelector('select')!,ids=new ElementIds(),changed=vi.fn()
    field.addEventListener(stage==='late'?'input':stage,()=>{
      const lock=()=>field.setAttribute('aria-readonly','true')
      if(stage==='late')queueMicrotask(lock);else lock()
    })
    field.addEventListener('change',changed)
    const snapshot=await runAction('browser_snapshot',{},{ids,budget}),elementRef=observedRef(snapshot,ids,field)
    const result=await runAction('browser_select',{elementRef,optionIndex:1},{ids,budget})
    expect(field.selectedIndex).toBe(1)
    expect(changed).toHaveBeenCalledTimes(stage==='input'?0:1)
    expect(result.feedback).toEqual({version:1,state:'readback-unconfirmed',businessChange:'not-verified'})
    await expect(runAction('browser_select',{elementRef,optionIndex:0},{ids,budget})).rejects.toThrow('stale')
  })

  it('still lets a native readonly input open its intended picker',async()=>{
    document.body.innerHTML='<input readonly aria-label="Picker"><div id="options" hidden>Large</div>'
    const field=document.querySelector('input')!,options=document.querySelector<HTMLElement>('#options')!,ids=new ElementIds()
    field.scrollIntoView=vi.fn();field.addEventListener('click',()=>{options.hidden=false})
    const snapshot=await runAction('browser_snapshot',{},{ids,budget})
    await runAction('browser_click',{elementRef:observedRef(snapshot,ids,field)},{ids,budget})
    expect(options.hidden).toBe(false)
    expect(field.value).toBe('')
  })

  it('includes a rich-text readonly change in a delta observation',async()=>{
    document.body.innerHTML='<div contenteditable="true" role="textbox" aria-label="Field">old</div>'
    const ids=new ElementIds(),field=document.querySelector('div')!
    await runAction('browser_snapshot',{},{ids,budget})
    field.setAttribute('aria-readonly','true')
    expect((await runAction('browser_snapshot',{delta:true},{ids,budget})).text).toContain('readonly')
  })
})
