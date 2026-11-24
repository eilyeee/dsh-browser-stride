// Real isolated Host/SDK scheduling; scripted model and simulated extension.
// No real model, browser, credentials or existing Host is used.
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
const artifactRoot=join(repo,'.stride-private/validation/write-boundaries',version)
await mkdir(artifactRoot,{recursive:true})
const artifacts=await mkdtemp(join(artifactRoot,'run-'))
await writeFile(join(artifactRoot,'result.json'),JSON.stringify({passed:false,version,status:'in-progress',evidenceDirectory:artifacts.slice(artifactRoot.length+1)})+'\n',{mode:0o600})
const cases=['READBACK','UNKNOWN','CONFIRMED'],modes=['ptc','native'],summaries=[]
const reference='obs_00000000-0000-4000-8000-000000000001:1'

function program(kind){
  return `const results=await Promise.allSettled([
tools.browser_click({elementRef:${JSON.stringify(reference)}}),
tools.browser_click({elementRef:${JSON.stringify(reference)}})
]);
if(results[0].status!==${JSON.stringify(kind==='UNKNOWN'?'rejected':'fulfilled')})throw Error('Unexpected first write outcome');
if(results[1].status!==${JSON.stringify(kind==='CONFIRMED'?'fulfilled':'rejected')})throw Error('Unexpected second write outcome');
await tools.browser_snapshot({});console.log('WRITE_BOUNDARY_PROGRAM_OK');`
}

