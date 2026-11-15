// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {runAction} from '../src/content/actions.ts'
import {ElementIds} from '../src/content/ids.ts'
import {observedRef} from './observed-ref.ts'

const budget={maxItems:30,maxForms:20,maxChars:12000}
async function fixture(html='<p id="requirements">Keep the customer spacing.</p><input aria-label="Anchor">'){
  document.body.innerHTML='<p id="requirements">Wrong document copy</p><div id="host"></div>'
  const host=document.querySelector('#host')!,root=host.attachShadow({mode:'open'});root.innerHTML=html
  const anchor=root.querySelector('input')!,ids=new ElementIds(),ctx={ids,budget}
  const view=await runAction('browser_snapshot',{},ctx)
  return {host,root,anchor,ctx,elementRef:observedRef(view,ids,anchor)}
}
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks()})

describe('observed component read scopes',()=>{
  it('reads the observed component root instead of the document copy',async()=>{
    const {ctx,elementRef}=await fixture()
    const result=await runAction('browser_get_text',{elementRef,selector:'#requirements'},ctx)
    expect(result.text).toContain('Keep the customer spacing.');expect(result.text).not.toContain('Wrong document copy')
  })
  it('reads nested open-root prose in rendered DOM order',async()=>{
    const {root,ctx,elementRef}=await fixture('<p>First <span>inline</span> text</p><div id="nested"></div><input aria-label="Anchor">')
    root.querySelector('#nested')!.attachShadow({mode:'open'}).innerHTML='<p>Nested note</p>'
    const result=await runAction('browser_get_text',{elementRef},ctx)
    expect(result.text).toContain('First inline text');expect(result.text).toContain('Nested note')
  })
  it('includes assigned slots once, uses empty-slot fallback and excludes unassigned light content',async()=>{
    const {host,ctx,elementRef}=await fixture('<slot name="note">Unused fallback</slot><slot name="empty">Default note</slot><input aria-label="Anchor">')
    host.innerHTML='<span slot="note">Assigned note</span><p>Unassigned note</p>'
    const result=await runAction('browser_get_text',{elementRef},ctx)
    expect(result.text.match(/Assigned note/g)).toHaveLength(1);expect(result.text).toContain('Default note')
    expect(result.text).not.toContain('Unused fallback');expect(result.text).not.toContain('Unassigned note')
  })
  it('excludes scripts, styles, hidden prose and native field values',async()=>{
    const {ctx,elementRef}=await fixture('<p>Visible</p><p style="display:none">Hidden</p><p style="opacity:0">Faded</p><script>script-source</script><style>style-source</style><input aria-label="Anchor" value="field-value"><textarea>textarea-value</textarea>')
    const result=await runAction('browser_get_text',{elementRef},ctx)
    expect(result.text).toContain('Visible');for(const word of ['Hidden','Faded','script-source','style-source','field-value','textarea-value'])expect(result.text).not.toContain(word)
  })
  it('redacts a sensitive mirror split across inline nodes',async()=>{
    const {root,ctx,elementRef}=await fixture('<input aria-label="Anchor"><input type="password"><p>synthetic-<span>component-secret</span></p>')
    root.querySelector<HTMLInputElement>('[type="password"]')!.value='synthetic-component-secret'
    const result=await runAction('browser_get_text',{elementRef},ctx)
    expect(result.text).not.toContain('synthetic-component-secret');expect(result.text).toContain('••••')
  })
  it('withholds a selected fragment of a sensitive editable',async()=>{
    const {ctx,elementRef}=await fixture('<input aria-label="Anchor"><div contenteditable="true" aria-label="Verification code"><span id="part">partial</span> code</div>')
    const result=await runAction('browser_get_text',{elementRef,selector:'#part'},ctx)
    expect(result.text).not.toContain('partial');expect(result.text).toContain('••••')
  })
  it.each(['.missing','.duplicate','['])('refuses a missing, ambiguous or malformed scoped selector: %s',async selector=>{
    const {ctx,elementRef}=await fixture('<input aria-label="Anchor"><p class="duplicate">One</p><p class="duplicate">Two</p>')
    await expect(runAction('browser_get_text',{elementRef,selector},ctx)).rejects.toThrow()
  })
  it('allows a disabled observed control to anchor a read, while still refusing writes',async()=>{
    const {anchor,ctx}=await fixture();anchor.disabled=true;const view=await runAction('browser_snapshot',{},ctx),elementRef=observedRef(view,ctx.ids,anchor)
    expect((await runAction('browser_get_text',{elementRef},ctx)).text).toContain('Keep the customer spacing.')
    await expect(runAction('browser_type',{elementRef,text:'no'},ctx)).rejects.toMatchObject({code:'element-stale'})
  })
  it.each(['browser_get_text','browser_measure_layout'])('rejects a stale observation before %s',async name=>{
    const {ctx,elementRef}=await fixture();await runAction('browser_snapshot',{},ctx)
    await expect(runAction(name,{elementRef,selector:'#requirements'},ctx)).rejects.toMatchObject({code:'element-stale'})
  })
  it.each(['browser_get_text','browser_measure_layout'])('rejects a moved component anchor before %s',async name=>{
    const {anchor,ctx,elementRef}=await fixture();const other=document.createElement('div');document.body.append(other);other.attachShadow({mode:'open'}).append(anchor)
    await expect(runAction(name,{elementRef,selector:'#requirements'},ctx)).rejects.toMatchObject({code:'element-stale'})
  })
  it('measures unique boxes in the anchor tree, retaining the original viewport coordinates',async()=>{
    const {root,ctx,elementRef}=await fixture('<div id="header"></div><div id="customer" style="margin-top:24px"></div><input aria-label="Anchor">')
    for(const [id,top] of [['header',10],['customer',54]] as const){const el=root.querySelector('#'+id)!,rect=new DOMRect(10,top,200,20);vi.spyOn(el,'getBoundingClientRect').mockReturnValue(rect);vi.spyOn(el,'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)}
    const result=await runAction('browser_measure_layout',{elementRef,selector:'#customer',referenceSelector:'#header'},ctx),report=JSON.parse(result.text)
    expect(report.scope).toBe('open-shadow-root');expect(report.target.css.margin.top).toBe('24px');expect(report.comparison.verticalGap).toBe(24)
  })
  it('withholds all scoped text at traversal or character limits rather than returning sensitive prefixes',async()=>{
    const {root,ctx,elementRef}=await fixture();root.querySelector('p')!.textContent='synthetic-prefix'.repeat(20000)
    expect((await runAction('browser_get_text',{elementRef},ctx)).text).toContain('withheld')
    root.querySelector('p')!.textContent='Public';for(let i=0;i<65;i++){const host=document.createElement('div');root.append(host);host.attachShadow({mode:'open'}).innerHTML='<p>Extra</p>'}
    expect((await runAction('browser_get_text',{elementRef},ctx)).text).toContain('withheld')
  })
  it('preserves legacy document reads and does not mint another observation, focus, scroll or write',async()=>{
    const {anchor,ctx,elementRef}=await fixture();const focus=vi.spyOn(anchor,'focus'),before=document.body.innerHTML
    expect((await runAction('browser_get_text',{selector:'#requirements'},ctx)).text).toBe('Wrong document copy')
    await runAction('browser_get_text',{elementRef},ctx)
    expect(ctx.ids.resolveReference(elementRef)).toBeDefined();expect(focus).not.toHaveBeenCalled();expect(document.body.innerHTML).toBe(before)
  })
})
