// Controlled DOM fixture for the section:first-of-type spacing regression.
import { createServer } from 'node:http'

export async function startLayoutSite() {
  const server = createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return }
    if (!['/broken', '/fixed', '/personal'].includes(req.url)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>Synthetic layout ${req.url}</title>
<style>*{box-sizing:border-box;margin:0}body{font:16px/24px sans-serif}main{width:600px;margin:40px}
.hero{height:80px;background:#ddd}.card{padding:20px;background:#eef}.card+.card{margin-top:24px}
${req.url === '/fixed' ? '.hero+.card' : '.card:first-of-type'}{margin-top:50px}#hidden{display:none}</style>
<main><section class="hero">Synthetic introduction</section><section class="card customer-card"><h2>Customer details</h2><input value="synthetic-private-value"></section><section class="card next-card">Other details</section><div id="hidden">Hidden</div></main>
<script>window.syntheticWrites=0;addEventListener('input',()=>syntheticWrites++);addEventListener('pointerdown',()=>syntheticWrites++)</script>`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://stride-layout.test:${server.address().port}`
  return { origin, url: `${origin}/broken`, fixed: `${origin}/fixed`, close: () => new Promise(done => server.close(done)) }
}
