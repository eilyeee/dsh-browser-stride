import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {COMPONENT_READ_CASES,COMPONENT_SETTLE_CASES,COMPONENT_READ_SECRETS,startComponentReadSite} from '../fixtures/component-read-site.mjs'
import {SHADOW_CASES,SHADOW_SYNTHETIC_SECRETS,startShadowSite} from '../fixtures/shadow-site.mjs'

const require=createRequire(new URL('../../extensions/dsh-browser/package.json',import.meta.url))
const {JSDOM,VirtualConsole}=require('jsdom')
async function page(site,kind){
  const url=site.url(kind),html=await fetch(url).then(response=>response.text()),errors=[]
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message))
  // Only locally generated synthetic fixture code executes here, never user pages.
  const dom=new JSDOM(html,{url,runScripts:'dangerously',pretendToBeVisual:true,virtualConsole})
  assert.deepEqual(errors,[],`Fixture ${kind} must execute without setup errors`)
  return dom
}

test('readonly component fixtures mount their scenario data before declaring readiness',async()=>{
  const site=await startComponentReadSite()
  try{for(const kind of COMPONENT_READ_CASES){
    const dom=await page(site,kind)
    try{
      const w=dom.window;assert.equal(w.componentReadFixtureReady,true);assert.ok(w.readRoot.querySelector('[aria-label="Anchor"]'))
      if(kind==='privacy')assert.deepEqual([w.readRoot.querySelector('[type="password"]').value,w.readRoot.querySelector('#code').value],COMPONENT_READ_SECRETS)
      if(kind==='recovery')assert.equal(w.readRoot.querySelectorAll('.duplicate').length,2)
      if(kind==='slots'){assert.equal(w.readRoot.querySelector('[name="note"]').assignedNodes().length,1);assert.equal(w.readRoot.host.querySelector('[slot="note"]').textContent,'Assigned visible note')}
      assert.equal(w.pageWrites,0)
    }finally{dom.window.close()}
  }}finally{await site.close()}
})

test('native shadow fixtures really mount sensitive values and their document mirrors',async()=>{
  const site=await startShadowSite()
  try{for(const kind of SHADOW_CASES){
    const dom=await page(site,kind)
    try{
      const w=dom.window;assert.equal(w.shadowFixtureReady,true);assert.ok(w.currentComponent.root)
      if(kind==='privacy'){
        assert.deepEqual([w.currentComponent.root.querySelector('[type="password"]').value,w.currentComponent.root.querySelector('#code').value],SHADOW_SYNTHETIC_SECRETS)
        for(const secret of SHADOW_SYNTHETIC_SECRETS)assert.ok(w.document.querySelector('#mirror').textContent.includes(secret))
      }
    }finally{dom.window.close()}
  }}finally{await site.close()}
})

for(const kind of COMPONENT_SETTLE_CASES)test(`component settle fixture initializes and runs: ${kind}`,async()=>{
  const site=await startComponentReadSite();let dom
  try{
    dom=await page(site,kind);const w=dom.window
    assert.equal(w.componentReadFixtureReady,true);assert.equal(w.componentStarts,0)
    assert.equal(w.readRoot.querySelector('[aria-label="State"]').value,'INITIAL')
    w.readRoot.querySelector('#start').click();assert.equal(w.componentStarts,1)
    await new Promise(done=>setTimeout(done,kind==='settle-continuous'?70:190))
    assert.ok(w.componentTicks>0);assert.equal(w.componentFinished,kind!=='settle-continuous')
    if(kind==='settle-late-root')assert.equal(w.readRoot.querySelector('#late').shadowRoot.querySelector('p').textContent,'Component ready: 24px')
    if(kind!=='settle-continuous')assert.equal(w.readRoot.querySelector('[aria-label="State"]').value,'COMPONENT_READY')
    assert.equal(w.pageWrites,0);assert.equal(site.state().writes,0)
  }finally{dom?.window.close();await site.close()}
})
