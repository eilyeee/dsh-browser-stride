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
import {SHADOW_CASES,SHADOW_SYNTHETIC_SECRETS,startShadowSite} from './fixtures/shadow-site.mjs'

const repo=resolve(import.meta.dirname,'..'),require=createRequire(join(repo,'package.json'))
const bridgeRequire=createRequire(join(repo,'packages/browser/bridge-browser/package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const root=await mkdtemp(join(tmpdir(),'stride-shadow-controls-')),home=join(root,'home')
const version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version,realModel=process.env.STRIDE_REAL_MODEL==='1'
const privacyOnly=process.argv.includes('--privacy-only')
const cases=privacyOnly?['privacy']:SHADOW_CASES
const base=join(repo,'.stride-private/validation/shadow-controls',version),label=(realModel?'real-model':'scripted')+(privacyOnly?'-privacy':'')
await mkdir(base,{recursive:true});const artifacts=await mkdtemp(join(base,label+'-'))
await writeFile(join(base,label+'.json'),JSON.stringify({passed:false,status:'in-progress',evidenceDirectory:artifacts.slice(base.length+1)})+'\n',{mode:0o600})
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
const summaries=[],programs={}
const findRef=String.raw`function ref(view,label){const line=view.text.split('\n').find(line=>line.includes(label));const value=line?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];if(!value)throw Error('Missing observed '+label);return value;}`
for(const kind of cases){
  const start=`const before=await tools.browser_snapshot({});console.log(before);`
  const finish=`console.log(await tools.browser_snapshot({}));console.log('SHADOW_PROGRAM_OK');`
  if(kind==='privacy'){programs[kind]=start+`console.log(await tools.browser_get_text({}));`+finish;continue}
  if(kind==='scroll'){programs[kind]=findRef+start+`console.log(await tools.browser_scroll({elementRef:ref(before,'button "Row"'),direction:'down',amount:120}));`+finish;continue}
  let code=start
  if(kind==='readonly')code+=`let refused=false;try{await tools.browser_type({elementRef:ref(before,'input "Name"'),text:'accepted',replace:true})}catch{refused=true}if(!refused)throw Error('Readonly component was edited');const note=await tools.browser_snapshot({});await tools.browser_type({elementRef:ref(note,'input "Note"'),text:'accepted',replace:true});const save=await tools.browser_snapshot({});await tools.browser_click({elementRef:ref(save,'button "Save note"')});`
  else{
    code+=`console.log(await tools.browser_type({elementRef:ref(before,'input "Name"'),text:'accepted',replace:true}));`
    if(['replace','retarget'].includes(kind))code+=`const after=await tools.browser_snapshot({});let blocked=false;try{await tools.browser_click({elementRef:ref(after,'button "Save note"')})}catch{blocked=true}if(!blocked)throw Error('Save admitted after changed component');`
    else code+=`let view=await tools.browser_snapshot({});await tools.browser_select({elementRef:ref(view,'select "Size"'),optionIndex:1});view=await tools.browser_snapshot({});await tools.browser_click({elementRef:ref(view,'checkbox "Enabled"')});view=await tools.browser_snapshot({});await tools.browser_click({elementRef:ref(view,'button "Save component"')});`
  }
  programs[kind]=findRef+code+finish
}
let host,browser,site,sessionId,phase='setup',events=[],cancelTimer
async function wait(check,label){const until=Date.now()+15000;while(Date.now()<until){if(await check())return;await delay(100)}throw Error('Shadow fixture timed out: '+label)}
async function rpc(method,payload){return browser.panel.evaluate(({method,payload})=>new Promise((done,fail)=>{
 const port=window.__shadowFixturePort??=chrome.runtime.connect({name:'dsh-panel'}),id=crypto.randomUUID()
 const timer=setTimeout(()=>{port.onMessage.removeListener(receive);fail(Error('Fixture RPC timeout'))},10000)
 function receive(message){if(message.type!=='rpc.result'||message.id!==id)return;clearTimeout(timer);port.onMessage.removeListener(receive);if(!message.ok||!message.result?.result?.ok)fail(Error('Fixture RPC rejected'));else done(message.result.result.value)}
 port.onMessage.addListener(receive);port.postMessage({type:'rpc',id,method,payload})
}),{method,payload})}
try{
  await mkdir(home);site=await startShadowSite()
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
async listModels(provider){return [{provider,id:'shadow-controls',name:'Synthetic shadow controls',contextWindow:128000}]}
async *stream(options){const messages=options.messages,texts=messages.map(m=>m.content?.filter(b=>b.type==='text').map(b=>b.text).join(' ')||'');
 const index=texts.findLastIndex((t,i)=>messages[i].role==='user'&&t.startsWith('SHADOW_CASE=')),kind=texts[index]?.slice(12);
 if(!programs[kind])throw Error('No synthetic shadow case');const done=messages.slice(index+1).some(m=>m.role==='tool');
 const block=done?{type:'text',text:'SHADOW_DONE'}:{type:'tool-call',id:'shadow-'+kind,name:'run_code',arguments:JSON.stringify({code:programs[kind],description:'Observe native component controls and verify their results'})};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents'];export function apply(ctx){${realModel?'':"ctx.on('agent/created',({agent})=>{agent.ctx.effect(()=>agent.ctx.tools.presentAs('ptc'))});ctx.effect(()=>ctx.llm.registerAdapter(['stride-shadow-controls'],new Scripted()));"}
 let requests=0,calls=0;ctx.on('session/event',(_s,e)=>{if(e.type==='turn/start'){requests=0;calls=0}});
 ctx.on('agent/request',(_p,next)=>{if(++requests>20)throw Error('Synthetic request budget');return next()});
 ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_snapshot','browser_scroll','browser_type','browser_select','browser_click','browser_get_text','browser_wait','browser_list_tabs'].includes(exec.name)?'Only synthetic shadow tools are allowed':exec.name.startsWith('browser_')&&++calls>20?'Synthetic browser budget exhausted':undefined));
}`,{mode:0o600})
  process.env.DSH_HOME=home;for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete process.env[key]
  const net=createServer();await new Promise(done=>net.listen(0,'127.0.0.1',done));const port=net.address().port;await new Promise(done=>net.close(done))
  const patch=realModel?await readFile(process.env.STRIDE_MODEL_PATCH,'utf8'):''
  host=await startDshBackend({backend:'extension',port,repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:site.url('native'),deferSessionCreate:true,extraPatch:patch+'\n- insert:\n    - id: shadow-controls-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n'})
  browser=await startExtensionBrowser({repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),bridgeUrl:`ws://127.0.0.1:${port}/ext/bridge`,issuePairingCode:()=>host.issuePairingCode(),trustedOrigin:site.origin})
  await wait(async()=>typeof (await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity))?.focusedSessionId==='string','panel Session')
  sessionId=await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity.focusedSessionId)
  await rpc('bridge.taskBrief.save',{sessionId,version:0,input:{goal:'Synthetic shadow controls',projectPath:'',materials:[],criteria:[]}})
  if(!realModel)await rpc('session.selectModel',{sessionId,provider:'stride-shadow-controls',model:'shadow-controls'})
  for(const kind of cases){
    phase=kind;events=[];console.log(JSON.stringify({phase,realModel}))
    await browser.prepare(site.url(kind))
    assert.equal(await browser.target.evaluate(()=>window.shadowFixtureReady),true,'Fixture setup must finish before any model turn')
    if(kind==='privacy')assert.deepEqual(await browser.target.evaluate(()=>[window.currentComponent.root.querySelector('[type="password"]').value,window.currentComponent.root.querySelector('#code').value]),SHADOW_SYNTHETIC_SECRETS)
    await browser.bindSession(sessionId);await browser.panel.bringToFront();await host.client.followSession(sessionId)
    let started=false,finish;const done=new Promise(resolve=>{finish=resolve})
    const off=host.client.onFrame(frame=>{
      if(frame.type!=='session/event'||frame.sessionId!==sessionId)return
      const e=frame.event?.event??frame.event;if(e.type==='turn/start')started=true;if(!started)return;events.push(e)
      if(e.type==='turn/end')finish(e.data.reason.kind)
    })
    try{
      const negative=['replace','retarget'].includes(kind)
      const task=kind==='privacy'?'只读快照和正文，报告 Name 的普通字段值及敏感字段已遮罩的情况，不复述敏感字段或镜像的任何内容，不输入、不点击、不保存。':kind==='scroll'?'使用 Row 当前控件引用，将其最近滚动容器向下滚动 120px，不能滚动外层或窗口，不点击保存。':kind==='readonly'?'保持只读 Name 原值，只将可写的 Note 替换为 accepted，再点击 Save note 一次，核对正文 Saved note。':'将组件 Name 替换为 accepted、Size 选择为 Large、Enabled 勾选，再点击 Save component 一次，核对正文 Saved component。'
      const prompt=realModel?`仅操作当前已授权本地合成页。当前会话已绑定测试页，从 browser_snapshot 开始，不重新绑定标签页。${task}不要修改 Outside field，不要访问闭合控件、其他网站或文件。字段编辑和滚动各只尝试一次；工具提示未确认时停止后续写入，只读核对后报告，不重试或恢复授权。最后返回 JSON：{"marker":"SHADOW_MODEL_DONE","goalReached":true或false,"reason":"实际观察依据"}。`:'SHADOW_CASE='+kind
      cancelTimer=setTimeout(()=>{void host.client.rpc('session.cancel',{sessionId}).catch(()=>{});finish('test-timeout')},realModel?240000:45000)
      const input=browser.panel.locator('.composer textarea');await input.fill(prompt);await input.press('Enter')
      const reason=await within(done,realModel?245000:50000,'shadow turn')
      await writeFile(join(artifacts,kind+'-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600});assert.equal(reason,'completed')
      const calls=events.filter(e=>e.type==='tool/ptc-dispatch'||(e.type==='tool/call'&&e.data.name?.startsWith('browser_'))).map(e=>e.data)
      const feedback=events.filter(e=>['tool/ptc-dispatch','tool/result'].includes(e.type)).map(e=>e.data.meta?.browserFeedback).filter(Boolean)
      const saves=site.state().saves.filter(row=>row.case===kind)
      assert.equal(saves.length,['native','readonly'].includes(kind)?1:0)
      assert.equal(await browser.target.evaluate(()=>document.querySelector('#field').value),'keep');assert.equal(await browser.target.evaluate(()=>window.closedClicks),0)
      if(negative){
        assert.ok(feedback.some(f=>f.state==='readback-unconfirmed'));assert.equal(calls.filter(c=>c.name==='browser_type').length,1)
        if(!realModel)assert.ok(feedback.some(f=>f.state==='not-applied'&&f.code==='result_unknown'),'Fresh Save must reach the Host write fence')
        const field=await browser.target.evaluate(()=>({value:window.currentComponent.field.value,events:window.fieldEvents}))
        assert.equal(field.value,kind==='replace'?'old':'');assert.deepEqual(field.events,{input:1,change:0})
      }else if(kind==='native'){
        assert.deepEqual(saves[0],{case:kind,mode:'component',name:'accepted',size:'Large',checked:true,note:'',outside:'keep'})
        assert.equal(calls.filter(c=>c.name==='browser_type').length,1);assert.equal(calls.filter(c=>c.name==='browser_select').length,1);assert.equal(calls.filter(c=>c.name==='browser_click').length,2)
      }else if(kind==='readonly'){
        assert.deepEqual(saves[0],{case:kind,mode:'note',name:'old',size:'Small',checked:false,note:'accepted',outside:'keep'})
        assert.deepEqual(await browser.target.evaluate(()=>window.fieldEvents),{input:0,change:0})
        if(!realModel)assert.ok(calls.some(c=>c.meta?.browserFeedback?.state==='not-applied'&&c.error?.code==='field-readonly'))
      }else if(kind==='privacy'){
        for(const secret of SHADOW_SYNTHETIC_SECRETS)assert.ok(!JSON.stringify(events).includes(secret),'Sensitive shadow values must not enter model events')
        assert.equal(calls.filter(c=>['browser_type','browser_select','browser_click','browser_scroll'].includes(c.name)).length,0)
      }else if(kind==='scroll'){
        assert.equal(calls.filter(c=>c.name==='browser_scroll').length,1)
        assert.deepEqual(await browser.target.evaluate(()=>({inner:window.currentComponent.root.querySelector('#scroller').scrollTop,outer:document.querySelector('#outer').scrollTop,viewport:scrollY})),{inner:120,outer:0,viewport:0})
      }
      let report
      if(realModel){
        const final=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text)??[]).at(-1)
        report=parseMarkedModelReport(final,'SHADOW_MODEL_DONE')
        await writeFile(join(artifacts,kind+'-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
        assert.equal(report.goalReached,!negative)
      }else{
        const root=events.find(e=>e.type==='tool/result')?.data.message
        assert.ok(root&&!root.isError&&JSON.stringify(root.content).includes('SHADOW_PROGRAM_OK'))
      }
      summaries.push({case:kind,passed:true,saveRequests:saves.length,outsideUnchanged:true,closedActionCount:0,hostSaveFenceTested:negative&&!realModel,...report?{modelGoalReached:report.goalReached}:{}})
    }finally{clearTimeout(cancelTimer);off()}
  }
  await browser.panel.setViewportSize({width:360,height:800});assert.ok(await browser.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await browser.panel.screenshot({path:join(artifacts,'panel.png')})
  const summary={passed:true,version,scope:privacyOnly?'privacy-only':'native-controls',realHost:true,isolatedChrome:true,browserVersion:browser.browserVersion,scriptedModel:!realModel,realModel,cases:summaries,originalHostUntouched:true,evidenceDirectory:artifacts.slice(base.length+1),hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),contentBundleSha256:createHash('sha256').update(await readFile(join(repo,'extensions/dsh-browser/dist/content.js'))).digest('hex')}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary))
}catch(error){
  await writeFile(join(artifacts,'failure-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600})
  const summary={passed:false,version,phase,errorName:error.name,completedCases:summaries,evidenceDirectory:artifacts.slice(base.length+1)}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  throw error
}finally{clearTimeout(cancelTimer);if(sessionId)await host?.client.rpc('session.cancel',{sessionId}).catch(()=>{});await browser?.close().catch(()=>{});await host?.close().catch(()=>{});await site?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
