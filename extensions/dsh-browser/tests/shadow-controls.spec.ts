// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {runAction} from '../src/content/actions.ts'
import {ElementIds} from '../src/content/ids.ts'
import {accessibleName,collectInteractive,pageText} from '../src/content/extract.ts'
import {observedRef} from './observed-ref.ts'

const budget={maxItems:40,maxForms:20,maxChars:12000}
function component(html='<label for="field">Component name</label><input id="field" value="old"><button>Save component</button>'){
  const host=document.createElement('div');document.body.append(host)
  const shadow=host.attachShadow({mode:'open'});shadow.innerHTML=html
  return {host,shadow}
}
async function fixture(){
  const {host,shadow}=component(),input=shadow.querySelector('input')!,ids=new ElementIds(),ctx={ids,budget}
  const view=await runAction('browser_snapshot',{},ctx)
  return {host,shadow,input,ctx,view,elementRef:observedRef(view,ids,input)}
}
afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren()})

describe('open shadow native controls',()=>{
  it('discovers nested open roots without entering closed roots',()=>{
    const {shadow}=component('<button>Outer</button><div></div>')
    shadow.querySelector('div')!.attachShadow({mode:'open'}).innerHTML='<button>Inner</button>'
    const closed=document.createElement('div');document.body.append(closed);closed.attachShadow({mode:'closed'}).innerHTML='<button>Closed</button>'
    expect(collectInteractive(document).map(el=>el.textContent)).toEqual(['Outer','Inner'])
  })
  it('resolves labels inside their own root, including all aria-labelledby tokens',()=>{
    document.body.innerHTML='<label for="field">Wrong outside label</label><span id="one">Wrong outside name</span>'
    const {shadow}=component('<label for="field">Local label</label><input id="field"><span id="one">Local</span><span id="two">name</span><input aria-labelledby="one two">')
    const fields=shadow.querySelectorAll('input')
    expect(accessibleName(fields[0]!)).toBe('Local label');expect(accessibleName(fields[1]!)).toBe('Local name')
  })
  it('shows native fields and edits their values through the existing reference path',async()=>{
    const {input,ctx,elementRef,view}=await fixture()
    expect(view.text).toContain('open shadow');expect(view.text).toContain('Component name');expect(view.text).toContain('value="old"')
    const result=await runAction('browser_type',{elementRef,text:'accepted',replace:true},ctx)
    expect(input.value).toBe('accepted');expect(result.feedback?.state).toBe('observed')
  })
  it('selects a native option in a shadow root',async()=>{
    const {shadow}=component('<select aria-label="Size"><option>Small</option><option>Large</option></select>')
    const select=shadow.querySelector('select')!,ids=new ElementIds(),ctx={ids,budget};const view=await runAction('browser_snapshot',{},ctx)
    const result=await runAction('browser_select',{elementRef:observedRef(view,ids,select),optionIndex:1},ctx)
    expect(select.value).toBe('Large');expect(result.feedback?.state).toBe('observed')
  })
  it('clicks the observed internal button once',async()=>{
    const {shadow}=component(),button=shadow.querySelector('button')!,clicked=vi.fn();button.scrollIntoView=vi.fn();button.addEventListener('click',clicked)
    const ids=new ElementIds(),ctx={ids,budget},view=await runAction('browser_snapshot',{},ctx)
    await runAction('browser_click',{elementRef:observedRef(view,ids,button)},ctx);expect(clicked).toHaveBeenCalledOnce()
  })
  it.each(['display','opacity'])('does not expose controls when the shadow host is hidden by %s',style=>{
    const {host}=component();host.style.setProperty(style,style==='display'?'none':'0')
    expect(collectInteractive(document)).toEqual([])
  })
  it.each(['inert','aria-disabled'])('rejects a prior control after its host becomes %s',async attribute=>{
    const {host,input,ctx,elementRef}=await fixture();host.setAttribute(attribute,attribute==='inert'?'':'true')
    await expect(runAction('browser_type',{elementRef,text:'changed'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(input.value).toBe('old')
  })
  it('respects readonly state on a shadow host before editing',async()=>{
    const {host,input,ctx,elementRef}=await fixture();host.setAttribute('aria-readonly','true')
    await expect(runAction('browser_type',{elementRef,text:'changed'},ctx)).rejects.toMatchObject({code:'field-readonly'})
    expect(input.value).toBe('old')
  })
  it('stops after an input handler locks the component',async()=>{
    const {host,input,ctx,elementRef}=await fixture(),changed=vi.fn();input.addEventListener('input',()=>host.setAttribute('aria-readonly','true'));input.addEventListener('change',changed)
    const result=await runAction('browser_type',{elementRef,text:'changed'},ctx)
    expect(changed).not.toHaveBeenCalled();expect(result.feedback?.state).toBe('readback-unconfirmed')
  })
  it('rejects the old reference when the same node moves to another shadow root',async()=>{
    const {input,ctx,elementRef}=await fixture();const other=component();other.shadow.replaceChildren(input)
    await expect(runAction('browser_type',{elementRef,text:'changed'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(input.value).toBe('old')
  })
  it('invalidates the old reference when a host is replaced',async()=>{
    const {host,ctx,elementRef}=await fixture();host.replaceWith(document.createElement('div'))
    await expect(runAction('browser_type',{elementRef,text:'changed'},ctx)).rejects.toMatchObject({code:'element-stale'})
  })
  it('honors an inert assigned slot without duplicating the light-DOM control',async()=>{
    const {host,shadow}=component('<slot inert></slot>');const input=document.createElement('input');host.append(input)
    const ids=new ElementIds(),ctx={ids,budget},view=await runAction('browser_snapshot',{},ctx)
    expect(view.text).toContain('disabled');expect(collectInteractive(document).filter(el=>el===input)).toHaveLength(1)
    await expect(runAction('browser_type',{elementRef:observedRef(view,ids,input),text:'changed'},ctx)).rejects.toMatchObject({code:'element-stale'})
    expect(shadow.querySelector('slot')).not.toBeNull()
  })
  it('masks shadow passwords and redacts their copies in document text',async()=>{
    const secret='synthetic-shadow-secret';const {shadow}=component('<input type="password" aria-label="Password">');shadow.querySelector('input')!.value=secret
    const text=document.createElement('p');text.textContent='Mirror: '+secret;document.body.append(text)
    const result=await runAction('browser_snapshot',{},{ids:new ElementIds(),budget})
    expect(result.text).not.toContain(secret);expect(result.text).toContain('••••');expect(pageText(text)).not.toContain(secret)
  })
  it('reports traversal limits and withholds text when uninspected roots could hold sensitive values',async()=>{
    for(let i=0;i<65;i++)component('<input type="password" value="synthetic-late-secret">')
    const text=document.createElement('p');text.textContent='synthetic-late-secret';document.body.append(text)
    const result=await runAction('browser_snapshot',{},{ids:new ElementIds(),budget})
    expect(result.text).toContain('traversal limit');expect(result.text).not.toContain('synthetic-late-secret')
  })
  it('keeps rich-text editing inside shadow roots explicitly unsupported before focus or writes',async()=>{
    const {shadow}=component('<div contenteditable="true" role="textbox" aria-label="Editor">old</div>');const editor=shadow.querySelector<HTMLElement>('div')!,focus=vi.spyOn(editor,'focus')
    const ids=new ElementIds(),ctx={ids,budget},view=await runAction('browser_snapshot',{},ctx)
    await expect(runAction('browser_type',{elementRef:observedRef(view,ids,editor),text:'changed'},ctx)).rejects.toThrow('shadow')
    expect(focus).not.toHaveBeenCalled();expect(editor.textContent).toBe('old')
  })
  it('delivers native input notifications through the host and keys to the focused internal input',async()=>{
    const {host,input,ctx,elementRef}=await fixture(),notified=vi.fn(),key=vi.fn((event:Event)=>event.target)
    host.addEventListener('input',notified);input.addEventListener('keydown',key)
    await runAction('browser_type',{elementRef,text:'accepted',replace:true},ctx)
    expect(notified).toHaveBeenCalled();input.focus()
    await runAction('browser_press',{key:'ArrowDown'},ctx)
    expect(key).toHaveBeenCalledOnce();expect(key.mock.results[0]!.value).toBe(input)
  })
  it('does not authorize a shadow control whose reference line was clipped',async()=>{
    const {input,ctx}=await fixture();const clipped={...ctx,budget:{...budget,maxChars:500}}
    const view=await runAction('browser_snapshot',{},clipped)
    const id=/Observation: (obs_[a-f0-9-]+)/.exec(view.text)![1]
    const elementRef=id+':'+ctx.ids.indexOf(input)
    expect(ctx.ids.resolveReference(elementRef)).toBeUndefined()
    await expect(runAction('browser_type',{elementRef,text:'changed'},clipped)).rejects.toMatchObject({code:'element-stale'})
    expect(input.value).toBe('old')
  })
  it('does not send keys to an unobserved shadow control merely because it has focus',async()=>{
    const {shadow}=component(),input=shadow.querySelector('input')!,key=vi.fn();input.focus();input.addEventListener('keydown',key)
    await expect(runAction('browser_press',{key:'Enter'},{ids:new ElementIds(),budget})).rejects.toMatchObject({code:'element-stale'})
    expect(key).not.toHaveBeenCalled()
  })
})
