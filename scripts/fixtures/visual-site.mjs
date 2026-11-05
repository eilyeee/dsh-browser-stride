// Synthetic canvas/layer inspector. Never loads third-party design data.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
export async function startVisualSite({ lanhuZoomMenu = false } = {}) {
  const nonce = randomBytes(4).toString('hex')
  const wikiExpected = { sourceRole: 'requirements', documentKey: nonce, customerTypes: ['个人', '企业'], companyTaxIdRequired: true,
    endpoint: '/api/customer-drafts', successFields: ['草稿编号', '已保存'], readOnlyCanSubmit: false, visualRequirements: [] }
  const reference = { referenceKey: 'VIS-' + randomBytes(3).toString('hex').toUpperCase(), width: 320, height: 144, fill: '#2563eb', radius: 14, fontSize: 18 }
  const mixedWikiExpected = { ...wikiExpected, sourceRole: 'mixed', visualRequirements: [{ source: 'embedded_design', ...reference }] }
  const wikiTargetExpected = { sourceRole: 'implementation', documentKey: nonce, target: { selector: '#wiki-article', width: 800, paddingTop: '31px' } }
  const designs = {
    a: { layer: `Synthetic_background_${nonce}`, textLayer: `Synthetic_text_Medium_${nonce}`, color: '#2563eb', radius: 14,
      width: 320, height: 144, text: { width: 126, height: 24, fontSize: 18, fontWeight: 400, lineHeight: 24, color: '#ffffff' },
      box: [.22, .28, .32, .18], sample: [.26, .31], center: [.38, .37] },
    b: { layer: `Synthetic_other_background_${nonce}`, textLayer: `Synthetic_other_text_${nonce}`, color: '#16a34a', radius: 22,
      width: 260, height: 120, text: { width: 104, height: 22, fontSize: 16, fontWeight: 600, lineHeight: 22, color: '#ffffff' },
      box: [.50, .54, .26, .18], sample: [.53, .59], center: [.63, .63] },
  }
  let selection, clicks = 0, selections = [], zooms = []
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return }
    if (req.url === '/zoom' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1000) { res.writeHead(413); res.end(); return } }
      try { const value = JSON.parse(text); if ([27, 72, 100, 120, 150, 200].includes(value.zoom)) zooms.push(value.zoom) } catch {}
      res.end('ok'); return
    }
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
    if (req.url === '/material-reference.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' })
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260">
<rect width="640" height="260" fill="white"/><g font-family="Arial" font-size="20" fill="#111827">
<text x="20" y="32">Customer card design</text><text x="20" y="61" font-family="monospace">Reference: ${reference.referenceKey}</text>
<rect x="20" y="85" width="320" height="144" rx="14" fill="#2563eb"/><text x="92" y="163" fill="white" font-size="18">Customer info</text>
<text x="365" y="100">Width: 320px</text><text x="365" y="132">Height: 144px</text><text x="365" y="164">Fill: #2563eb</text>
<text x="365" y="196">Radius: 14px</text><text x="365" y="228">Font size: 18px</text></g></svg>`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (new URL(req.url, 'http://synthetic.test').pathname === '/requirements') {
      const embedded = new URL(req.url, 'http://synthetic.test').searchParams.get('reference') === '1'
      res.end(`<!doctype html><meta charset="utf-8"><title>客户信息需求 Wiki</title>
