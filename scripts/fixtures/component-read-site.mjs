import {createServer} from 'node:http'

export const COMPONENT_READ_CASES=['requirements','privacy','recovery','slots','inspector']
export const COMPONENT_SETTLE_CASES=['settle-delayed','settle-late-root','settle-continuous']
export const SNAPSHOT_BASE_CASES=['base-current','base-region','base-clipped']
export const COMPONENT_READ_SECRETS=['synthetic-component-pass','synthetic-component-code']
export async function startComponentReadSite(){
  let writes=0
  const server=createServer((req,res)=>{
    res.setHeader('cache-control','no-store');const url=new URL(req.url,'http://127.0.0.1')
    if(req.method!=='GET'){writes++;res.writeHead(405);res.end();return}
    if(url.pathname==='/health'){res.end('ok');return}
    const kind=url.searchParams.get('case');if(url.pathname!=='/fixture'||![...COMPONENT_READ_CASES,...COMPONENT_SETTLE_CASES,...SNAPSHOT_BASE_CASES].includes(kind)){res.writeHead(404);res.end();return}
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Component readonly fixture</title>
<style>body{font:16px sans-serif;margin:24px}#widget{display:block}#header{height:20px}#customer{margin-top:0}</style>
<main><h1>Synthetic component document</h1><p id="requirements">Wrong document spacing: 0px</p><div id="header"></div><div id="customer">Document copy</div><div id="properties">Layer: Wrong document<br>width: 999px</div><div id="widget"></div><button id="save">Save</button></main>
<script>
function appendMarkup(root,html){const template=document.createElement('template');template.innerHTML=html;root.append(template.content)}
const kind=${JSON.stringify(kind)};window.pageWrites=0;document.querySelector('#save').onclick=()=>{window.pageWrites++;fetch('/write',{method:'POST'})};
const shell=document.querySelector('#widget').attachShadow({mode:'open'});shell.innerHTML='<div id="inner"></div>';const host=shell.querySelector('#inner'),root=host.attachShadow({mode:'open'});window.readRoot=root;
root.innerHTML='<style>:host{display:block}p{margin:0}#header{height:20px;margin:0}#customer{margin-top:24px;height:40px}input{display:block;margin-top:10px}#properties p{display:block}</style><p id="requirements">Requirement spacing: 24px. Keep the customer information gap.</p><div id="header">Header</div><div id="customer">Customer information</div><input readonly aria-label="Anchor"><div id="nested"></div><div id="properties"><p>Layer: Container</p><p>width: 320px</p><p>height: 48px</p><p>Border radius: 8px</p></div>';
root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<p>Nested component note</p>';
for(const field of root.querySelectorAll('input'))for(const event of ['input','change'])field.addEventListener(event,()=>window.pageWrites++);
if(kind==='privacy'){
 appendMarkup(root,'<input type="password" aria-label="Password"><label for="code">验证码</label><input id="code"><p><span>synthetic-</span><span>component-pass</span></p><p>synthetic-component-code</p>');
 root.querySelector('[type="password"]').value=${JSON.stringify(COMPONENT_READ_SECRETS[0])};root.querySelector('#code').value=${JSON.stringify(COMPONENT_READ_SECRETS[1])};
}
if(kind==='recovery')appendMarkup(root,'<p class="duplicate">One</p><p class="duplicate">Two</p>');
if(kind==='slots'){
 appendMarkup(root,'<slot name="note"><p>UNUSED_FALLBACK</p></slot><slot name="empty"><p>Default note</p></slot><p style="display:none">HIDDEN_PROSE</p><p style="opacity:0">FADED_PROSE</p>');
 host.innerHTML='<span slot="note">Assigned <b>visible</b> note</span><span>UNASSIGNED_PROSE</span>';
}
if(kind.startsWith('settle-')){
 appendMarkup(root,'<button id="start">Start updates</button><input readonly aria-label="State" value="INITIAL"><div id="late"></div>');
 window.componentStarts=0;window.componentTicks=0;window.componentFinished=false;
 root.querySelector('#start').onclick=()=>{
  window.componentStarts++;
  const state=root.querySelector('[aria-label="State"]');state.setAttribute('value','COMPONENT_LOADING');
  if(kind==='settle-continuous')setInterval(()=>{window.componentTicks++;state.setAttribute('value','TICK_'+window.componentTicks)},20);
  else{
   let target=root;
   if(kind==='settle-late-root')setTimeout(()=>{target=root.querySelector('#late').attachShadow({mode:'open'});target.innerHTML='<p>Late root loading</p>'},30);
   for(const ms of [40,80,120])setTimeout(()=>{target.querySelector('p').textContent='Component still loading '+ms},ms);
   setTimeout(()=>{
    window.componentTicks++;window.componentFinished=true;
    target.querySelector('p').textContent='Component ready: 24px';state.setAttribute('value','COMPONENT_READY');
   },160);
  }
 };
}
if(kind.startsWith('base-')){
 document.querySelector('main').insertAdjacentHTML('afterbegin','<section class="scope" id="left">Requirement: retain the customer gap.</section><section class="scope" id="right">Requirement: retain the customer gap.</section>');
 if(kind==='base-clipped'){
  document.querySelector('main').insertAdjacentHTML('beforeend',Array.from({length:60},(_,i)=>'<select aria-label="Size '+i+'">'+Array.from({length:20},(_,j)=>'<option>Choice '+i+' '+j+' '+('X'.repeat(100))+'</option>').join('')+'</select>').join(''));
 }
}
window.componentReadFixtureReady=true;
</script>`)
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port
  return {origin,url:kind=>origin+'/fixture?case='+kind,state:()=>({writes}),close:()=>new Promise(done=>server.close(done))}
}
