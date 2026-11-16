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
import {COMPONENT_READ_CASES,COMPONENT_SETTLE_CASES,SNAPSHOT_BASE_CASES,COMPONENT_READ_SECRETS,startComponentReadSite} from './fixtures/component-read-site.mjs'

const repo=resolve(import.meta.dirname,'..'),require=createRequire(join(repo,'package.json'))
const bridgeRequire=createRequire(join(repo,'packages/browser/bridge-browser/package.json'))
const cli=join(dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js')
const root=await mkdtemp(join(tmpdir(),'stride-component-reads-')),home=join(root,'home')
const version=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version,realModel=process.env.STRIDE_REAL_MODEL==='1'
const settleOnly=process.argv.includes('--settle-only'),baseOnly=process.argv.includes('--snapshot-base-only'),cases=baseOnly?SNAPSHOT_BASE_CASES:settleOnly?COMPONENT_SETTLE_CASES:COMPONENT_READ_CASES
const base=join(repo,'.stride-private/validation',baseOnly?'snapshot-bases':settleOnly?'component-settle':'component-reads',version),label=realModel?'real-model':'scripted'
await mkdir(base,{recursive:true});const artifacts=await mkdtemp(join(base,label+'-'))
await writeFile(join(base,label+'.json'),JSON.stringify({passed:false,status:'in-progress',evidenceDirectory:artifacts.slice(base.length+1)})+'\n',{mode:0o600})
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'}
for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete env[key]
const summaries=[],programs={}
const findRef=String.raw`function ref(view,label){const line=view.text.split('\n').find(line=>line.includes(label));const value=line?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];if(!value)throw Error('Missing observed '+label);return value;}`
for(const kind of cases){
  let code=`const view=await tools.browser_snapshot({});const elementRef=ref(view,'input "Anchor"');`
  if(baseOnly){
    const helpers=String.raw`function obs(v){const id=/^Observation: (obs_[a-f0-9-]+)/m.exec(v.text)?.[1];if(!id)throw Error('Missing observation');return id}function show(v){console.log({header:v.text.slice(0,1000),clipped:v.text.includes('…(truncated to the snapshot character budget)')})}`;
    code=helpers;
    if(kind==='base-current')code+=`const first=await tools.browser_snapshot({});show(first);const baseObservationId=obs(first);show(await tools.browser_snapshot({delta:true,baseObservationId}));show(await tools.browser_snapshot({delta:true,baseObservationId}));show(await tools.browser_snapshot({delta:true}));`;
    else if(kind==='base-region')code+=`let refused=false;try{await tools.browser_snapshot({region:'.scope'})}catch{refused=true}if(!refused)throw Error('Ambiguous snapshot region accepted');const first=await tools.browser_snapshot({region:'#left'});show(first);show(await tools.browser_snapshot({delta:true,baseObservationId:obs(first),region:'#right'}));`;
    else code+=`const first=await tools.browser_snapshot({});show(first);show(await tools.browser_snapshot({delta:true,baseObservationId:obs(first)}));`;
  }
  else if(kind.startsWith('settle-')){
    code=`const view=await tools.browser_snapshot({});console.log(await tools.browser_click({elementRef:ref(view,'button "Start updates"')}));console.log(await tools.browser_wait({}));`
    if(kind!=='settle-continuous')code+=`const current=await tools.browser_snapshot({});console.log(await tools.browser_get_text({elementRef:ref(current,'input "Anchor"')}));`
  }
  else if(kind==='requirements')code+=`console.log(await tools.browser_get_text({elementRef,selector:'#requirements'}));console.log(await tools.browser_measure_layout({elementRef,selector:'#customer',referenceSelector:'#header'}));`
  else if(kind==='recovery')code+=`let refused=false;try{await tools.browser_get_text({elementRef,selector:'.duplicate'})}catch{refused=true}if(!refused)throw Error('Ambiguous selector accepted');console.log(await tools.browser_get_text({elementRef,selector:'#requirements'}));`
  else if(kind==='inspector')code+=`console.log(await tools.browser_read_design_styles({elementRef,region:'#properties'}));`
  else code+=`console.log(await tools.browser_get_text({elementRef}));`
  programs[kind]=findRef+code+`console.log('COMPONENT_PROGRAM_OK');`
}
let host,browser,site,sessionId,phase='setup',events=[],cancelTimer
async function wait(check,label){const until=Date.now()+15000;while(Date.now()<until){if(await check())return;await delay(100)}throw Error('Shadow fixture timed out: '+label)}
async function rpc(method,payload){return browser.panel.evaluate(({method,payload})=>new Promise((done,fail)=>{
 const port=window.__componentReadPort??=chrome.runtime.connect({name:'dsh-panel'}),id=crypto.randomUUID()
 const timer=setTimeout(()=>{port.onMessage.removeListener(receive);fail(Error('Fixture RPC timeout'))},10000)
 function receive(message){if(message.type!=='rpc.result'||message.id!==id)return;clearTimeout(timer);port.onMessage.removeListener(receive);if(!message.ok||!message.result?.result?.ok)fail(Error('Fixture RPC rejected'));else done(message.result.result.value)}
 port.onMessage.addListener(receive);port.postMessage({type:'rpc',id,method,payload})
}),{method,payload})}
try{
  await mkdir(home);site=await startComponentReadSite()
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
async listModels(provider){return [{provider,id:'component-reads',name:'Synthetic component reads',contextWindow:128000}]}
async *stream(options){const messages=options.messages,texts=messages.map(m=>m.content?.filter(b=>b.type==='text').map(b=>b.text).join(' ')||'');
 const index=texts.findLastIndex((t,i)=>messages[i].role==='user'&&t.startsWith('COMPONENT_CASE=')),kind=texts[index]?.slice(15);
 if(!programs[kind])throw Error('No synthetic component read case');const done=messages.slice(index+1).some(m=>m.role==='tool');
 const block=done?{type:'text',text:'COMPONENT_DONE'}:{type:'tool-call',id:'component-'+kind,name:'run_code',arguments:JSON.stringify({code:programs[kind],description:'Read the observed component tree without editing'})};
 yield {type:'block-start',index:0,blockType:block.type};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:done?'stop':'tool-calls'}}}}
