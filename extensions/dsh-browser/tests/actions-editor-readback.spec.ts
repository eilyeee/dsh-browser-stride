// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {runAction} from '../src/content/actions.ts'
import {ElementIds} from '../src/content/ids.ts'
import {observedRef} from './observed-ref.ts'

const budget={maxItems:20,maxForms:10,maxChars:4000}
function command(work?:()=>void){
  const fn=vi.fn((_name:string,_ui:boolean,text:string)=>{
    const selection=document.getSelection()!,range=selection.getRangeAt(0)
    const container=range.commonAncestorContainer
    const field=(container instanceof Element?container:container.parentElement)!.closest('[contenteditable]')!
    range.deleteContents();range.insertNode(document.createTextNode(text))
    field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));work?.();return true
  })
  Object.defineProperty(document,'execCommand',{configurable:true,value:fn});return fn
}
async function fixture(text='old'){
  document.body.innerHTML='<div contenteditable="true" role="textbox" tabindex="0" aria-label="Editor"></div>'
  const editor=document.querySelector<HTMLElement>('div')!,ids=new ElementIds();editor.textContent=text
  const snapshot=await runAction('browser_snapshot',{},{ids,budget})
  return {editor,ctx:{ids,budget},elementRef:observedRef(snapshot,ids,editor)}
}
afterEach(()=>{document.body.replaceChildren();Reflect.deleteProperty(document,'execCommand');vi.restoreAllMocks()})

describe('editor input readback and rejection',()=>{
  it.each(['sync','microtask','timer'])('does not confirm text rolled back by %s reconciliation',async stage=>{
    const {editor,ctx,elementRef}=await fixture();command()
    editor.addEventListener('input',()=>{
      const rollback=()=>{editor.textContent='old'}
      if(stage==='sync')rollback();else if(stage==='microtask')queueMicrotask(rollback);else setTimeout(rollback,0)
    })
    const result=await runAction('browser_type',{elementRef,text:'new',replace:true},ctx)
    expect(editor.textContent).toBe('old')
    expect(result.feedback).toMatchObject({state:'readback-unconfirmed',businessChange:'not-verified'})
  })
  it('does not replace text after a cancelled beforeinput',async()=>{
    const {editor,ctx,elementRef}=await fixture();const fn=command(),input=vi.fn()
    editor.addEventListener('beforeinput',event=>event.preventDefault());editor.addEventListener('input',input)
    const result=await runAction('browser_type',{elementRef,text:'new',replace:true},ctx)
    expect(editor.textContent).toBe('old');expect(input).not.toHaveBeenCalled();expect(fn).not.toHaveBeenCalled()
    expect(result.feedback).toMatchObject({state:'readback-unconfirmed'})
  })
  it('also honours beforeinput cancellation when the command is absent',async()=>{
    const {editor,ctx,elementRef}=await fixture();editor.addEventListener('beforeinput',event=>event.preventDefault())
    const result=await runAction('browser_type',{elementRef,text:'new',replace:true},ctx)
    expect(editor.textContent).toBe('old');expect(result.feedback).toMatchObject({state:'readback-unconfirmed'})
  })
  it('never appends a second time after a command throws following a partial edit',async()=>{
    const {editor,ctx,elementRef}=await fixture();const fn=command(()=>{throw Error('Synthetic failure after input')})
    const result=await runAction('browser_type',{elementRef,text:' more'},ctx)
    expect(editor.textContent).toBe('old more');expect(fn).toHaveBeenCalledOnce()
    expect(result.feedback).toMatchObject({state:'readback-unconfirmed'})
  })
  it('stops if focus disables content editing before the command',async()=>{
    const {editor,ctx,elementRef}=await fixture();const fn=command()
    editor.addEventListener('focus',()=>editor.setAttribute('contenteditable','false'))
    const result=await runAction('browser_type',{elementRef,text:'new',replace:true},ctx)
    expect(fn).not.toHaveBeenCalled();expect(editor.textContent).toBe('old')
    expect(result.feedback).toMatchObject({state:'readback-unconfirmed'})
  })
  it('does not dispatch the command when beforeinput moves the selection to another editor',async()=>{
    const {editor,ctx,elementRef}=await fixture();const other=document.createElement('div');other.contentEditable='true';other.tabIndex=0;other.textContent='untouched';document.body.append(other)
    const fn=command();editor.addEventListener('beforeinput',()=>{
      other.focus();const range=document.createRange();range.selectNodeContents(other);document.getSelection()!.removeAllRanges();document.getSelection()!.addRange(range)
    })
    const result=await runAction('browser_type',{elementRef,text:'new',replace:true},ctx)
    expect(fn).not.toHaveBeenCalled();expect(editor.textContent).toBe('old');expect(other.textContent).toBe('untouched')
    expect(result.feedback).toMatchObject({state:'readback-unconfirmed'})
  })
  it.each([true,false])('confirms accepted plain text when replace=%s, allowing markup-only reconciliation',async replace=>{
    const {editor,ctx,elementRef}=await fixture();command()
    editor.addEventListener('input',()=>{const text=editor.textContent;editor.replaceChildren(Object.assign(document.createElement('strong'),{textContent:text}))})
    const result=await runAction('browser_type',{elementRef,text:'new',replace},ctx)
    expect(editor.textContent).toBe(replace?'new':'oldnew')
    expect(result.feedback).toMatchObject({state:'observed',businessChange:'not-verified'})
  })
  it('verifies the direct-write path only when the editing command is absent',async()=>{
    const {editor,ctx,elementRef}=await fixture()
    const result=await runAction('browser_type',{elementRef,text:'plain',replace:true},ctx)
    expect(editor.textContent).toBe('plain');expect(result.feedback).toMatchObject({state:'observed'})
  })
  it('keeps a native input inside an editable region on the native value path',async()=>{
    const {editor,ctx}=await fixture();const input=document.createElement('input');input.setAttribute('aria-label','Nested field')
    Object.defineProperty(input,'isContentEditable',{value:true});editor.append(input);const fn=command()
    const snapshot=await runAction('browser_snapshot',{},ctx)
    const result=await runAction('browser_type',{elementRef:observedRef(snapshot,ctx.ids,input),text:'native',replace:true},ctx)
    expect(input.value).toBe('native');expect(fn).not.toHaveBeenCalled();expect(result.feedback).toMatchObject({state:'observed'})
  })
  it.each(['line\r\nnext','two  spaces'])('compares normalized rendered plain text: %j',async text=>{
    const {editor,ctx,elementRef}=await fixture();command()
    editor.addEventListener('input',()=>{editor.textContent=editor.textContent!.replaceAll(' ','\u00a0')})
    const result=await runAction('browser_type',{elementRef,text,replace:true},ctx)
    expect(result.feedback).toMatchObject({state:'observed',businessChange:'not-verified'})
  })
})
