import {createServer} from 'node:http'

export const SHADOW_CASES=['native','readonly','replace','retarget','privacy','scroll']
export const SHADOW_SYNTHETIC_SECRETS=['synthetic-shadow-pass','synthetic-shadow-code']
export async function startShadowSite(){
  const saves=[]
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');const url=new URL(req.url,'http://127.0.0.1')
    if(url.pathname==='/health'){res.end('ok');return}
    if(url.pathname==='/save'&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048){res.writeHead(413);res.end();return}}
      let value;try{value=JSON.parse(body)}catch{res.writeHead(400);res.end();return}
      if(!SHADOW_CASES.includes(value.case)){res.writeHead(400);res.end();return}
      saves.push(value);res.end('ok');return
    }
    const kind=url.searchParams.get('case')
    if(url.pathname!=='/fixture'||!SHADOW_CASES.includes(kind)){res.writeHead(404);res.end();return}
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Shadow native control fixture</title>
<style>body{font:16px sans-serif;margin:24px;min-height:2000px}#component,#other{display:block;margin:20px 0}#outer{height:400px;overflow-y:auto}#outer-space{height:1000px}</style>
<main><h1>Synthetic component form</h1><span id="name-label">Outside wrong name</span><input id="field" aria-label="Outside field" value="keep"><div id="outer"><div id="component"></div><div id="outer-space"></div></div><div id="other"></div><label>Note<input id="note" aria-label="Note"></label><button id="save">Save note</button><p id="status">Not saved</p><p id="mirror"></p></main>
<script>
const kind=${JSON.stringify(kind)};window.closedClicks=0;window.fieldEvents={input:0,change:0};window.framework={name:'old',size:'Small',checked:false};
const closed=document.createElement('div');document.body.append(closed);const locked=closed.attachShadow({mode:'closed'});locked.innerHTML='<button>Closed action</button>';locked.querySelector('button').onclick=()=>window.closedClicks++;
function makeComponent(host){
 const shell=host.attachShadow({mode:'open'});shell.innerHTML='<div id="nested"></div>';const root=shell.querySelector('#nested').attachShadow({mode:'open'});
 root.innerHTML='<style>label,input,select,button{display:block;margin:8px}#scroller{height:200px;overflow-y:auto}#content{height:1000px}#row{position:sticky;top:0}</style>'+(kind==='scroll'?'<div id="scroller"><div id="content"><button id="row">Row</button></div></div>':'<span id="name-label">Name</span><input id="field" aria-labelledby="name-label" value="old"><label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select><label><input type="checkbox" id="enabled">Enabled</label><button id="component-save">Save component</button>');
 if(kind==='scroll')return {host,root};
 const field=root.querySelector('#field');field.addEventListener('input',()=>window.fieldEvents.input++);field.addEventListener('change',()=>window.fieldEvents.change++);
 host.addEventListener('input',()=>{window.framework={name:field.value,size:root.querySelector('#size').value,checked:root.querySelector('#enabled').checked}});
 root.querySelector('#component-save').onclick=()=>save('component');
 return {host,root,field};
}
window.currentComponent=makeComponent(document.querySelector('#component'));
if(kind==='readonly')currentComponent.host.setAttribute('aria-readonly','true');
if(kind==='replace')currentComponent.field.addEventListener('input',()=>{const next=document.createElement('div');next.id='component';currentComponent.host.replaceWith(next);window.currentComponent=makeComponent(next)},{once:true});
if(kind==='retarget'){
 const other=document.querySelector('#other').attachShadow({mode:'open'});other.innerHTML='<span id="name-label">Name</span>';
 currentComponent.field.addEventListener('input',()=>other.append(currentComponent.field),{once:true});
}
if(kind==='privacy'){
 const root=currentComponent.root;root.insertAdjacentHTML('beforeend','<input type="password" aria-label="Password"><label for="code">验证码</label><input id="code">');
 root.querySelector('[type="password"]').value=${JSON.stringify(SHADOW_SYNTHETIC_SECRETS[0])};root.querySelector('#code').value=${JSON.stringify(SHADOW_SYNTHETIC_SECRETS[1])};
 document.querySelector('#mirror').textContent=${JSON.stringify(SHADOW_SYNTHETIC_SECRETS.join(' '))};
}
async function save(mode){
 await fetch('/save',{method:'POST',body:JSON.stringify({case:kind,mode,...window.framework,note:document.querySelector('#note').value,outside:document.querySelector('#field').value})});
 document.querySelector('#status').textContent='Saved '+mode;
}
document.querySelector('#save').onclick=()=>save('note');
</script>`)
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port
  return {origin,url:kind=>origin+'/fixture?case='+kind,state:()=>({saves:[...saves]}),close:()=>new Promise(done=>server.close(done))}
}
