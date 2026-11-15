// Real isolated Host/Chrome; scripted PTC by default, optional saved default model.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,chmod,rm} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {createServer} from 'node:net'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {createHash} from 'node:crypto'
import {startDshBackend} from '../benchmark/lib/dsh-process.mjs'
import {startExtensionBrowser} from '../benchmark/lib/extension-browser.mjs'
import {within} from '../benchmark/lib/extension-connection.mjs'
import {parseMarkedModelReport} from '../benchmark/lib/model-report.mjs'
import {SCROLL_CASES,startScrollSite} from './fixtures/scroll-site.mjs'

const repo=resolve(import.meta.dirname,'..'),require=createRequire(join(repo,'package.json'))
const bridgeRequire=createRequire(join(repo,'packages/browser/bridge-browser/package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const root=await mkdtemp(join(tmpdir(),'stride-nested-scroll-')),home=join(root,'home')
const version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version,realModel=process.env.STRIDE_REAL_MODEL==='1'
const cases=realModel?SCROLL_CASES.filter(kind=>kind!=='viewport'):SCROLL_CASES
const base=join(repo,'.stride-private/validation/nested-scroll',version),label=realModel?'real-model':'scripted'
await mkdir(base,{recursive:true});const artifacts=await mkdtemp(join(base,label+'-'))
await writeFile(join(base,label+'.json'),JSON.stringify({passed:false,status:'in-progress',evidenceDirectory:artifacts.slice(base.length+1)})+'\n',{mode:0o600})
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
const summaries=[],programs={}
const findRef=String.raw`function ref(view,label){const line=view.text.split('\n').find(line=>line.includes(label));const value=line?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];if(!value)throw Error('Missing observed '+label);return value;}`
for(const kind of cases){
  const negative=['inner-rollback','inner-replace'].includes(kind)
  const args=kind==='viewport'?{direction:'down',amount:120}:kind==='inner-bottom'?{direction:'bottom'}:{direction:'down',amount:120}
  programs[kind]=findRef+`const before=await tools.browser_snapshot({});console.log(await tools.browser_scroll({...${JSON.stringify(args)},${kind==='viewport'?'':"elementRef:ref(before,'button \"List item\"')"}}));
${negative?`const after=await tools.browser_snapshot({});let blocked=false;try{await tools.browser_click({elementRef:ref(after,'button "Save"')})}catch{blocked=true}if(!blocked)throw Error('Save admitted after unconfirmed scroll');`:''}
console.log(await tools.browser_snapshot({}));console.log('SCROLL_PROGRAM_OK');`
}
let host,browser,site,sessionId,phase='setup',events=[],cancelTimer
async function wait(check,label){const until=Date.now()+15000;while(Date.now()<until){if(await check())return;await delay(100)}throw Error('Scroll fixture timed out: '+label)}
async function rpc(method,payload){return browser.panel.evaluate(({method,payload})=>new Promise((done,fail)=>{
 const port=window.__scrollFixturePort??=chrome.runtime.connect({name:'dsh-panel'}),id=crypto.randomUUID()
 const timer=setTimeout(()=>{port.onMessage.removeListener(receive);fail(Error('Fixture RPC timeout'))},10000)
 function receive(message){if(message.type!=='rpc.result'||message.id!==id)return;clearTimeout(timer);port.onMessage.removeListener(receive);if(!message.ok||!message.result?.result?.ok)fail(Error('Fixture RPC rejected'));else done(message.result.result.value)}
 port.onMessage.addListener(receive);port.postMessage({type:'rpc',id,method,payload})
}),{method,payload})}
try{
  await mkdir(home);site=await startScrollSite()
  const install=spawn(process.execPath,[cli,'plugin','--profile','web','add','-w','@eilyeee/dsh-browser-stride@link:'+join(repo,'packages/browser/bridge-browser')],{cwd:repo,env,stdio:'ignore'})
  const timer=setTimeout(()=>install.kill('SIGKILL'),120000);try{assert.equal((await once(install,'exit'))[0],0)}finally{clearTimeout(timer)}
  if(realModel){
    if(!process.env.STRIDE_MODEL_CREDENTIALS||!process.env.STRIDE_MODEL_PATCH)throw Error('Private default model credentials/config paths required')
    await copyFile(process.env.STRIDE_MODEL_CREDENTIALS,join(home,'.credentials.yaml'));await chmod(join(home,'.credentials.yaml'),0o600)
  }
  const fixture=join(root,'adapter.mjs')
  await writeFile(fixture,`import {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
const programs=${JSON.stringify(programs)};
class Scripted extends LlmAdapter{
async listModels(provider){return [{provider,id:'nested-scroll',name:'Synthetic nested scroll',contextWindow:128000}]}
async *stream(options){const messages=options.messages,texts=messages.map(m=>m.content?.filter(b=>b.type==='text').map(b=>b.text).join(' ')||'');
 const index=texts.findLastIndex((t,i)=>messages[i].role==='user'&&t.startsWith('SCROLL_CASE=')),kind=texts[index]?.slice(12);
 if(!programs[kind])throw Error('No synthetic scroll case');const done=messages.slice(index+1).some(m=>m.role==='tool');
 const block=done?{type:'text',text:'SCROLL_DONE'}:{type:'tool-call',id:'scroll-'+kind,name:'run_code',arguments:JSON.stringify({code:programs[kind],description:'Scroll the observed container and verify its position'})};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents'];export function apply(ctx){${realModel?'':"ctx.on('agent/created',({agent})=>{agent.ctx.effect(()=>agent.ctx.tools.presentAs('ptc'))});ctx.effect(()=>ctx.llm.registerAdapter(['stride-nested-scroll'],new Scripted()));"}
 let requests=0,calls=0;ctx.on('session/event',(_s,e)=>{if(e.type==='turn/start'){requests=0;calls=0}});
 ctx.on('agent/request',(_p,next)=>{if(++requests>10)throw Error('Synthetic request budget');return next()});
 ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_snapshot','browser_scroll','browser_click','browser_get_text','browser_wait','browser_list_tabs'].includes(exec.name)?'Only synthetic scroll tools are allowed':exec.name.startsWith('browser_')&&++calls>20?'Synthetic browser budget exhausted':undefined));
}`,{mode:0o600})
  process.env.DSH_HOME=home;for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete process.env[key]
  const net=createServer();await new Promise(done=>net.listen(0,'127.0.0.1',done));const port=net.address().port;await new Promise(done=>net.close(done))
  const patch=realModel?await readFile(process.env.STRIDE_MODEL_PATCH,'utf8'):''
  host=await startDshBackend({backend:'extension',port,repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:site.url('inner-down'),deferSessionCreate:true,extraPatch:patch+'\n- insert:\n    - id: nested-scroll-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n'})
  browser=await startExtensionBrowser({repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),bridgeUrl:`ws://127.0.0.1:${port}/ext/bridge`,issuePairingCode:()=>host.issuePairingCode(),trustedOrigin:site.origin})
  await wait(async()=>typeof (await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity))?.focusedSessionId==='string','panel Session')
  sessionId=await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity.focusedSessionId)
  await rpc('bridge.taskBrief.save',{sessionId,version:0,input:{goal:'Synthetic nested scroll',projectPath:'',materials:[],criteria:[]}})
  if(!realModel)await rpc('session.selectModel',{sessionId,provider:'stride-nested-scroll',model:'nested-scroll'})
  for(const kind of cases){
    phase=kind;events=[];console.log(JSON.stringify({phase,realModel}))
    await browser.prepare(site.url(kind));await browser.bindSession(sessionId);await browser.panel.bringToFront();await host.client.followSession(sessionId)
    let started=false,finish;const done=new Promise(resolve=>{finish=resolve})
    const off=host.client.onFrame(frame=>{
      if(frame.type!=='session/event'||frame.sessionId!==sessionId)return
      const e=frame.event?.event??frame.event;if(e.type==='turn/start')started=true;if(!started)return;events.push(e)
      if(e.type==='turn/end')finish(e.data.reason.kind)
    })
    try{
      const negative=['inner-rollback','inner-replace'].includes(kind)
      const task=kind==='viewport'?'不指定 elementRef，将整个窗口向下滚动 120px。':kind==='inner-bottom'?'使用 List item 的当前控件引用，将其最近滚动容器滚到最底部。':`使用 List item 的当前控件引用，将其最近滚动容器向下滚动 120px。`
      const prompt=realModel?`仅操作当前已授权本地合成页。${task}只调用一次 browser_scroll，不点击按钮或保存，不改源码，不滚动其他容器。以工具回读和新观察核对位置；目标或回读未确认时停止并报告，不重试。最后返回 JSON：{"marker":"SCROLL_MODEL_DONE","goalReached":true或false,"reason":"实际回读依据"}。`:'SCROLL_CASE='+kind
      cancelTimer=setTimeout(()=>{void host.client.rpc('session.cancel',{sessionId}).catch(()=>{});finish('test-timeout')},realModel?240000:45000)
      const input=browser.panel.locator('.composer textarea');await input.fill(prompt);await input.press('Enter')
      const reason=await within(done,realModel?245000:50000,'scroll turn')
      await writeFile(join(artifacts,kind+'-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600});assert.equal(reason,'completed')
      const calls=events.filter(e=>e.type==='tool/ptc-dispatch'||(e.type==='tool/call'&&e.data.name?.startsWith('browser_'))).map(e=>e.data)
      const scrolls=calls.filter(c=>c.name==='browser_scroll');assert.equal(scrolls.length,1)
      const scrollArgs=typeof scrolls[0].arguments==='string'?JSON.parse(scrolls[0].arguments):scrolls[0].arguments??scrolls[0].args
      assert.equal(scrollArgs?.elementRef!==undefined,kind!=='viewport')
      const feedback=events.filter(e=>['tool/ptc-dispatch','tool/result'].includes(e.type)).map(e=>e.data.meta?.browserFeedback).filter(Boolean)
      assert.ok(feedback.some(f=>f.state===(negative?'readback-unconfirmed':kind==='viewport'?'dispatched':'observed')))
      if(negative&&!realModel)assert.ok(feedback.some(f=>f.state==='not-applied'&&f.code==='result_unknown'),'Fresh Save reference must be refused by the Host write fence')
      assert.equal(site.state().saves.filter(row=>row.case===kind).length,0)
      const position=await browser.target.evaluate(()=>({inner:document.querySelector('#inner').scrollTop,outer:document.querySelector('#outer').scrollTop,viewport:scrollY}))
      assert.equal(position.inner,kind==='inner-bottom'||kind==='inner-boundary'?800:kind==='inner-down'?120:0)
      assert.equal(position.outer,0);assert.equal(position.viewport,kind==='viewport'?120:0)
      let report
      if(realModel){
        const final=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text)??[]).at(-1)
        report=parseMarkedModelReport(final,'SCROLL_MODEL_DONE')
        await writeFile(join(artifacts,kind+'-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
        assert.equal(report.goalReached,!negative&&kind!=='inner-boundary')
      }else{
        const root=events.find(e=>e.type==='tool/result')?.data.message
        assert.ok(root&&!root.isError&&JSON.stringify(root.content).includes('SCROLL_PROGRAM_OK'))
      }
      summaries.push({case:kind,passed:true,scrollCalls:scrolls.length,position,saveRequests:0,hostSaveFenceTested:negative&&!realModel,...report?{modelGoalReached:report.goalReached}:{}})
    }finally{clearTimeout(cancelTimer);off()}
  }
  await browser.panel.setViewportSize({width:360,height:800});assert.ok(await browser.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await browser.panel.screenshot({path:join(artifacts,'panel.png')})
  const summary={passed:true,version,scope:realModel?'container-only':'all',realHost:true,isolatedChrome:true,browserVersion:browser.browserVersion,scriptedModel:!realModel,realModel,cases:summaries,originalHostUntouched:true,evidenceDirectory:artifacts.slice(base.length+1),hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),contentBundleSha256:createHash('sha256').update(await readFile(join(repo,'extensions/dsh-browser/dist/content.js'))).digest('hex')}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary))
}catch(error){
  await writeFile(join(artifacts,'failure-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600})
  const summary={passed:false,version,phase,errorName:error.name,completedCases:summaries,evidenceDirectory:artifacts.slice(base.length+1)}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  throw error
}finally{clearTimeout(cancelTimer);if(sessionId)await host?.client.rpc('session.cancel',{sessionId}).catch(()=>{});await browser?.close().catch(()=>{});await host?.close().catch(()=>{});await site?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
