// Controlled widget shapes; no framework internals or business-site content.
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'

export async function startWidgetSite() {
  const choice = 'Channel-' + randomBytes(4).toString('hex')
  const writes = []
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return }
    if (req.url === '/state') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({writes})); return }
    if (req.url === '/save' && req.method === 'POST') {
      let raw=''; for await(const part of req)raw+=part
      writes.push(JSON.parse(raw))
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({saved:true})); return
    }
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Synthetic custom widgets</title>
<style>body{font:16px sans-serif;margin:30px}.el-select-dropdown{background:#fff;border:1px solid #888;width:280px;padding:8px}
li{padding:8px;cursor:pointer}.is-disabled{color:#999}.selected{background:#ddeeff}[hidden]{display:none!important}</style>
<main><h1>Channel settings</h1><p id="route">Route: pending</p><div role="dialog" aria-label="Settings">
<label>Channel <input readonly aria-label="Channel" id="choice"></label>
<label>Legacy picker <input readonly aria-label="Legacy picker" id="legacy"></label>
<button id="save">Save settings</button><p id="status">Not saved</p></div></main>
<div class="el-select-dropdown" hidden><ul class="el-select-dropdown__list">
<li class="el-select-dropdown__item" data-value="skip">Other channel</li>
<li class="el-select-dropdown__item" data-value="target">${choice}</li>
<li class="el-select-dropdown__item is-disabled">Unavailable channel</li></ul></div>
<script>
const popup=document.querySelector('.el-select-dropdown'),input=document.querySelector('#choice'),legacy=document.querySelector('#legacy');
window.widgetKeyEvents=[];window.widgetOptionClicks=0;window.widgetRouteChanges=0;
input.onclick=()=>{popup.hidden=!popup.hidden};
for(const option of popup.querySelectorAll('li'))option.onclick=()=>{
 if(option.classList.contains('is-disabled'))return;
 window.widgetOptionClicks++;input.value=option.textContent;
 popup.querySelectorAll('li').forEach(el=>el.classList.toggle('selected',el===option));popup.hidden=true;
};
legacy.onkeydown=e=>{window.widgetKeyEvents.push({key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,trusted:e.isTrusted});
 if(e.keyCode===40)legacy.value='Legacy next';if(e.keyCode===27)legacy.value='';};
document.querySelector('#save').onclick=async()=>{
 if(!input.value){document.querySelector('#status').textContent='Choose a channel';return;}
 const response=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channel:input.value})});
 if(response.ok)document.querySelector('#status').textContent='Saved '+input.value;
};
function renderRoute(){window.widgetRouteChanges++;document.querySelector('#route').textContent='Route: '+(location.hash.slice(1)||'/first');}
addEventListener('hashchange',renderRoute);renderRoute();
</script>`)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin=`http://stride-widgets.test:${server.address().port}`
  return {origin,url:origin+'/#/first',second:origin+'/#/second',choice,state:()=>({writes:[...writes]}),
    close:()=>new Promise(resolve=>server.close(resolve))}
}
