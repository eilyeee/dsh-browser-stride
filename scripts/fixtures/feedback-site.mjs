import { createServer } from 'node:http'

/** Synthetic failed persistence and rollback; never a real account. */
export async function startFeedbackSite() {
  let saves = 0
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (request.url === '/save' && request.method === 'POST') {
      saves++; response.writeHead(503); response.end('synthetic unavailable'); return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><meta charset="utf-8"><title>操作反馈测试</title>
      <h1>操作反馈测试</h1><div id="field"><label>Value<input aria-label="Value"></label></div>
      <label>Rollback<input id="rollback" aria-label="Rollback"></label>
      <button id="swap">Replace field</button><button id="save">Save</button><button id="expire">Expire login</button><p id="status"></p>
      <script>
      window.rollbackAttempts=0;
      document.querySelector('#rollback').onchange=event=>{if(event.target.value)window.rollbackAttempts++;event.target.value=''};
      document.querySelector('#swap').onclick=()=>{history.pushState({},'',location.pathname+'#replacement');document.querySelector('#field').innerHTML='<label>Value<input aria-label="Value"></label>'};
      document.querySelector('#save').onclick=async()=>{const r=await fetch('/save',{method:'POST'});document.querySelector('#status').textContent=r.ok?'保存成功':'保存失败，请稍后处理'};
      document.querySelector('#expire').onclick=()=>{history.pushState({},'',location.pathname+'#login');document.body.innerHTML='<h1>登录已失效，需要用户重新登录</h1><input type="password" aria-label="Password">'};
      </script>`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, url: origin + '/fixture', state: () => ({ saves }), close: () => new Promise(done => server.close(done)) }
}