export const inject=['llm','tools','agents'];export function apply(ctx){${realModel?'':"ctx.on('agent/created',({agent})=>{agent.ctx.effect(()=>agent.ctx.tools.presentAs('ptc'))});ctx.effect(()=>ctx.llm.registerAdapter(['stride-component-reads'],new Scripted()));"}
 let requests=0,calls=0;ctx.on('session/event',(_s,e)=>{if(e.type==='turn/start'){requests=0;calls=0}});
 ctx.on('agent/request',(_p,next)=>{if(++requests>20)throw Error('Synthetic request budget');return next()});
 ctx.effect(()=>ctx.tools.guard(exec=>!${JSON.stringify(baseOnly?['run_code','browser_snapshot','browser_list_tabs']:['run_code','browser_snapshot','browser_measure_layout','browser_read_design_styles','browser_get_text','browser_wait','browser_list_tabs',...settleOnly?['browser_click']:[]])}.includes(exec.name)?'Only synthetic component fixture tools are allowed':exec.name.startsWith('browser_')&&++calls>20?'Synthetic browser budget exhausted':undefined));
}`,{mode:0o600})
  process.env.DSH_HOME=home;for(const key of ['DSH_EXT_TOKEN','DSH_BRIDGE_ADMIN_TOKEN','DSH_BROWSER_SESSION_WORKSPACE'])delete process.env[key]
  const net=createServer();await new Promise(done=>net.listen(0,'127.0.0.1',done));const port=net.address().port;await new Promise(done=>net.close(done))
  const patch=realModel?await readFile(process.env.STRIDE_MODEL_PATCH,'utf8'):''
  host=await startDshBackend({backend:'extension',port,repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),runtimeRoot:join(root,'runtime'),startUrl:site.url('requirements'),deferSessionCreate:true,extraPatch:patch+'\n- insert:\n    - id: component-reads-fixture\n      name: '+JSON.stringify(pathToFileURL(fixture).href)+'\n'})
  browser=await startExtensionBrowser({repoRoot:repo,benchmarkRoot:join(repo,'benchmark'),bridgeUrl:`ws://127.0.0.1:${port}/ext/bridge`,issuePairingCode:()=>host.issuePairingCode(),trustedOrigin:site.origin,chromiumArgs:settleOnly?['--disable-background-timer-throttling','--disable-renderer-backgrounding']:[]})
  await wait(async()=>typeof (await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity))?.focusedSessionId==='string','panel Session')
  sessionId=await browser.worker.evaluate(async()=>(await chrome.storage.session.get('dshTabAffinity')).dshTabAffinity.focusedSessionId)
  await rpc('bridge.taskBrief.save',{sessionId,version:0,input:{goal:'Synthetic component reads',projectPath:'',materials:[],criteria:[]}})
  if(!realModel)await rpc('session.selectModel',{sessionId,provider:'stride-component-reads',model:'component-reads'})
  for(const kind of cases){
    phase=kind;events=[];console.log(JSON.stringify({phase,realModel}))
    await browser.prepare(site.url(kind))
    assert.equal(await browser.target.evaluate(()=>window.componentReadFixtureReady),true,'Fixture setup must finish before any model turn')
    if(kind==='privacy')assert.deepEqual(await browser.target.evaluate(()=>[window.readRoot.querySelector('[type="password"]').value,window.readRoot.querySelector('#code').value]),COMPONENT_READ_SECRETS)
    if(kind==='recovery')assert.equal(await browser.target.evaluate(()=>window.readRoot.querySelectorAll('.duplicate').length),2)
    if(kind==='slots')assert.equal(await browser.target.evaluate(()=>window.readRoot.host.querySelector('[slot="note"]').textContent),'Assigned visible note')
    if(baseOnly){assert.equal(await browser.target.locator('.scope').count(),2);if(kind==='base-clipped')assert.equal(await browser.target.locator('select option').count(),1200)}
    if(settleOnly)assert.deepEqual(await browser.target.evaluate(()=>({starts:window.componentStarts,ticks:window.componentTicks,finished:window.componentFinished,state:window.readRoot.querySelector('[aria-label="State"]').value})),{starts:0,ticks:0,finished:false,state:'INITIAL'})
    await browser.bindSession(sessionId);await browser.panel.bringToFront();await host.client.followSession(sessionId)
    let started=false,finish;const done=new Promise(resolve=>{finish=resolve})
    const off=host.client.onFrame(frame=>{
      if(frame.type!=='session/event'||frame.sessionId!==sessionId)return
      const e=frame.event?.event??frame.event;if(e.type==='turn/start')started=true;if(!started)return;events.push(e)
      if(e.type==='turn/end')finish(e.data.reason.kind)
    })
    try{
      const task=kind==='requirements'?'使用 Anchor 的当前引用，在其所在树内读取 #requirements，再测量 #customer 相对 #header 的间距，报告 requirementSpacing 与 measuredGap（CSS px）。':kind==='privacy'?'使用 Anchor 的当前引用读取其所在组件正文，确认两个可识别敏感值的副本均已遮罩，不能复述任何敏感片段。':kind==='recovery'?'先使用 Anchor 当前引用和 .duplicate 做范围正文读取；如果不唯一，改用同一树的 #requirements，保持同一需求判据，报告 requirementSpacing。':kind==='slots'?'使用 Anchor 的当前引用读取组件正文，报告实际显示的插槽文字（slotText）及空插槽的默认文字（fallbackText），不要把未分配或隐藏的内容当作正文。':'使用 Anchor 当前引用和 #properties 区域调用 browser_read_design_styles，报告 width、height 和 borderRadius；只使用面板明确数值。'
      const reportFields=kind==='requirements'?'requirementSpacing、measuredGap 均为数字':kind==='recovery'?'requirementSpacing 为数字':kind==='slots'?'slotText、fallbackText 为原文字符串':kind==='inspector'?'width、height、borderRadius 为带 px 的字符串':'没有额外字段'
      const settleTask=kind==='settle-continuous'?'点击一次 Start updates 后调用一次 browser_wait；此组件持续变化，请如实报告 settled=false，不能把超时当作已稳定。不重复点击，不保存。':'点击一次 Start updates 后调用一次 browser_wait；然后重新快照，使用新 Anchor 引用读取组件正文，确认 Component ready: 24px，并报告 settled=true。'
      const baseTask=kind==='base-current'?'先取完整快照，保存它的 Observation 编号；用此编号和 delta=true 请求增量；再用相同旧编号请求一次，确认仍返回完整；最后不带编号请求 delta=true，确认返回完整。':kind==='base-region'?'先以 .scope 请求快照，确认选择器不唯一而拒绝；然后读取 #left 完整快照，复制其 Observation 编号，用该编号和 delta=true 读取 #right，确认返回完整并说明模型投影未确认。':'先取完整快照并确认字符预算截断标记；再复制它的 Observation 编号请求 delta=true，确认返回完整且说明 model-projection-not-attested。';
      const prompt=realModel?(baseOnly?`只读当前已授权的本地合成页，会话已绑定。${baseTask}仅调用 browser_snapshot（可在 run_code 中组织，不操作文件或网页）。编号应从返回正文的 Observation 行提取，不用 elementRef 或安全边界 nonce。不输入、不点击、不保存、不读其他页面。较长快照可只打印头部与截断标记的检查结果，不必打印全部正文。完成后仅返回 JSON：marker 为 COMPONENT_MODEL_DONE，goalReached 为布尔值，baselineBehaviorVerified 为布尔值，reason 为实际工具依据。`:(settleOnly?`当前是已授权的本地合成组件测试页，会话已绑定。从 browser_snapshot 开始。${settleTask}只允许点击 Start updates 一次以启动本地计时器；不输入、不点 Save、不访问文件或其他网站。读取正文必须携带当前 Anchor 引用。完成即停止。仅返回 JSON：marker 为 COMPONENT_MODEL_DONE，goalReached 为布尔值，settled 为上述实际结果，reason 为工具依据。`:`只读当前已授权的本地合成页，当前会话已绑定，从 browser_snapshot 开始，不重新绑定标签。${task}所有正文、布局和样式读取都必须带当前 Anchor 的 elementRef，不读取文档对照。不输入、不点击、不保存、不操作文件或其他网站。完成本轮指定读取后立即报告；没有观察到的信息保持未知，不补造或穷举猜测选择器。本轮仅返回 JSON：marker 为 COMPONENT_MODEL_DONE，goalReached 为布尔值，reason 为实际读取依据，${reportFields}。不要查询或补充其他任务字段。`)):'COMPONENT_CASE='+kind
      cancelTimer=setTimeout(()=>{void host.client.rpc('session.cancel',{sessionId}).catch(()=>{});finish('test-timeout')},realModel?240000:45000)
      const input=browser.panel.locator('.composer textarea');await input.fill(prompt);await input.press('Enter')
      const reason=await within(done,realModel?245000:50000,'component read turn')
      await writeFile(join(artifacts,kind+'-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600});assert.equal(reason,'completed')
      const calls=events.filter(e=>e.type==='tool/ptc-dispatch'||(e.type==='tool/call'&&e.data.name?.startsWith('browser_'))).map(e=>e.data)
      assert.equal(site.state().writes,0);assert.equal(await browser.target.evaluate(()=>window.pageWrites),0)
      assert.equal(calls.filter(c=>['browser_type','browser_select','browser_scroll',...settleOnly?[]:['browser_click']].includes(c.name)).length,0)
      const scoped=calls.filter(c=>['browser_get_text','browser_measure_layout','browser_read_design_styles'].includes(c.name))
      assert.ok(baseOnly||scoped.length>0||kind==='settle-continuous')
      for(const c of scoped){const args=typeof c.arguments==='string'?JSON.parse(c.arguments):c.arguments??c.args;assert.ok(args?.elementRef)}
      const texts=scoped.filter(c=>!c.isError).flatMap(c=>(c.content??[]).filter(b=>b.type==='text').map(b=>b.text)).join('\n')
      if(baseOnly){
        const snaps=calls.filter(c=>c.name==='browser_snapshot').map(c=>({error:c.isError,args:typeof c.arguments==='string'?JSON.parse(c.arguments):c.arguments??c.args,text:(c.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')}));
        const full=c=>!c.error&&/^Observation: obs_/m.test(c.text)&&!c.text.includes('Page change v');
        const requestedDelta=snaps.filter(c=>!c.error&&c.args.delta===true&&c.args.baseObservationId);
        assert.ok(requestedDelta.length>0);
        for(const value of requestedDelta){assert.ok(full(value));assert.ok(value.text.includes('model-projection-not-attested'))}
        if(kind==='base-current')assert.ok(snaps.some(c=>full(c)&&c.args.delta===true&&c.args.baseObservationId===undefined));
        else if(kind==='base-region')assert.ok(snaps.some(c=>c.error&&c.args.region==='.scope'));
        else assert.ok(snaps.some(c=>full(c)&&c.text.includes('…(truncated to the snapshot character budget)')));
      }else if(settleOnly){
        const clicks=calls.filter(c=>c.name==='browser_click');assert.equal(clicks.length,1);assert.equal(clicks[0].isError,false)
        const waits=calls.filter(c=>c.name==='browser_wait');assert.equal(waits.length,1);assert.equal(waits[0].isError,false)
        const clickText=clicks[0].content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
        const waitText=waits[0].content.filter(b=>b.type==='text').map(b=>b.text).join('\n')
        const state=await browser.target.evaluate(()=>({starts:window.componentStarts,ticks:window.componentTicks,finished:window.componentFinished}))
        assert.equal(state.starts,1);assert.ok(state.ticks>0)
        if(kind==='settle-continuous'){
          assert.ok(clickText.includes('did not become quiet'));assert.ok(waitText.includes('did not become quiet'));assert.equal(state.finished,false)
        }else{
          assert.ok(clickText.includes('COMPONENT_READY'),'The automatic post-click delta must see the completed component, not its loading value')
          assert.ok(waitText.includes('was quiet'));assert.ok(texts.includes('Component ready: 24px'));assert.equal(state.finished,true)
        }
      }else if(kind==='requirements'){
        const measured=scoped.find(c=>c.name==='browser_measure_layout'&&!c.isError);assert.ok(measured)
        const text=measured.content.find(b=>b.type==='text').text,layout=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1))
        assert.equal(layout.scope,'open-shadow-root');assert.equal(layout.comparison.verticalGap,24);assert.equal(layout.target.css.margin.top,'24px')
        assert.ok(texts.includes('Requirement spacing: 24px'));assert.ok(!texts.includes('Wrong document spacing'))
      }else if(kind==='privacy'){
        for(const secret of COMPONENT_READ_SECRETS)assert.ok(!JSON.stringify(events).includes(secret),'Known sensitive values must not enter model events')
        assert.ok(texts.includes('••••'))
      }else if(kind==='recovery'){
        assert.ok(scoped.some(c=>c.isError));assert.ok(texts.includes('Requirement spacing: 24px'))
      }else if(kind==='slots'){
        assert.ok(texts.includes('Assigned visible note'));assert.ok(texts.includes('Default note'))
        for(const omitted of ['UNUSED_FALLBACK','UNASSIGNED_PROSE','HIDDEN_PROSE','FADED_PROSE'])assert.ok(!texts.includes(omitted))
      }else if(kind==='inspector'){
        const found=scoped.find(c=>c.name==='browser_read_design_styles'&&!c.isError);assert.ok(found)
        const text=found.content.find(b=>b.type==='text').text,styles=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1))
        assert.equal(styles.properties.width.value,'320px');assert.equal(styles.properties.height.value,'48px');assert.equal(styles.properties.borderRadius.value,'8px')
      }
      let report
      if(realModel){
        const final=events.filter(e=>e.type==='assistant/message').flatMap(e=>e.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text)??[]).at(-1)
        report=parseMarkedModelReport(final,'COMPONENT_MODEL_DONE')
        await writeFile(join(artifacts,kind+'-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
        assert.equal(report.goalReached,true)
        if(baseOnly)assert.equal(report.baselineBehaviorVerified,true)
        if(settleOnly)assert.equal(report.settled,kind!=='settle-continuous')
        if(kind==='requirements'){assert.equal(report.requirementSpacing,24);assert.equal(report.measuredGap,24)}
        if(kind==='recovery')assert.equal(report.requirementSpacing,24)
        if(kind==='slots'){assert.equal(report.slotText,'Assigned visible note');assert.equal(report.fallbackText,'Default note')}
        if(kind==='inspector'){assert.equal(report.width,'320px');assert.equal(report.height,'48px');assert.equal(report.borderRadius,'8px')}
      }else{
        const root=events.find(e=>e.type==='tool/result')?.data.message
        assert.ok(root&&!root.isError&&JSON.stringify(root.content).includes('COMPONENT_PROGRAM_OK'))
      }
      summaries.push({case:kind,passed:true,pageWrites:0,serverWrites:0,scopedReadCalls:scoped.length,...report?{modelGoalReached:report.goalReached}:{}})
    }finally{clearTimeout(cancelTimer);off()}
  }
  await browser.panel.setViewportSize({width:360,height:800});assert.ok(await browser.panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  await browser.panel.screenshot({path:join(artifacts,'panel.png')})
  const summary={passed:true,version,scope:baseOnly?'explicit-snapshot-bases':settleOnly?'bounded-open-component-quiet':'observed-read-tree',realHost:true,isolatedChrome:true,browserVersion:browser.browserVersion,scriptedModel:!realModel,realModel,cases:summaries,originalHostUntouched:true,evidenceDirectory:artifacts.slice(base.length+1),hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex'),contentBundleSha256:createHash('sha256').update(await readFile(join(repo,'extensions/dsh-browser/dist/content.js'))).digest('hex')}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(summary))
}catch(error){
  await writeFile(join(artifacts,'failure-events.json'),JSON.stringify(events,null,2)+'\n',{mode:0o600})
  const summary={passed:false,version,phase,errorName:error.name,completedCases:summaries,evidenceDirectory:artifacts.slice(base.length+1)}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});await writeFile(join(base,label+'.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600})
  throw error
}finally{clearTimeout(cancelTimer);if(sessionId)await host?.client.rpc('session.cancel',{sessionId}).catch(()=>{});await browser?.close().catch(()=>{});await host?.close().catch(()=>{});await site?.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
