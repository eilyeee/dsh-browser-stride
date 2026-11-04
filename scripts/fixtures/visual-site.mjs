// Synthetic canvas/layer inspector. Never loads third-party design data.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
export async function startVisualSite() {
  const nonce = randomBytes(4).toString('hex')
  const designs = {
    a: { layer: `Synthetic_background_${nonce}`, textLayer: `Synthetic_text_Medium_${nonce}`, color: '#2563eb', radius: 14,
      width: 320, height: 144, text: { width: 126, height: 24, fontSize: 18, fontWeight: 400, lineHeight: 24, color: '#ffffff' },
      box: [.22, .28, .32, .18], sample: [.26, .31], center: [.38, .37] },
    b: { layer: `Synthetic_other_background_${nonce}`, textLayer: `Synthetic_other_text_${nonce}`, color: '#16a34a', radius: 22,
      width: 260, height: 120, text: { width: 104, height: 22, fontSize: 16, fontWeight: 600, lineHeight: 22, color: '#ffffff' },
      box: [.50, .54, .26, .18], sample: [.53, .59], center: [.63, .63] },
  }
  let selection, clicks = 0, selections = []
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return }
    if (req.url === '/selected' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1000) { res.writeHead(413); res.end(); return } }
      try {
        const value = JSON.parse(text), design = designs[value.design]
        if (design && [design.layer, design.textLayer].includes(value.layer)) {
          selection = value.layer; clicks++; selections.push({ design: value.design, layer: value.layer })
        }
      } catch {}
      res.end('ok'); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (req.url === '/personal') {
      res.end('<!doctype html><title>Uncontrolled synthetic human page</title><body style="background:#d9480f"><h1>Uncontrolled human tab</h1><p>This page must never be captured or clicked.</p><script>window.syntheticClicks=0;addEventListener("pointerdown",()=>syntheticClicks++)</script>')
      return
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>Synthetic canvas design</title>
<style>body{margin:0;background:#f6f7fb;min-height:180vh}canvas{position:fixed;inset:0}aside{position:fixed;right:16px;top:20px;width:210px;white-space:pre-wrap;font:16px Arial;background:white;padding:12px;border:1px solid #ddd}nav{position:fixed;left:32px;top:90px}</style>
<canvas aria-label="Synthetic design canvas"></canvas><nav><button id="design-a">Design A</button><button id="design-b">Design B</button><span id="current-design">Design A</span></nav><aside id="properties">Select a design layer</aside>
<script>
const designs=${JSON.stringify(designs)},canvas=document.querySelector('canvas'),panel=document.querySelector('aside');let current='a';
function paint(){const d=designs[current],w=innerWidth,h=innerHeight;canvas.width=w*devicePixelRatio;canvas.height=h*devicePixelRatio;canvas.style.width=w+'px';canvas.style.height=h+'px';const c=canvas.getContext('2d');c.scale(devicePixelRatio,devicePixelRatio);c.fillStyle='#f6f7fb';c.fillRect(0,0,w,h);c.fillStyle='#172033';c.font='28px Arial';c.fillText('Synthetic design '+current.toUpperCase(),32,70);c.fillStyle=d.color;c.beginPath();c.roundRect(w*d.box[0],h*d.box[1],w*d.box[2],h*d.box[3],d.radius);c.fill();c.fillStyle=d.text.color;c.font=d.text.fontWeight+' '+d.text.fontSize+'px Arial';c.textAlign='center';c.textBaseline='middle';c.fillText('Inspect style',w*d.center[0],h*d.center[1])}
function switchDesign(){current=location.hash==='#design-b'?'b':'a';document.title='Synthetic canvas design '+current.toUpperCase();document.querySelector('#current-design').textContent='Design '+current.toUpperCase();panel.textContent='Select a design layer';paint()}
document.querySelector('#design-a').onclick=()=>{location.hash='design-a'};document.querySelector('#design-b').onclick=()=>{location.hash='design-b'};addEventListener('hashchange',switchDesign);switchDesign();addEventListener('resize',paint);
canvas.addEventListener('pointerdown',e=>{const d=designs[current],x=e.clientX/innerWidth,y=e.clientY/innerHeight;if(x<d.box[0]||x>d.box[0]+d.box[2]||y<d.box[1]||y>d.box[1]+d.box[3])return;const isText=Math.abs(x-d.center[0])<=.07&&Math.abs(y-d.center[1])<=.02;const layer=isText?d.textLayer:d.layer;panel.textContent=isText?'Layer: '+layer+'\\nFont family: Synthetic-Medium\\nfont-size: '+d.text.fontSize+'px\\nfont-weight: '+d.text.fontWeight+'\\ncolor: '+d.text.color+'\\nline-height: '+d.text.lineHeight+'px\\nwidth: '+d.text.width+'px\\nheight: '+d.text.height+'px':'Layer: '+layer+'\\nFill: '+d.color+'\\nBorder radius: '+d.radius+'px\\nwidth: '+d.width+'px\\nheight: '+d.height+'px';fetch('/selected',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({design:current,layer})})})
</script>`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://stride-visual.test:${server.address().port}`
  return { origin, url: `${origin}/design`, ...designs.a, designs,
    state: () => ({ selection: selection ?? null, clicks }), history: () => [...selections], reset: () => { selection = undefined; clicks = 0; selections = [] },
    close: () => new Promise(done => server.close(done)) }
}
