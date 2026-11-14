// Real temporary Host and PTC runtime, scripted model and simulated extension.
// No browser, credentials or existing user Host are used.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:net'
import {createHash} from 'node:crypto'
import {startDshBackend} from '../benchmark/lib/dsh-process.mjs'
import {within} from '../benchmark/lib/extension-connection.mjs'

const repo=resolve(import.meta.dirname,'..'),require=createRequire(join(repo,'package.json'))
const bridgeRequire=createRequire(join(repo,'packages/browser/bridge-browser/package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const WebSocket=bridgeRequire('ws')
const {BRIDGE_PROTOCOL_VERSION,BRIDGE_CONFIRM_TOOL_METHOD}=await import(pathToFileURL(join(repo,'packages/browser/bridge-browser/lib/protocol.js')).href)
const version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version
const root=await mkdtemp(join(tmpdir(),'stride-preflight-')),home=join(root,'home')
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
const events=[],wireCalls=[],confirmations=new Map()
let host,socket,sessionId,turnTimer
const program=`let refused=false;
try{await tools.browser_click_at({screenshotRef:'synthetic-image',x:0.5,y:0.5})}catch{refused=true}
if(!refused)throw Error('Unsupported visual action was not refused');
const view=await tools.browser_snapshot({});
const ref=view.text.match(/ref=(obs_[a-f0-9-]+:\\d+)/)?.[1];
if(!ref)throw Error('Missing synthetic observation');
await tools.browser_click({elementRef:ref});
console.log('STRIDE_PREFLIGHT_PROGRAM_OK');`
try{
  await mkdir(home)
  const install=spawn(process.execPath,[cli,'plugin','--profile','web','add','-w','@eilyeee/dsh-browser-stride@link:'+join(repo,'packages/browser/bridge-browser')],{cwd:repo,env,stdio:'ignore'})
  const installTimer=setTimeout(()=>install.kill('SIGKILL'),120000)
  try{assert.equal((await once(install,'exit'))[0],0,'Temporary profile installation failed')}finally{clearTimeout(installTimer)}
  const fixture=join(root,'adapter.mjs')
  await writeFile(fixture,`import {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
class Scripted extends LlmAdapter{
async listModels(provider){return [{provider,id:'preflight',name:'Synthetic preflight',contextWindow:128000}]}
async *stream(options){const done=options.messages.some(m=>m.role==='tool');const block=done?{type:'text',text:'STRIDE_PREFLIGHT_DONE'}:{type:'tool-call',id:'preflight-1',name:'run_code',arguments:JSON.stringify({code:${JSON.stringify(program)},description:'Verify an unsent refusal and an observed alternative'})};yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents'];export function apply(ctx){
ctx.on('agent/created',({agent})=>{agent.ctx.effect(()=>agent.ctx.tools.presentAs('ptc'))});
ctx.effect(()=>ctx.llm.registerAdapter(['stride-preflight'],new Scripted()));
let calls=0;ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_click_at','browser_snapshot','browser_click'].includes(exec.name)?'Only synthetic preflight tools are allowed':++calls>4?'Synthetic tool budget exhausted':undefined));
}
`,{mode:0o600})
  process.env.DSH_HOME=home
  for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete process.env[key]
  const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done))
  const port=listener.address().port;await new Promise(done=>listener.close(done))
  host=await startDshBackend({backend:'extension',port,repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:'http://127.0.0.1/',deferSessionCreate:true,extraPatch:'\n- insert:\n    - id: preflight-feedback-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n'})
  socket=new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`)
  const ready=new Promise((done,fail)=>{
    socket.on('error',fail)
    socket.on('open',async()=>{
      try{socket.send(JSON.stringify({t:'hello',token:await host.issuePairingCode(),installationId:'preflight-synthetic-installation',protocolVersion:BRIDGE_PROTOCOL_VERSION,caps:{textOnly:true,snapshotMaxChars:12000,maxInteractiveItems:60}}))}catch(error){fail(error)}
    })
    socket.on('message',raw=>{
      try{
        const frame=JSON.parse(String(raw))
        if(frame.t==='hello.ok'){assert.equal(frame.caps.release.bridgeVersion,version);done();return}
        if(frame.t==='tool.call'){
          wireCalls.push(frame.name)
          const id='confirm-'+frame.id;confirmations.set(id,frame)
          socket.send(JSON.stringify({t:'rpc',id,method:BRIDGE_CONFIRM_TOOL_METHOD,payload:{id:frame.id,action:frame.action,execution:frame.execution,...frame.sessionId===undefined?{}:{sessionId:frame.sessionId}}}))
        }else if(frame.t==='rpc.result'&&confirmations.has(frame.id)){
          assert.equal(frame.ok,true)
          const call=confirmations.get(frame.id);confirmations.delete(frame.id)
          assert.ok(['browser_snapshot','browser_click'].includes(call.name),'Unsupported tool must not reach the extension')
          const result=call.name==='browser_snapshot'?{text:'Synthetic ready\n[1] button Save ref=obs_00000000-0000-4000-8000-000000000001:1'}:{text:'Synthetic click dispatched',feedback:{version:1,state:'dispatched',businessChange:'not-verified'}}
          socket.send(JSON.stringify({t:'tool.result',id:call.id,action:call.action,ok:true,result}))
        }
      }catch(error){fail(error);socket.close()}
    })
  })
  await within(ready,15000,'synthetic extension handshake')
  sessionId=(await host.client.rpc('session.create',{cwd:join(repo,'benchmark/workspace')})).sessionId
  await host.client.rpc('session.selectModel',{sessionId,provider:'stride-preflight',model:'preflight'})
  await host.client.followSession(sessionId)
  let started=false,finish
  const complete=new Promise(done=>{finish=done})
  host.client.onFrame(frame=>{
    if(frame.type!=='session/event'||frame.sessionId!==sessionId)return
    const e=frame.event?.event??frame.event
    if(e.type==='turn/start')started=true
    if(!started)return
    events.push(e)
    if(e.type==='turn/end')finish(e.data.reason.kind)
  })
  turnTimer=setTimeout(()=>{void host.client.rpc('session.cancel',{sessionId}).catch(()=>{});finish('test-timeout')},60000)
  await host.client.rpc('session.prompt',{sessionId,mode:'queue',content:[{type:'text',text:'Run the synthetic preflight program once.'}]})
  assert.equal(await complete,'completed')
  assert.deepEqual(wireCalls,['browser_snapshot','browser_click'])
  const dispatches=events.filter(e=>e.type==='tool/ptc-dispatch').map(e=>e.data)
  assert.deepEqual(dispatches.map(d=>d.name),['browser_click_at','browser_snapshot','browser_click'])
  assert.equal(dispatches[0].isError,true)
  assert.deepEqual(dispatches[0].meta.browserFeedback,{version:1,state:'not-applied',businessChange:'not-verified',code:'action_failed',nextStep:'reobserve'})
  assert.equal(dispatches[0].error.name,'BrowserNotDispatchedError')
  const result=events.find(e=>e.type==='tool/result')?.data.message
  assert.ok(result&&!result.isError&&JSON.stringify(result.content).includes('STRIDE_PREFLIGHT_PROGRAM_OK'))
  const artifacts=join(repo,'.stride-private/validation/preflight-feedback',version)
  await mkdir(artifacts,{recursive:true})
  const summary={passed:true,version,realHost:true,nativePtcRuntime:true,scriptedModel:true,realModel:false,simulatedExtension:true,realBrowser:false,hostUnsentFeedback:true,unsentToolDidNotReachExtension:true,observedAlternativeAllowed:true,savedBusinessChangeVerified:false,originalHostUntouched:true,hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex')}
  await writeFile(join(artifacts,'events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600})
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify(summary))
}finally{
  clearTimeout(turnTimer)
  if(sessionId)await host?.client.rpc('session.cancel',{sessionId}).catch(()=>{})
  socket?.terminate();await host?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})
}
