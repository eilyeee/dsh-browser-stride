import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply } from '../plugin/playwright-browser.mjs'

test('Playwright baseline enforces observation references on a controlled page', {
  skip: process.env.STRIDE_REAL_BROWSER_E2E !== '1',
  timeout: 60_000,
}, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><main><button onclick="this.textContent='Changed'">Save</button>
      <div id="focused"><select aria-label="Size"><option>Small</option><option>Large</option></select></div>
      <form onsubmit="document.getElementById('proof').textContent='submitted';event.preventDefault()">
        <input aria-label="Guard" required onkeydown="document.getElementById('key-state').textContent='key received'"><button>Submit</button>
      </form><p id="proof">not submitted</p><p id="key-state">no key</p></main><aside><button>Outside region</button></aside>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    webServer: { register: () => () => {} },
    effect: (effect) => { disposers.push(effect()) },
    get: () => undefined,
  }
  try {
    await apply(ctx, {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
      startUrl: `http://127.0.0.1:${server.address().port}/`,
    })
    const execute = (name, args = {}) => tools.get(name).execute(args, { signal: new AbortController().signal })
    const first = await execute('browser_snapshot')
    const oldRef = first.text.match(/\[1\].*?ref=(obs_[a-f0-9-]+:1)/i)?.[1]
    const second = await execute('browser_snapshot')
    const buttonRef = second.text.match(/\[1\].*?ref=(obs_[a-f0-9-]+:1)/i)?.[1]
    const selectRef = second.text.match(/\[2\].*?ref=(obs_[a-f0-9-]+:2)/i)?.[1]
    assert.ok(oldRef && buttonRef && selectRef)
    assert.notEqual(oldRef, buttonRef)
    await assert.rejects(execute('browser_click', { elementRef: oldRef }), /stale/)
    await execute('browser_select', { elementRef: selectRef, optionIndex: 1 })
    await execute('browser_click', { elementRef: buttonRef })
    await assert.rejects(execute('browser_click', { elementRef: buttonRef }), /stale/)
    const final = await execute('browser_snapshot')
    assert.match(final.text, /Changed/)
    assert.match(final.text, /value="Large"/)
    const guardRef = final.text.match(/<input type=text[^>]*> "Guard".*?ref=(obs_[a-f0-9-]+:\d+)/i)?.[1]
    assert.ok(guardRef)
    await execute('browser_click', { elementRef: guardRef })
    const press = await execute('browser_press', { key: 'Enter' })
    assert.match(press.text, /native key behavior is not guaranteed/u)
    const afterPress = await execute('browser_snapshot')
    assert.match(afterPress.text, /key received/u)
    assert.match(afterPress.text, /not submitted/u)
    await assert.rejects(execute('browser_press', { key: 'Enter\nother' }), /key must be/u)
    const region = await execute('browser_snapshot', { region: '#focused' })
    assert.match(region.text, /Text scope: selector "#focused"/)
    assert.match(region.text, /Outside region/)
    await assert.rejects(execute('browser_snapshot', { region: '#missing' }), /region not found/)
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
