// Native intervention and bounded observation evidence in a disposable browser.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { startIsolatedModelRun } from './fixtures/isolated-model-run.mjs'
const repo = resolve(import.meta.dirname, '..')
const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
const base = join(repo, '.stride-private/validation/observation', version)
await mkdir(base, { recursive: true }); const artifacts = await mkdtemp(join(base, 'scripted-'))
const root = await mkdtemp(join(tmpdir(), 'stride-observation-')), ready = join(root, 'ready'), release = join(root, 'release'), barrier = join(root, 'barrier')
let h, writes = 0, phase = 'setup'
const site = createServer((req, res) => {
  if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return }
  const large = req.url === '/large'
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><h1>Observation fixture</h1><button id="switch">Switch workspace</button><button id="act">Count action</button><output id="identity">Workspace A</output><output id="count">0</output>${large ? '<main>' + 'Mounted synthetic prose '.repeat(5000) + '</main>' + Array.from({length:100},(_,i)=>`<button>Extra ${i}</button>`).join('') : ''}<script>document.querySelector('#switch').onclick=()=>document.querySelector('#identity').textContent='Workspace B';document.querySelector('#act').onclick=()=>document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1</script>`)
})
try {
  await writeFile(barrier, 'Native test synchronization only'); await new Promise(done => site.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${site.address().port}`
  const programs = {
    ownership: String.raw`let view=await tools.browser_snapshot({});const ref=view.text.split('\n').find(line=>line.includes('button "Count action"'))?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];if(!ref)throw Error('Missing observed action');console.log('OLD_OBSERVATION_CAPTURED');await tools.read({file_path:BARRIER});let stale=false;try{await tools.browser_click({elementRef:ref})}catch{stale=true}if(!stale)throw Error('Native input did not fence old reference');let enterStale=false;try{await tools.browser_press({key:'Enter'})}catch{enterStale=true}if(!enterStale)throw Error('Unanchored Enter bypassed native intervention');view=await tools.browser_snapshot({});if(!view.text.includes('Workspace B'))throw Error('Fresh read missed changed workspace');const next=view.text.split('\n').find(line=>line.includes('button "Count action"'))?.match(/ref=(obs_[a-f0-9-]+:\d+)/)?.[1];await tools.browser_click({elementRef:next});console.log('NATIVE_OBSERVATION_FENCE_OK');`.replace('BARRIER', JSON.stringify(barrier)),
    projection: String.raw`const first=await tools.browser_snapshot({});const id=first.text.match(/Observation: (obs_[a-f0-9-]+)/)?.[1];if(!id)throw Error('Missing observation id');console.log(first.text.slice(0,80));const next=await tools.browser_snapshot({delta:true,baseObservationId:id});console.log(next);if(!JSON.stringify(next).includes('model-projection-not-attested'))throw Error('Partial PTC projection accepted as a full model baseline');console.log('PROJECTION_FALLBACK_OK');`,
    coverage: `const value=await tools.browser_snapshot({});console.log(value.text.slice(0,1200));console.log(JSON.stringify(value.coverage));console.log('COVERAGE_READ_OK');`,
  }
  h = await startIsolatedModelRun({ repo, origin, startUrl: origin + '/small', artifacts, goal: 'Synthetic native intervention and observation coverage', programs,
    imports: "import {readFile,writeFile} from 'node:fs/promises';",
    guardSource: `ctx.effect(()=>ctx.tools.guard(exec=>!['run_code','read','browser_snapshot','browser_click','browser_press'].includes(exec.name)?'Only synthetic observation tools allowed':exec.name==='read'&&exec.arguments?.file_path!==${JSON.stringify(barrier)}?'Only test synchronization file allowed':undefined));ctx.on('tools/execute',async(exec,next)=>{if(exec.name==='read'){await writeFile(${JSON.stringify(ready)},'ready');const end=Date.now()+15000;while(Date.now()<end){try{await readFile(${JSON.stringify(release)});return next()}catch{await new Promise(done=>setTimeout(done,25))}}throw Error('Native fixture barrier timeout')}return next()});`,
  })
  await h.browser.prepare(origin + '/small'); await h.browser.bindSession(h.sessionId); await h.browser.panel.bringToFront()
  phase = 'native-intervention'; const turn = h.turn('ownership', '', 60000)
  const deadline = Date.now() + 30000; let available = false
  while (Date.now() < deadline) { try { await readFile(ready); available = true; break } catch { await delay(50) } }
  assert.equal(available, true)
  // Native trusted click; synthetic dispatchEvent cannot pass this fixture.
  await h.browser.target.locator('#switch').click(); await h.browser.target.locator('#identity').filter({hasText:'Workspace B'}).waitFor()
  await delay(150); await writeFile(release, 'continue')
  const events = await turn; assert.ok(JSON.stringify(events).includes('NATIVE_OBSERVATION_FENCE_OK')); assert.equal(await h.browser.target.locator('#count').textContent(), '1')
  phase = 'partial-model-projection'; const projection = await h.turn('projection', '')
  assert.ok(JSON.stringify(projection).includes('PROJECTION_FALLBACK_OK'))
  phase = 'collection-coverage'; await h.browser.prepare(origin + '/large'); await h.browser.bindSession(h.sessionId); await h.browser.panel.bringToFront()
  assert.ok((await h.browser.target.locator('main').textContent()).length > 100000); assert.equal(await h.browser.target.locator('button').count(), 102)
  const coverage = await h.turn('coverage', ''); const payloads = JSON.stringify(coverage.filter(e=>e.type==='tool/result'||e.type==='tool/ptc-dispatch'))
  assert.ok(payloads.includes('complete\\":false')); assert.match(payloads, /projection/); assert.match(payloads, /mainCharacters/); assert.match(payloads, /controls/)
  assert.match(payloads, /Collection omitted: [1-9]\d* main characters/); assert.equal(writes, 0)
  const result = { passed:true, version, realHost:true, isolatedChrome:true, scriptedModel:true, realModel:false, browserVersion:h.browser.browserVersion,
    nativeTrustedIntervention:true, oldReferenceRejected:true, unanchoredEnterRejected:true, freshObservationAllowedOneAction:true, partialModelProjectionForcedFull:true,
    mountedLargeFixture:true, collectionOmissionsReported:true, unknownAccountChangesDetected:false, serverWrites:writes, originalHostUntouched:true,
    hostBundleSha256:createHash('sha256').update(await readFile(join(repo,'packages/browser/bridge-browser/lib/index.js'))).digest('hex'), extensionBundleSha256:createHash('sha256').update(await readFile(join(repo,'extensions/dsh-browser/dist/background.js'))).digest('hex'), evidenceDirectory:artifacts.slice(base.length+1) }
  await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2),{mode:0o600}); await writeFile(join(base,'scripted.json'),JSON.stringify(result,null,2),{mode:0o600}); console.log(JSON.stringify(result))
} catch(error) { await writeFile(join(artifacts,'failure.json'),JSON.stringify({passed:false,phase,errorName:error.name},null,2),{mode:0o600}); throw error }
finally { await h?.close(); await new Promise(done=>site.close(done)); await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}) }