async function runMode(mode){
  const root=await mkdtemp(join(tmpdir(),'stride-write-boundaries-')),home=join(root,'home')
  const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
  for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
  let host,socket,sessionId,turnTimer,wireError,activeCase,wireCalls=[],outstanding=0,maxOutstanding=0
  const confirmations=new Map(),responseTimers=new Set()
  try{
    await mkdir(home)
    const install=spawn(process.execPath,[cli,'plugin','--profile','web','add','-w','@eilyeee/dsh-browser-stride@link:'+join(repo,'packages/browser/bridge-browser')],{cwd:repo,env,stdio:'ignore'})
    const installTimer=setTimeout(()=>install.kill('SIGKILL'),120000)
    try{assert.equal((await once(install,'exit'))[0],0,'Temporary profile installation failed')}finally{clearTimeout(installTimer)}
    const fixture=join(root,'adapter.mjs')
    await writeFile(fixture,`import {LlmAdapter} from ${JSON.stringify(pathToFileURL(bridgeRequire.resolve('@deepseek-ai/dsh-llm')).href)};
const programs=${JSON.stringify(Object.fromEntries(cases.map(kind=>[kind,program(kind)])))};
class Scripted extends LlmAdapter{
async listModels(provider){return [{provider,id:'write-boundaries',name:'Synthetic write boundaries',contextWindow:128000}]}
async *stream(options){
 const messages=options.messages,texts=messages.map(m=>m.content?.filter(b=>b.type==='text').map(b=>b.text).join(' ')||'');
 const index=texts.findLastIndex((t,i)=>messages[i].role==='user'&&t.includes('WRITE_BOUNDARY_')),kind=texts[index]?.match(/WRITE_BOUNDARY_(READBACK|UNKNOWN|CONFIRMED)/)?.[1];
 if(!programs[kind])throw Error('Unknown synthetic case');
 const done=messages.slice(index+1).some(m=>m.role==='tool');
 const blocks=done?[{type:'text',text:'WRITE_BOUNDARY_DONE'}]:${JSON.stringify(mode)}==='ptc'?
 [{type:'tool-call',id:'program',name:'run_code',arguments:JSON.stringify({code:programs[kind],description:'Verify parallel write admission and subsequent observation'})}]:
 [{type:'tool-call',id:'first',name:'browser_click',arguments:JSON.stringify({elementRef:${JSON.stringify(reference)}})},
  {type:'tool-call',id:'second',name:'browser_click',arguments:JSON.stringify({elementRef:${JSON.stringify(reference)}})},
  {type:'tool-call',id:'read',name:'browser_snapshot',arguments:'{}'}];
 for(const [index,block] of blocks.entries()){yield {type:'block-start',index,blockType:block.type};yield {type:'block-end',index,block}}
 yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}
}}
export const inject=['llm','tools','agents'];export function apply(ctx){
 ctx.effect(()=>ctx.llm.registerAdapter(['stride-write-boundaries'],new Scripted()));
 const counts=new WeakMap();ctx.effect(()=>ctx.tools.guard(exec=>{
  if(!exec.agent||!['run_code','browser_click','browser_snapshot'].includes(exec.name))return 'Only synthetic boundary tools are allowed';
  const count=(counts.get(exec.agent)||0)+1;counts.set(exec.agent,count);return count>4?'Synthetic tool budget exhausted':undefined;
 }));
}
`,{mode:0o600})
    process.env.DSH_HOME=home
    for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete process.env[key]
    const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done))
    const port=listener.address().port;await new Promise(done=>listener.close(done))
    host=await startDshBackend({backend:'extension',port,repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:'http://127.0.0.1/',toolExecutor: mode, deferSessionCreate: true,extraPatch:'\n- insert:\n    - id: write-boundaries-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n'})
    socket=new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`)
    const ready=new Promise((done,fail)=>{
      socket.on('error',error=>{wireError=error;fail(error)})
      socket.on('open',async()=>{
        try{socket.send(JSON.stringify({t:'hello',token:await host.issuePairingCode(),installationId:'write-boundaries-synthetic-installation',protocolVersion:BRIDGE_PROTOCOL_VERSION,caps:{textOnly:true,snapshotMaxChars:12000,maxInteractiveItems:60}}))}catch(error){wireError=error;fail(error)}
      })
      socket.on('message',raw=>{
        try{
          const frame=JSON.parse(String(raw))
          if(frame.t==='hello.ok'){assert.equal(frame.caps.release.bridgeVersion,version);done();return}
          if(frame.t==='tool.call'){
            assert.ok(activeCase&&['browser_snapshot','browser_click'].includes(frame.name))
            wireCalls.push(frame.name);outstanding++;maxOutstanding=Math.max(maxOutstanding,outstanding)
            const id='confirm-'+frame.id;confirmations.set(id,frame)
            socket.send(JSON.stringify({t:'rpc',id,method:BRIDGE_CONFIRM_TOOL_METHOD,payload:{id:frame.id,action:frame.action,execution:frame.execution,...frame.sessionId===undefined?{}:{sessionId:frame.sessionId}}}))
          }else if(frame.t==='rpc.result'&&confirmations.has(frame.id)){
            assert.equal(frame.ok,true)
            const call=confirmations.get(frame.id);confirmations.delete(frame.id)
            // Keep the first reply pending briefly: an accidentally parallel
            // definition must not pass just because the simulated peer is fast.
            const timer=setTimeout(()=>{
              responseTimers.delete(timer);outstanding--
              const body=call.name==='browser_snapshot'?{ok:true,result:{text:'Synthetic observation'}}:
                activeCase==='UNKNOWN'?{ok:false,error:{code:'action-failed',message:'Synthetic write reply cannot confirm its effect'}}:
                {ok:true,result:{text:'Synthetic write response',feedback:{version:1,state:activeCase==='READBACK'?'readback-unconfirmed':'dispatched',businessChange:'not-verified'}}}
              socket.send(JSON.stringify({t:'tool.result',id:call.id,action:call.action,...body}))
            },150)
            responseTimers.add(timer)
          }
        }catch(error){wireError=error;fail(error);socket.close()}
      })
    })
    await within(ready,15000,'synthetic extension handshake')
    for(const kind of cases){
      activeCase=kind;wireCalls=[];outstanding=0;maxOutstanding=0
      sessionId=(await host.client.rpc('session.create',{cwd:join(repo,'benchmark/workspace')})).sessionId
      await host.client.rpc('session.selectModel',{sessionId,provider:'stride-write-boundaries',model:'write-boundaries'})
      await host.client.followSession(sessionId)
      const events=[];let started=false,finish
      const complete=new Promise(done=>{finish=done})
      const off=host.client.onFrame(frame=>{
        if(frame.type!=='session/event'||frame.sessionId!==sessionId)return
        const e=frame.event?.event??frame.event
        if(e.type==='turn/start')started=true
        if(!started)return
        events.push(e)
        if(e.type==='turn/end')finish(e.data.reason.kind)
      })
      console.log(JSON.stringify({mode,case:kind}))
      try{
        turnTimer=setTimeout(()=>{void host.client.rpc('session.cancel',{sessionId}).catch(()=>{});finish('test-timeout')},60000)
        await host.client.rpc('session.prompt',{sessionId,mode:'queue',content:[{type:'text',text:'WRITE_BOUNDARY_'+kind}]})
        const reason=await complete
        await writeFile(join(artifacts,mode+'-'+kind.toLowerCase()+'-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600})
        assert.equal(reason,'completed');assert.equal(wireError,undefined)
        assert.equal(maxOutstanding,1,'Browser tool bodies overlapped')
        assert.equal(outstanding,0)
        assert.deepEqual(wireCalls,kind==='CONFIRMED'?['browser_click','browser_click','browser_snapshot']:['browser_click','browser_snapshot'])
        const results=mode==='ptc'?events.filter(e=>e.type==='tool/ptc-dispatch').map(e=>e.data):events.filter(e=>e.type==='tool/result').map(e=>({...e.data,isError:e.data.message.isError===true}))
        assert.equal(results.length,3)
        assert.equal(results[0].isError,kind==='UNKNOWN')
        assert.equal(results[1].isError,kind!=='CONFIRMED')
        assert.equal(results[2].isError,false)
        if(kind==='READBACK')assert.equal(results[0].meta?.browserFeedback?.state,'readback-unconfirmed')
        if(kind==='UNKNOWN')assert.deepEqual(results[0].meta?.browserFeedback,{version:1,state:'uncertain',businessChange:'not-verified',code:'result_unknown',nextStep:'reconcile_business_state'})
        if(kind!=='CONFIRMED')assert.deepEqual(results[1].meta?.browserFeedback,{version:1,state:'not-applied',businessChange:'not-verified',code:'result_unknown',nextStep:'reconcile_business_state'})
        if(mode==='ptc'){
          const programResult=events.find(e=>e.type==='tool/result')?.data.message
          assert.ok(programResult&&!programResult.isError&&JSON.stringify(programResult.content).includes('WRITE_BOUNDARY_PROGRAM_OK'))
        }
        summaries.push({mode,case:kind,passed:true,wireWrites:wireCalls.filter(n=>n==='browser_click').length,maxOutstanding,readAllowed:true})
      }finally{clearTimeout(turnTimer);off()}
    }
  }finally{
    clearTimeout(turnTimer)
    for(const timer of responseTimers)clearTimeout(timer)
    if(sessionId)await host?.client.rpc('session.cancel',{sessionId}).catch(()=>{})
    socket?.terminate();await host?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})
  }
}

try{
  for(const mode of modes)await runMode(mode)
  const summary={passed:true,version,realHost:true,nativeToolRuntime:true,nativePtcRuntime:true,scriptedModel:true,realModel:false,simulatedExtension:true,realBrowser:false,originalHostUntouched:true,cases:summaries,savedBusinessChangeVerified:false,evidenceDirectory:artifacts.slice(artifactRoot.length+1),hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex')}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  await writeFile(join(artifactRoot,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  console.log(JSON.stringify(summary))
}catch(error){
  const summary={passed:false,version,status:'failed',completedCases:summaries,evidenceDirectory:artifacts.slice(artifactRoot.length+1)}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  await writeFile(join(artifactRoot,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  throw error
}
