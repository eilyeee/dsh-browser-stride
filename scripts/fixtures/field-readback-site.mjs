import {createServer} from 'node:http'

/** Local-only edits: observe the actual field identity and count Save requests. */
export const READONLY_FIELD_CASES=['select-readonly','select-readonly-ancestor','input-readonly','textarea-readonly','editor-readonly','select-lock-input','select-lock-change','select-lock-late']
export const EDITOR_READBACK_CASES=['editor-rollback','editor-rollback-microtask','editor-rollback-timer','editor-cancel','editor-retarget','editor-ok','editor-append-ok','editor-format-ok','editor-multiline-ok']
export const FIELD_READBACK_CASES=['select-input','select-change','select-late','input-late','textarea-late','editor-late','select-ok','input-ok',...READONLY_FIELD_CASES,...EDITOR_READBACK_CASES]
export async function startFieldReadbackSite(){
  const saves=[]
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store')
    const url=new URL(req.url,'http://127.0.0.1')
    if(url.pathname==='/health'){res.end('ok');return}
    if(url.pathname==='/save'&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048){res.writeHead(413);res.end();return}}
      let value;try{value=JSON.parse(body)}catch{res.writeHead(400);res.end();return}
      if(!FIELD_READBACK_CASES.includes(value.case)||typeof value.value!=='string'){res.writeHead(400);res.end();return}
      saves.push(value);res.setHeader('content-type','application/json');res.end('{"saved":true}');return
    }
    const kind=url.searchParams.get('case')
    if(url.pathname!=='/fixture'||!FIELD_READBACK_CASES.includes(kind)){res.writeHead(404);res.end('not found');return}
    const field=kind.startsWith('select')?'<select id="field" aria-label="Field"><option>Small</option><option>Large</option></select>':
      kind.startsWith('textarea')?'<textarea id="field" aria-label="Field"></textarea>':
      kind.startsWith('editor')?'<div id="field" contenteditable="true" tabindex="0" role="textbox" aria-label="Field"></div>':
      '<input id="field" aria-label="Field">'
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Field readback fixture</title>
<style>body{font:16px sans-serif;margin:24px}#field{display:block;min-width:220px;min-height:30px;margin:16px 0}</style>
<main><h1>Synthetic field settings</h1><section id="field-group">${field}</section>${kind==='editor-retarget'?'<div id="other" contenteditable="true" role="textbox" tabindex="0" aria-label="Other editor">untouched</div>':''}<label>Note<input id="note" aria-label="Note"></label><button id="save">Save</button><p id="status">Not saved</p></main>
<script>
const kind=${JSON.stringify(kind)},field=document.querySelector('#field');let changed=false;
if(kind.startsWith('editor-')&&!['editor-late','editor-readonly'].includes(kind))field.textContent='old';
if(kind.includes('readonly')){
 if(kind==='select-readonly-ancestor')document.querySelector('#field-group').setAttribute('aria-readonly','true');
 else if(kind==='input-readonly')field.readOnly=true;
 else field.setAttribute('aria-readonly','true');
 if(field.isContentEditable)field.textContent='old';else if(!(field instanceof HTMLSelectElement))field.value='old';
}
window.fieldEvents={input:0,change:0};
for(const event of ['input','change'])field.addEventListener(event,()=>window.fieldEvents[event]++);
function retarget(){if(changed)return;changed=true;if(kind==='select-input')field.options[1].text='Different option';else field.setAttribute('aria-label','Other record');}
if(kind.startsWith('editor-rollback'))field.addEventListener('input',()=>{
 const rollback=()=>{field.textContent='old'};
 if(kind.endsWith('microtask'))queueMicrotask(rollback);else if(kind.endsWith('timer'))setTimeout(rollback,0);else rollback();
});
else if(kind==='editor-cancel')field.addEventListener('beforeinput',event=>event.preventDefault());
else if(kind==='editor-retarget')field.addEventListener('beforeinput',()=>{
 const other=document.querySelector('#other');other.focus();const range=document.createRange();range.selectNodeContents(other);getSelection().removeAllRanges();getSelection().addRange(range);
});
else if(kind==='editor-format-ok')field.addEventListener('input',()=>{const text=field.textContent;field.replaceChildren(Object.assign(document.createElement('strong'),{textContent:text}))});
else if(kind.includes('lock-'))field.addEventListener(kind==='select-lock-change'?'change':'input',()=>{
 const lock=()=>field.setAttribute('aria-readonly','true');if(kind==='select-lock-late')queueMicrotask(lock);else lock();
});
else if(kind==='select-input')field.addEventListener('input',retarget);
else if(kind==='select-change')field.addEventListener('change',retarget);
else if(kind.endsWith('-late'))field.addEventListener('input',()=>queueMicrotask(retarget));
document.querySelector('#save').onclick=async()=>{
 const value=field instanceof HTMLSelectElement?field.selectedOptions[0].text:field.isContentEditable?field.innerText.replace(/\\r\\n?/g,'\\n').replace(/\\u00a0/g,' '):field.value;
 const reply=await fetch('/save',{method:'POST',body:JSON.stringify({case:kind,value,note:document.querySelector('#note').value})});
 document.querySelector('#status').textContent=reply.ok?'Saved':'Save failed';
};
</script>`)
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const origin='http://127.0.0.1:'+server.address().port
  return {origin,url:kind=>origin+'/fixture?case='+kind,state:()=>({saves:[...saves]}),close:()=>new Promise(done=>server.close(done))}
}
