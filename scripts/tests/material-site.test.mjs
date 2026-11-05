import test from 'node:test'
import assert from 'node:assert/strict'
import { startVisualSite } from '../fixtures/visual-site.mjs'

test('Wiki fixtures separate prose, image-only design facts and the requested page target', async t => {
  const site = await startVisualSite()
  t.after(() => site.close())
  // Connect directly to our loopback fixture; the browser maps the synthetic hostname.
  const local = site.origin.replace('stride-visual.test', '127.0.0.1')
  const prose = await (await fetch(`${local}/requirements`)).text()
  const mixed = await (await fetch(`${local}/requirements?reference=1`)).text()
  const picture = await fetch(`${local}/material-reference.svg`)
  assert.match(picture.headers.get('content-type'), /^image\/svg\+xml/u)
  const svg = await picture.text()
  const reference = site.mixedWikiExpected.visualRequirements[0]
  assert.equal(prose.includes('/material-reference.svg'), false)
  assert.ok(mixed.includes('/material-reference.svg'))
  assert.equal(mixed.includes(reference.referenceKey), false, 'Image-only evidence must not leak into the Wiki DOM text')
  assert.ok(svg.includes(reference.referenceKey)); assert.ok(svg.includes(reference.fill))
  assert.match(prose, /Wiki 站点主题信息/u); assert.match(mixed, /Wiki 站点主题信息/u)
  assert.match(prose, /id="wiki-article"/u)
  assert.deepEqual(site.wikiTargetExpected.target, { selector: '#wiki-article', width: 800, paddingTop: '31px' })
  assert.equal(site.wikiExpected.visualRequirements.length, 0)
  assert.equal(site.mixedWikiExpected.sourceRole, 'mixed')
})
