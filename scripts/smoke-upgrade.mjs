// Standalone package upgrade in one disposable home/profile and extension directory.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { waitForDsh } from '../benchmark/lib/dsh-client.mjs'
import { issuePairingCode, listInstallations } from '../benchmark/lib/pairing.mjs'
import { startExtensionBrowser } from '../benchmark/lib/extension-browser.mjs'
import { redactHostLogLine } from '../benchmark/lib/dsh-process.mjs'
import { within } from '../benchmark/lib/extension-connection.mjs'
const repo=resolve(import.meta.dirname,'..'), args=process.argv.slice(2)
function argument(name){const i=args.indexOf(name);if(i<0||!args[i+1])throw Error(name+' release directory is required');return resolve(args[i+1])}
const from=argument('--from'), to=argument('--to'), require=createRequire(join(repo,'package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const baselineCli = args.includes('--from-dsh-cli') ? argument('--from-dsh-cli') : cli
const currentFixtureRequire = createRequire(join(repo, 'packages/browser/bridge-browser/package.json'))
const baselineFixtureRequire = baselineCli === cli ? currentFixtureRequire : createRequire(baselineCli)
const root=await mkdtemp(join(tmpdir(),'stride-upgrade-')),home=join(root,'home'),extensionDir=join(root,'chrome')
const base=join(repo,'.stride-private/validation/upgrade');await mkdir(base,{recursive:true});const artifacts=await mkdtemp(join(base,'standalone-'))
const admin=randomBytes(32).toString('hex'),env={...process.env,DSH_HOME:home,DSH_EXT_TOKEN:admin,DSH_TELEMETRY_DISABLED:'1',DSH_BROWSER_SESSION_WORKSPACE:root}
delete env.DSH_BRIDGE_ADMIN_TOKEN
let browser,host,phase='setup',toolCalls=0
const counts=join(root,'tool-counts'),patch=join(root,'fixture.patch.yml'),fixture=join(root,'adapter.mjs')
const site=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Upgrade fixture</title><h1>Synthetic upgrade page</h1>'))
async function child(command,argv,options={}){const process=spawn(command,argv,{cwd:root,env,stdio:'ignore',...options});const timer=setTimeout(()=>process.kill('SIGKILL'),180000);try{assert.equal((await once(process,'exit'))[0],0,'Isolated install/archive command failed')}finally{clearTimeout(timer)}}
async function metadata(folder){const value=JSON.parse(await readFile(join(folder,'versions.json'),'utf8'));for(const line of (await readFile(join(folder,'SHA256SUMS'),'utf8')).trim().split('\n')){const [hash,name]=line.split('  ');assert.ok(name&&!name.includes('/')&&!name.includes('\\'));assert.equal(createHash('sha256').update(await readFile(join(folder,name))).digest('hex'),hash)}return value}
async function runtimeVersion(runtimeCli) {
  return JSON.parse(await readFile(join(dirname(runtimeCli), '..', 'package.json'), 'utf8')).version
}
async function install(folder, runtimeCli) {
  const bin = runtimeCli === cli ? join(repo, 'node_modules/.bin/dsh') : runtimeCli
  await child(process.execPath, [join(folder, 'install-host.mjs')], { env: { ...env, DSH_BIN: bin } })
}
async function launch(port, runtimeCli){
  const proc=spawn(process.execPath,[runtimeCli,'--profile','web','--patch',patch,'--','--no-open','--port',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']})
  let launchUrl,launchToken;const lines=[]
  proc.stdout.on('data',chunk=>{const text=chunk.toString();const match=text.match(/dsh web: (https?:\/\/\S+)/);if(match){launchUrl=match[1];launchToken=new URL(launchUrl).searchParams.get('token')}lines.push(redactHostLogLine(text,[admin,launchToken]))})
  proc.stderr.on('data',chunk=>lines.push(redactHostLogLine(chunk.toString(),[admin,launchToken])))
  const baseUrl=`http://127.0.0.1:${port}`;let client
  const close=async()=>{client?.close();if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGTERM');const timer=setTimeout(()=>proc.kill('SIGKILL'),5000);try{await once(proc,'exit')}finally{clearTimeout(timer)}}await writeFile(join(artifacts,phase+'-host.log'),lines.join(''),{mode:0o600})}
  try{client=await waitForDsh(baseUrl,{process:proc,getLaunchUrl:()=>launchUrl});return{client,baseUrl,issuePairingCode:()=>issuePairingCode(baseUrl,admin),listInstallations:()=>listInstallations(baseUrl,admin),close}}catch(error){await close();throw error}
}
async function rpc(method,payload){return browser.panel.evaluate(({method,payload})=>new Promise((done,fail)=>{const port=window.__upgradePort??=chrome.runtime.connect({name:'dsh-panel'}),id=crypto.randomUUID();const timer=setTimeout(()=>{port.onMessage.removeListener(receive);fail(Error('Upgrade fixture RPC timeout'))},10000);function receive(message){if(message.type!=='rpc.result'||message.id!==id)return;clearTimeout(timer);port.onMessage.removeListener(receive);if(!message.ok||message.result?.result?.ok===false)fail(Error('Upgrade RPC rejected'));else done(message.result?.result?.value??message.result)}port.onMessage.addListener(receive);port.postMessage({type:'rpc',id,method,payload})}),{method,payload})}
async function credentialDigest(){return browser.worker.evaluate(async()=>{const db=await new Promise((done,fail)=>{const r=indexedDB.open('dsh-browser-private',1);r.onsuccess=()=>done(r.result);r.onerror=()=>fail(Error('Credential database unavailable'))});try{const value=await new Promise((done,fail)=>{const r=db.transaction('credentials','readonly').objectStore('credentials').get('bridge');r.onsuccess=()=>done(r.result);r.onerror=()=>fail(Error('Credential missing'))});if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Saved credential unavailable');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('')}finally{db.close()}})}
async function chat(sid,text){console.log(JSON.stringify({phase:'pure-chat',stage:phase}));await host.client.followSession(sid);let started=false,finish;const done=new Promise(resolve=>finish=resolve);const off=host.client.onFrame(frame=>{if(frame.type!=='session/event'||frame.sessionId!==sid)return;const event=frame.event?.event??frame.event;if(event.type==='turn/start')started=true;if(started&&event.type==='turn/end')finish(event.data.reason.kind)});try{const input=browser.panel.locator('.composer textarea');await input.fill(text);await input.press('Enter');assert.equal(await within(done,30000,'Upgrade pure chat'),'completed')}finally{off()}}
async function ownerConnection(host){
 const response=await fetch(host.baseUrl+'/api/stride-browser-pairing',{headers:{cookie:host.client.cookie},redirect:'error'})
 assert.equal(response.status,200)
 return (await response.json()).connection
}
async function prepareChatFixture(resolveFromRuntime) {
  const llm = pathToFileURL(resolveFromRuntime.resolve('@deepseek-ai/dsh-llm')).href
  await writeFile(fixture, `import {LlmAdapter} from ${JSON.stringify(llm)};import {writeFile} from 'node:fs/promises';class Echo extends LlmAdapter{async listModels(provider){return[{provider,id:'echo',name:'Upgrade chat',contextWindow:32000}]}async *stream(){const block={type:'text',text:'UPGRADE_CHAT_RECEIVED'};yield{type:'block-start',index:0,blockType:'text'};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'stop'}}}}export const inject=['llm','tools'];export function apply(ctx){ctx.effect(()=>ctx.llm.registerAdapter(['upgrade-fixture'],new Echo()));let count=0;ctx.on('tools/execute',async(_exec,next)=>{await writeFile(${JSON.stringify(counts)},String(++count));return next()})}`)
}
try{
 await mkdir(home);await mkdir(extensionDir);const old=await metadata(from),next=await metadata(to);assert.notEqual(old.version,next.version)
 assert.equal(await runtimeVersion(baselineCli), old.dshVersion, 'Baseline archive and DSH CLI must match; use --from-dsh-cli for a DSH upgrade')
 assert.equal(await runtimeVersion(cli), next.dshVersion, 'Updated archive must match the workspace DSH CLI')
 await writeFile(counts,'0')
 await prepareChatFixture(baselineFixtureRequire)
 await writeFile(patch,'- insert:\n    - id: upgrade-chat-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n')
 await new Promise(done=>site.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${site.address().port}`
 const reservation=createServer();await new Promise(done=>reservation.listen(0,'127.0.0.1',done));const port=reservation.address().port;await new Promise(done=>reservation.close(done))
 console.log(JSON.stringify({phase:'baseline-install'}));phase='baseline-install';await install(from,baselineCli);await child('unzip',['-q',join(from,old.chrome),'-d',extensionDir]);host=await launch(port,baselineCli)
 browser=await startExtensionBrowser({repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),bridgeUrl:`ws://127.0.0.1:${port}/ext/bridge`,issuePairingCode:()=>host.issuePairingCode(),trustedOrigin:origin,extensionDir})
 await browser.prepare(origin+'/upgrade');let sid;for(let i=0;i<100&&!sid;i++){sid=await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity?.focusedSessionId);if(!sid)await browser.panel.waitForTimeout(100)}assert.equal(typeof sid,'string')
 await browser.bindSession(sid);await browser.panel.bringToFront();await rpc('session.selectModel',{sessionId:sid,provider:'upgrade-fixture',model:'echo'})
 const brief=await rpc('bridge.taskBrief.save',{sessionId:sid,version:0,input:{goal:'Preserve synthetic upgrade notes',projectPath:root,materials:[],criteria:[{id:'history',text:'History and pairing survive upgrade'}]}})
 await chat(sid,'Synthetic history before upgrade');assert.ok(JSON.stringify(await host.client.rpc('session.history',{sessionId:sid})).includes('UPGRADE_CHAT_RECEIVED'))
 const response=await fetch(host.baseUrl+'/api/commands/execute',{method:'POST',headers:{'content-type':'application/json',cookie:host.client.cookie},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'commands/execute',payload:{args:{agentId:sid,line:'/browser Keep this synthetic task queued; do not start.',submittedAttachments:[]}}})});assert.equal(response.status,200);assert.equal((await response.json()).result.value.result.kind,'success')
 assert.equal(Number(await readFile(counts,'utf8')),0);const before=await rpc('bridge.browserRuns.list',{sessionId:sid});assert.equal(before.items.length,1);assert.equal(before.items[0].state,'queued');assert.equal(before.items[0].task.modelRequests,0)
 const credential=await credentialDigest(),pairings=(await host.listInstallations()).map(p=>p.installationId).sort();assert.equal(pairings.length,1)
 console.log(JSON.stringify({phase:'upgrade-install'}));phase='upgrade-install';await host.close();host=undefined;await browser.context.close();await install(to,cli);await child('unzip',['-qo',join(to,next.chrome),'-d',extensionDir]);await prepareChatFixture(currentFixtureRequire);host=await launch(port,cli)
 Object.assign(browser,await browser.restart({reloadExtension:true}));await browser.panel.getByRole('button',{name:'打开设置',exact:true}).click();const shown=await browser.panel.locator('.settings-panel .version-status').textContent();assert.ok(shown.includes('DSH '+next.dshVersion));assert.ok(shown.includes('Host '+next.version));await browser.panel.locator('.settings-actions button.secondary').click();assert.equal(await credentialDigest(),credential);assert.deepEqual((await host.listInstallations()).map(p=>p.installationId).sort(),pairings)
 assert.equal(await browser.worker.evaluate(()=>chrome.runtime.getManifest().version),next.version)
 const connection=await ownerConnection(host)
 if(connection!==undefined)assert.equal(connection?.extensionVersion,next.version)
 assert.equal(await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length??0),0)
 assert.ok(JSON.stringify(await host.client.rpc('session.history',{sessionId:sid})).includes('UPGRADE_CHAT_RECEIVED'))
 const notes=await rpc('bridge.taskBrief.get',{sessionId:sid});assert.deepEqual(notes,brief)
 const after=await rpc('bridge.browserRuns.list',{sessionId:sid});assert.deepEqual(after,before)
 // Re-authorizing a page and selecting history is explicit; restart must not do it.
 await browser.panel.getByRole('button',{name:'历史会话',exact:true}).click();await browser.panel.locator(`.session-list button[data-session-id="${sid}"]`).click();await browser.panel.waitForFunction(id=>document.querySelector('.app')?.getAttribute('data-session-id')===id,sid);await browser.bindSession(sid);await browser.panel.bringToFront();await chat(sid,'Synthetic history after upgrade')
 toolCalls=Number(await readFile(counts,'utf8'));assert.equal(toolCalls,0)
 const afterChat=await rpc('bridge.browserRuns.list',{sessionId:sid});assert.equal(afterChat.items[0].state,'queued');assert.equal(afterChat.items[0].task.modelRequests,0)
 const result={passed:true,fromVersion:old.version,toVersion:next.version,fromDshVersion:old.dshVersion,dshVersion:next.dshVersion,nodeVersion:process.version,browserVersion:browser.browserVersion,reportedExtensionVersion:connection?.extensionVersion??null,platform:process.platform,arch:process.arch,installedStandalone:true,checksumsVerified:true,sameHomeAndProfile:true,sameExtensionDirectory:true,pairingPreserved:true,historyPreserved:true,taskNotesPreserved:true,queuedTaskDidNotStart:true,pageGrantsNotRestored:true,pureChatToolCalls:toolCalls,originalHostUntouched:true,sourceReceipt:next,hostArchiveSha256:createHash('sha256').update(await readFile(join(to,next.host))).digest('hex'),chromeArchiveSha256:createHash('sha256').update(await readFile(join(to,next.chrome))).digest('hex'),evidenceDirectory:artifacts.slice(base.length+1)}
 await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2),{mode:0o600});await writeFile(join(base,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result))
}catch(error){await writeFile(join(artifacts,'failure.json'),JSON.stringify({passed:false,phase,errorName:error.name},null,2),{mode:0o600});throw error}
finally{await browser?.close().catch(()=>{});await host?.close().catch(()=>{});await new Promise(done=>site.close(done));await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
