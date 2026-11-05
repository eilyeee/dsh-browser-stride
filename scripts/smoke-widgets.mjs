// Isolated end-to-end widget regression, with an optional real default model.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,chmod,rm} from 'node:fs/promises'
import {createServer} from 'node:net'
import {createRequire} from 'node:module'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'
import {startDshBackend} from '../benchmark/lib/dsh-process.mjs'
import {startExtensionBrowser} from '../benchmark/lib/extension-browser.mjs'
import {startWidgetSite} from './fixtures/widget-site.mjs'

const repoRoot=resolve(import.meta.dirname,'..'),require=createRequire(join(repoRoot,'package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const root=await mkdtemp(join(tmpdir(),'stride-widgets-')),home=join(root,'home')
const trigger=join(root,'command.json'),result=join(root,'result.json')
const artifacts=join(repoRoot,'.stride-private/validation/widgets'),realModel=process.env.STRIDE_REAL_MODEL==='1'
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
let host,browser,site,modelSessionId,sequence=0,phase='setup'
async function json(path){try{return JSON.parse(await readFile(path,'utf8'))}catch{return undefined}}
async function wait(check,label,ms=30000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await delay(100)}throw Error('Widget acceptance timed out: '+label)}
async function command(sessionId,name,args={}){
 const id=++sequence
 await writeFile(trigger,JSON.stringify({sequence:id,sessionId,name,args}),{mode:0o600})
 await wait(async()=>(await json(result))?.sequence===id,name,105000)
 const reply=await json(result);assert.equal(reply.probeError,undefined);return reply
}
function reference(reply,role,name){
 const line=reply.text.split('\n').find(line=>line.includes(`${role} "${name}"`))
 const ref=line?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1]
 assert.ok(ref,`Missing observed ${role}: ${name}`);return ref
}
try{
 await mkdir(home);await mkdir(artifacts,{recursive:true})
 const install=spawn(process.execPath,[cli,'plugin','--profile','web','add','-w',`@eilyeee/dsh-browser-stride@link:${join(repoRoot,'packages/browser/bridge-browser')}`],{cwd:repoRoot,env,stdio:'ignore'})
 const installTimer=setTimeout(()=>install.kill('SIGKILL'),120000)
 try{assert.equal((await once(install,'exit'))[0],0)}finally{clearTimeout(installTimer)}
 if(realModel&&process.env.STRIDE_MODEL_CREDENTIALS){await copyFile(process.env.STRIDE_MODEL_CREDENTIALS,join(home,'.credentials.yaml'));await chmod(join(home,'.credentials.yaml'),0o600)}
 const extraPatch=realModel&&process.env.STRIDE_MODEL_PATCH?await readFile(process.env.STRIDE_MODEL_PATCH,'utf8'):undefined
 process.env.DSH_HOME=home
 site=await startWidgetSite()
 const socket=createServer();await new Promise(done=>socket.listen(0,'127.0.0.1',done));const port=socket.address().port;await new Promise(done=>socket.close(done))
 host=await startDshBackend({backend:'extension',port,repoRoot,benchmarkRoot:join(repoRoot,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:site.url,
  toolProbe:{plugin:join(repoRoot,'scripts/fixtures/visual-probe.mjs'),trigger,result},extraPatch})
 browser=await startExtensionBrowser({repoRoot,benchmarkRoot:join(repoRoot,'benchmark'),bridgeUrl:`ws://127.0.0.1:${port}/ext/bridge`,pairingCode:await host.issuePairingCode(),trustedOrigin:site.origin,
  chromiumArgs:['--no-proxy-server','--host-resolver-rules=MAP stride-widgets.test 127.0.0.1']})
 await browser.prepare(site.url)
 const sessionId=(await host.client.rpc('session.create',{cwd:root})).sessionId;await browser.bindSession(sessionId)
 phase='custom-options'
 let view=await command(sessionId,'browser_snapshot');assert.equal(view.ok,true)
 assert.equal(view.text.includes(`option "${site.choice}"`),false)
 assert.equal((await command(sessionId,'browser_click',{elementRef:reference(view,'input','Channel')})).ok,true)
 view=await command(sessionId,'browser_snapshot')
 const chosen=reference(view,'option',site.choice),blocked=reference(view,'option','Unavailable channel')
 assert.equal((await command(sessionId,'browser_click',{elementRef:blocked})).ok,false)
 assert.equal(await browser.target.evaluate(()=>window.widgetOptionClicks),0)
 assert.equal((await command(sessionId,'browser_click',{elementRef:chosen})).ok,true)
 assert.equal(await browser.target.locator('#choice').inputValue(),site.choice)
 assert.equal((await command(sessionId,'browser_click',{elementRef:chosen})).ok,false,'Closed popup references cannot be replayed')
 phase='legacy-keyboard'
 await browser.target.locator('#legacy').focus()
 assert.equal((await command(sessionId,'browser_press',{key:'ArrowDown'})).ok,true)
 assert.equal(await browser.target.locator('#legacy').inputValue(),'Legacy next')
 assert.deepEqual(await browser.target.evaluate(()=>window.widgetKeyEvents.at(-1)),{key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40,trusted:false})
 phase='background-hash-navigation'
 const other=await browser.context.newPage();await other.goto(site.origin+'/personal');await other.bringToFront()
 const before=await browser.target.evaluate(()=>({url:location.href,changes:window.widgetRouteChanges}))
 assert.equal((await command(sessionId,'browser_navigate',{url:site.second})).ok,true)
 await wait(async()=>await browser.target.locator('#route').innerText()==='Route: /second','rendered hash route')
 assert.equal(await browser.target.evaluate(()=>window.widgetRouteChanges),before.changes+1)
 assert.equal(other.url(),site.origin+'/personal')
 assert.equal((await command(sessionId,'browser_click',{elementRef:chosen})).ok,false,'Navigation invalidates old references')
 phase='managed-background-hash-navigation'
 await browser.panel.reload()
 await browser.panel.locator('.connection .dot.connected').waitFor({state:'visible'})
 await browser.panel.getByRole('button',{name:'打开设置',exact:true}).click()
 await browser.panel.getByRole('checkbox',{name:'自动控制 DSH 新建页面',exact:false}).check()
 await browser.panel.getByRole('button',{name:'保存并连接',exact:true}).click()
 await browser.panel.locator('.connection .dot.connected').waitFor({state:'visible'})
 assert.equal((await command(sessionId,'browser_open_tab',{url:site.url})).ok,true)
 const managed=browser.context.pages().findLast(page=>page!==browser.target&&page.url()===site.url)
 assert.ok(managed,'The auto-controlled tab must be independently observable')
 await other.bringToFront()
 assert.equal((await command(sessionId,'browser_navigate',{url:site.second})).ok,true)
 await wait(async()=>await managed.locator('#route').innerText()==='Route: /second','managed rendered hash route')
 assert.equal(other.url(),site.origin+'/personal')
 let modelEvidence
 if(realModel){
  phase='default-model'
  await managed.goto(site.url);await managed.bringToFront()
  modelSessionId=sessionId
  const id=++sequence
  await writeFile(trigger,JSON.stringify({sequence:id,mode:'model',reportKind:'widgets',sessionId:modelSessionId,allowedUrls:[site.second],expected:{channel:site.choice,saved:true,route:'/second'}}),{mode:0o600})
  await wait(async()=>(await json(result))?.modelReady===true,'model guard')
  await host.client.rpc('session.prompt',{sessionId:modelSessionId,mode:'queue',content:[{type:'text',text:`在当前受控的合成设置页把 Channel 选为 ${site.choice}，保存一次并核对成功消息。随后导航到 ${site.second}，核对正文 Route 为 /second。只用浏览器工具；不要改源码或访问其他网址。最终仅返回 JSON：channel（选择名称）、saved（已观察到保存成功）、route（正文路由值）。`}],clientTimeZone:'Asia/Shanghai'})
  await wait(async()=>(await json(result+'.model'))?.terminal===true,'default model',360000)
  modelEvidence=await json(result+'.model')
  assert.equal(modelEvidence.reason,'completed');assert.deepEqual(modelEvidence.blocked,[]);assert.equal(modelEvidence.finalWidgetReportCorrect,true)
  assert.deepEqual(site.state().writes,[{channel:site.choice}]);assert.equal(await managed.locator('#choice').inputValue(),site.choice)
  assert.equal(await managed.locator('#route').innerText(),'Route: /second')
  assert.ok(await host.client.rpc('session.history',{sessionId:modelSessionId}))
 }
 const summary={passed:true,realHost:true,isolatedChrome:true,syntheticOnly:true,realModel,
  observedOptionClick:true,disabledOptionDenied:true,closedOptionDenied:true,legacyKeyHandlerVerified:true,
  backgroundHashRendered:true,managedBackgroundHashRendered:true,otherTabUnchanged:true,navigationInvalidatesReferences:true,...modelEvidence?{modelEvidence}:{}}
 await writeFile(join(artifacts,realModel?'real-model.json':'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary))
}catch(error){await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,realModel?'real-model.json':'result.json'),JSON.stringify({passed:false,phase,errorName:error.name})+'\n',{mode:0o600});console.error(JSON.stringify({phase}));throw error}
finally{if(modelSessionId)await host?.client.rpc('session.cancel',{sessionId:modelSessionId}).catch(()=>{});await browser?.close().catch(()=>{});await host?.close().catch(()=>{});await site?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
