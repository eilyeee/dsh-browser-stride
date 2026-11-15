import {createServer} from 'node:http'

export const SCROLL_CASES=['inner-down','inner-bottom','inner-boundary','inner-rollback','inner-replace','viewport']
export async function startScrollSite(){
  const saves=[]
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store')
    const url=new URL(req.url,'http://127.0.0.1')
    if(url.pathname==='/health'){res.end('ok');return}
    if(url.pathname==='/save'&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048){res.writeHead(413);res.end();return}}
      let value;try{value=JSON.parse(body)}catch{res.writeHead(400);res.end();return}
      if(!SCROLL_CASES.includes(value.case)){res.writeHead(400);res.end();return}
      saves.push(value);res.end('ok');return
    }
    const kind=url.searchParams.get('case')
    if(url.pathname!=='/fixture'||!SCROLL_CASES.includes(kind)){res.writeHead(404);res.end();return}
    res.setHeader('content-type','text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Nested scroll fixture</title>
<style>body{font:16px sans-serif;margin:24px;min-height:2400px}#outer{height:400px;overflow-y:auto;border:1px solid;width:600px}#inner{height:200px;overflow-y:auto;width:500px}#content{height:1000px}#item{position:sticky;top:0}#outer-space{height:1600px}#save{position:fixed;bottom:20px;right:20px}</style>
<main><h1>Synthetic nested list</h1><section id="outer"><div id="inner"><div id="content"><button id="item">List item</button><p>Local synthetic list; scroll position is the only goal.</p></div></div><div id="outer-space"></div></section><button id="save">Save</button><p id="status">No save requested</p></main>
<script>
const kind=${JSON.stringify(kind)},inner=document.querySelector('#inner');window.scrollEvents=0;
if(kind==='inner-boundary')inner.scrollTop=800;
inner.addEventListener('scroll',()=>{
 window.scrollEvents++;
 if(kind==='inner-rollback'&&inner.scrollTop!==0)inner.scrollTop=0;
 if(kind==='inner-replace'&&inner.isConnected){const replacement=inner.cloneNode(true);inner.replaceWith(replacement)}
});
document.querySelector('#save').onclick=async()=>{await fetch('/save',{method:'POST',body:JSON.stringify({case:kind})});document.querySelector('#status').textContent='Saved'};
</script>`)
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  const origin='http://127.0.0.1:'+server.address().port
  return {origin,url:kind=>origin+'/fixture?case='+kind,state:()=>({saves:[...saves]}),close:()=>new Promise(done=>server.close(done))}
}