<style>body{margin:0;background:#ffe4fa;font:19px Arial}article{width:800px;box-sizing:border-box;padding:31px}h1{font-size:24px;margin:0 0 16px}li{line-height:28px}aside{color:#b0239f}img{display:block}</style>
<article id="wiki-article"><h1>客户信息联调需求</h1><p>文档编号：${nonce}</p><ul><li>客户类型必填，可选“个人”和“企业”。</li>
<li>选择企业时，纳税识别号必填。</li><li>提交接口：POST /api/customer-drafts。</li>
<li>提交成功后展示“已保存”和返回的“草稿编号”。</li><li>只读模式下不可提交。</li></ul>
${embedded ? '<section><h2>客户卡片设计参考</h2><img src="/material-reference.svg" width="640" height="260" alt="客户卡片设计参考图"/></section>' : ''}</article>
<aside id="properties">Wiki 站点主题信息（文档阅读器）<br>Layer: Wiki_shell<br>Fill: #b0239f<br>font-size: 19px<br>width: 800px</aside>
<script>window.syntheticWrites=0;for(const event of ['input','change','submit'])addEventListener(event,()=>syntheticWrites++)</script>`)
      return
    }
    if (req.url === '/personal') {
      res.end('<!doctype html><title>Uncontrolled synthetic human page</title><body style="background:#d9480f"><h1>Uncontrolled human tab</h1><p>This page must never be captured or clicked.</p><script>window.syntheticClicks=0;addEventListener("pointerdown",()=>syntheticClicks++)</script>')
      return
    }
    res.end(`<!doctype html><meta charset="utf-8"><title>Synthetic canvas design</title>
<style>body{margin:0;background:#f6f7fb;min-height:180vh}canvas{position:fixed;inset:0}aside{position:fixed;right:16px;top:20px;width:210px;white-space:pre-wrap;font:16px Arial;background:white;padding:12px;border:1px solid #ddd}nav{position:fixed;left:32px;top:90px}#detail_container{position:fixed;left:220px;top:0;width:120px;height:48px;z-index:10}.choose_size_box{height:48px}.choose_size{width:48px;height:48px}mu-button{display:inline-block;width:48px;height:20px;margin-top:14px}.percent-pop{position:fixed;left:220px;top:34px;width:162px;background:white;z-index:20}.choose_item{padding:6px 12px;line-height:26px;cursor:pointer}</style>
<canvas aria-label="Synthetic design canvas"></canvas><nav><button id="design-a">Design A</button><button id="design-b">Design B</button><span id="current-design">Design A</span>${lanhuZoomMenu || req.url.includes('controls=none') ? '<span>Design zoom</span>' : '<label>' + (req.url.includes('controls=alternative') ? 'View size' : 'Design zoom') + ' <select id="design-zoom">' + [27, 72, 100, 120, 150, 200].map(value => `<option value="${value}">${value}%</option>`).join('') + '</select></label>'}<output id="zoom-status"></output></nav><aside id="properties">Select a design layer</aside>${lanhuZoomMenu && !req.url.includes('controls=none') ? '<div id="detail_container"><div class="operation-wrap"><div class="operation-center"><div class="choose_size_box"><div class="choose_size"><mu-button><span class="more_warp"><span class="more"></span></span></mu-button></div></div></div></div></div><div class="mu-popover percent-pop" style="display:none"><div class="choose_dialog"><div class="choose_item">放大</div><div class="choose_item">缩小</div>'+[200,150,100,50,25].map(value=>'<div class="choose_item">'+value+'%</div>').join('')+'</div></div>' : ''}
<script>
const designs=${JSON.stringify(designs)},canvas=document.querySelector('canvas'),panel=document.querySelector('aside');let current='a',zoom=${new URL(req.url, 'http://synthetic.test').searchParams.get('zoom') === '27' ? 27 : 100};
function layout(d){const f=zoom/100;return {x:d.box[0],y:d.box[1],width:d.box[2]*f,height:d.box[3]*f,cx:d.box[0]+d.box[2]*f/2,cy:d.box[1]+d.box[3]*f/2,f}}
function paint(){const d=designs[current],b=layout(d),w=innerWidth,h=innerHeight;canvas.width=w*devicePixelRatio;canvas.height=h*devicePixelRatio;canvas.style.width=w+'px';canvas.style.height=h+'px';const c=canvas.getContext('2d');c.scale(devicePixelRatio,devicePixelRatio);c.fillStyle='#f6f7fb';c.fillRect(0,0,w,h);c.fillStyle='#172033';c.font='28px Arial';c.fillText('Synthetic design '+current.toUpperCase(),32,70);c.fillStyle=d.color;c.beginPath();c.roundRect(w*b.x,h*b.y,w*b.width,h*b.height,d.radius*b.f);c.fill();c.fillStyle=d.text.color;c.font=d.text.fontWeight+' '+d.text.fontSize*b.f+'px Arial';c.textAlign='center';c.textBaseline='middle';c.fillText('Inspect style',w*b.cx,h*b.cy)}
window.syntheticCanvasPoints=0;window.syntheticDesignSwitches=0;const zoomControl=document.querySelector('#design-zoom');document.querySelector('#zoom-status').textContent=zoom+'%';if(zoomControl){zoomControl.value=String(zoom);zoomControl.onchange=()=>{zoom=Number(zoomControl.value);document.querySelector('#zoom-status').textContent=zoom+'%';paint();fetch('/zoom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({zoom})})};}
const menuOwner=document.querySelector('.choose_size'),menu=document.querySelector('.percent-pop'),menuLabel=document.querySelector('mu-button .more');
window.syntheticZoomEntries=0;window.syntheticZoomChoices=0;
if(menuOwner){menuLabel.textContent=zoom+'%';menuOwner.onmouseenter=()=>{window.syntheticZoomEntries++;menuOwner.classList.add('open');menu.style.display='block'};menuOwner.onmouseleave=()=>{menuOwner.classList.remove('open');menu.style.display='none'};
for(const option of menu.querySelectorAll('.choose_item'))option.onclick=()=>{if(!/^\\d+%$/.test(option.textContent))return;window.syntheticZoomChoices++;zoom=Number.parseInt(option.textContent);menuLabel.textContent=zoom+'%';document.querySelector('#zoom-status').textContent=zoom+'%';menuOwner.classList.remove('open');menu.style.display='none';paint();fetch('/zoom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({zoom})})};}
function switchDesign(){current=(location.hash==='#design-b'||location.hash.includes('design=b'))?'b':'a';document.title='Synthetic canvas design '+current.toUpperCase();document.querySelector('#current-design').textContent='Design '+current.toUpperCase();panel.textContent='Select a design layer';paint()}
document.querySelector('#design-a').onclick=()=>{window.syntheticDesignSwitches++;location.hash=${lanhuZoomMenu ? JSON.stringify('/item/project/detailDetach?design=a') : JSON.stringify('design-a')}};document.querySelector('#design-b').onclick=()=>{window.syntheticDesignSwitches++;location.hash=${lanhuZoomMenu ? JSON.stringify('/item/project/detailDetach?design=b') : JSON.stringify('design-b')}};addEventListener('hashchange',switchDesign);switchDesign();addEventListener('resize',paint);
canvas.addEventListener('pointerdown',e=>{window.syntheticCanvasPoints++;const d=designs[current],b=layout(d),x=e.clientX/innerWidth,y=e.clientY/innerHeight;if(x<b.x||x>b.x+b.width||y<b.y||y>b.y+b.height)return;const isText=Math.abs(x-b.cx)<=.07*b.f&&Math.abs(y-b.cy)<=.02*b.f;const layer=isText?d.textLayer:d.layer;panel.textContent=isText?'Layer: '+layer+'\\nFont family: Synthetic-Medium\\nfont-size: '+d.text.fontSize+'px\\nfont-weight: '+d.text.fontWeight+'\\ncolor: '+d.text.color+'\\nline-height: '+d.text.lineHeight+'px\\nwidth: '+d.text.width+'px\\nheight: '+d.text.height+'px':'Layer: '+layer+'\\nFill: '+d.color+'\\nBorder radius: '+d.radius+'px\\nwidth: '+d.width+'px\\nheight: '+d.height+'px';fetch('/selected',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({design:current,layer})})})
</script>`)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://${lanhuZoomMenu ? 'lanhuapp.com' : 'stride-visual.test'}:${server.address().port}`
  const route = lanhuZoomMenu ? '/web/' : '/design', hash = lanhuZoomMenu ? '#/item/project/detailDetach' : ''
  return { origin, wikiUrl: `${origin}/requirements`, mixedWikiUrl: `${origin}/requirements?reference=1`, wikiExpected, mixedWikiExpected, wikiTargetExpected, url: `${origin}${route}${hash}`, smallUrl: `${origin}${route}?zoom=27${hash}`, noZoomControlUrl: `${origin}${route}?zoom=27&controls=none${hash}`, alternativeZoomUrl: `${origin}${route}?zoom=27&controls=alternative${hash}`, ...designs.a, designs,
    state: () => ({ selection: selection ?? null, clicks }), history: () => [...selections], zoomHistory: () => [...zooms], reset: () => { selection = undefined; clicks = 0; selections = []; zooms = [] },
    close: () => new Promise(done => server.close(done)) }
}
