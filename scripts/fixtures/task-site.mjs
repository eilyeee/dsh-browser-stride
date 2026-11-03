import { createServer } from 'node:http'

/** Synthetic business state belongs to this test server, never model output. */
export async function startTaskSite({ hostname = '127.0.0.1' } = {}) {
  let state = { enabled: false, saved: false }
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    if (request.url === '/state' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(state)); return
    }
    if (request.url === '/save' && request.method === 'POST') {
      try {
        if (request.headers.origin !== origin) throw new Error('origin')
        let body = ''
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('size') }
        const input = JSON.parse(body)
        if (typeof input.enabled !== 'boolean') throw new Error('input')
        state = { enabled: input.enabled, saved: true }
        response.end('{}')
      } catch { response.writeHead(400); response.end() }
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地设置测试</title>
      <h1>测试设置</h1><form><label><input type="checkbox" id="setting">测试开关</label>
      <button>保存设置</button></form><p id="status" role="status"></p>
      <script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();
      const reply=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({enabled:document.querySelector('#setting').checked})});
      document.querySelector('#status').textContent=reply.ok?'设置已保存':'保存失败'};</script></html>`)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://${hostname}:${server.address().port}`
  return { origin, url: `${origin}/settings`, state: () => ({ ...state }), close: () => new Promise(resolve => server.close(resolve)) }
}
