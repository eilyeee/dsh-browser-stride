// Native toolbar failures and a read-only list refresh in disposable Chrome.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
const repo=resolve(import.meta.dirname,'..'), version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version
const base=join(repo,'.stride-private/validation/page-authorization',version);await mkdir(base,{recursive:true});const artifacts=await mkdtemp(join(base,'native-'))
let h, phase='setup',writes=0
const site=createServer((req,res)=>{if(req.method!=='GET'){writes++;res.writeHead(405).end();return}res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<!doctype html><meta charset="utf-8"><title>Local page authorization</title><h1>Local synthetic page</h1>')})
async function nativeAction(page){
 await page.bringToFront();const cdp=await h.browser.context.browser().newBrowserCDPSession()
 try{const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});const target=targetInfos.find(t=>t.url===page.url());assert.ok(target);await cdp.send('Extensions.triggerAction',{id:new URL(h.browser.worker.url()).host,targetId:target.targetId})}finally{await cdp.detach()}
}
async function grants(){return h.browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants?.length??0)}
try{
 await new Promise(done=>site.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${site.address().port}`
 h=await startIsolatedModelRun({repo,origin,startUrl:origin+'/health',artifacts,goal:'Synthetic native page authorization',programs:{list:"console.log(await tools.browser_list_tabs({}));console.log('AUTHORIZED_LIST_READ');"},guardSource:"ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','browser_list_tabs'].includes(exec.name)?'Only list reads allowed in this fixture':undefined));"})
 const page=h.browser.target;await page.goto(origin+'/pinned')
 const id=await h.browser.worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url)?.id,page.url());assert.ok(Number.isSafeInteger(id))
 await h.browser.worker.evaluate(tabId=>chrome.tabs.update(tabId,{pinned:true}),id)
 phase='native-pinned-failure';await nativeAction(page)
 const section=h.browser.panel.locator('.page-access-diagnostics');await section.locator('[role="status"]').filter({hasText:'取消固定'}).waitFor({timeout:10000})
 assert.equal(await section.getAttribute('open'),'');assert.equal(await grants(),0)
 phase='read-only-refresh';await section.getByRole('button',{name:'刷新已授权页面',exact:true}).click();await section.getByText('页面列表已刷新。',{exact:true}).waitFor();assert.equal(await grants(),0);assert.ok((await section.textContent()).includes('0 个已授权页面'))
 phase='native-unpin-and-authorize';await h.browser.worker.evaluate(tabId=>chrome.tabs.update(tabId,{pinned:false}),id);await h.browser.authorizePage(page)
 await section.locator('[role="status"]').filter({hasText:'上次工具栏授权已完成'}).waitFor();assert.equal(await grants(),1)
 const groups=await h.browser.worker.evaluate(async tabId=>{const tab=await chrome.tabs.get(tabId);const group=await chrome.tabGroups.get(tab.groupId);return{title:group.title,groupId:tab.groupId}},id);assert.equal(groups.title,'DSH 控制')
 await section.getByRole('button',{name:'刷新已授权页面',exact:true}).click();await section.getByText('页面列表已刷新。',{exact:true}).waitFor();assert.ok((await section.textContent()).includes('1 个已授权页面'));assert.equal(await grants(),1)
 phase='model-list';await h.browser.panel.bringToFront();const events=await h.turn('list','')
 const text=events.filter(e=>e.type==='tool/ptc-dispatch'&&e.data.name==='browser_list_tabs').flatMap(e=>e.data.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');assert.ok(text.includes('"authorized": true'));assert.ok(text.includes('"scope": "authorized-tabs"'));assert.ok(text.includes(origin+'/pinned'));assert.equal(writes,0)
 await h.browser.panel.setViewportSize({width:360,height:800});assert.ok(await h.browser.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await h.browser.panel.screenshot({path:join(artifacts,'panel.png')})
 const result={passed:true,version,realHost:true,isolatedChrome:true,browserVersion:h.browser.browserVersion,scriptedModel:true,realModel:false,nativePinnedFailureVisible:true,failureDidNotGrantAccess:true,readOnlyRefreshDidNotGrantAccess:true,nativeUnpinRetryGroupedPage:true,authorizedListExplicit:true,serverWrites:writes,originalHostUntouched:true,hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),backgroundBundleSha256:createHash('sha256').update(await readFile(join(repo,'extensions/dsh-browser/dist/background.js'))).digest('hex'),evidenceDirectory:artifacts.slice(base.length+1)}
 await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2),{mode:0o600});await writeFile(join(base,'scripted.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result))
}catch(error){await writeFile(join(artifacts,'failure.json'),JSON.stringify({passed:false,phase,errorName:error.name},null,2),{mode:0o600});throw error}finally{await h?.close();await new Promise(done=>site.close(done))}
