/**
 * Browser smoke: the built MV3 extension connects through a real WebSocket to
 * the migrated bridge carrier. dsh 0.1.2 Remote semantics are covered by
 * remote-host-api.spec; this test deliberately owns no pre-0.1.2 Host shim.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type BrowserContext } from 'playwright-core'
import { BridgeServer } from '../../src/server.ts'
import { PairingStore } from '../../src/pairing.ts'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../../src/host-api.ts'

const TOKEN = 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0'
const EXTENSION_DIR = resolve(import.meta.dirname, '../../../../../extensions/dsh-browser/dist')

function chromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv
  const cacheRoot = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cacheRoot)) return undefined
  for (const dir of ['chromium-1217', 'chromium-1226', 'chromium-1181']) {
    for (const candidate of [
      join(cacheRoot, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      join(cacheRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cacheRoot, dir, 'chrome-linux', 'chrome'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolveWait) => {
    signal.addEventListener('abort', () => { resolveWait() }, { once: true })
  })
}

let executable: string | undefined
let browser: BrowserContext | undefined
let profile: string | undefined
let http: Server | undefined
let bridge: BridgeServer | undefined
let port: number | undefined
let pairingCode: string | undefined
let destinationRequests = 0
const calls: HostRpcCall[] = []

beforeAll(async () => {
  if (process.env.STRIDE_REAL_BROWSER_E2E !== '1') return
  executable = chromiumExecutable()
  if (executable === undefined || !existsSync(join(EXTENSION_DIR, 'manifest.json'))) return
  profile = await mkdtemp(join(tmpdir(), 'dsh-browser-extension-e2e-'))
  const pairing = new PairingStore(join(profile, 'pairings.json'))
  pairingCode = pairing.issue().code

  const api: BrowserHostApi = {
    async call(request): Promise<HostRpcResult> {
      calls.push(request)
      if (request.method === 'session.create') return { ok: true, value: { sessionId: 'session-browser-e2e' } }
      if (request.method === 'session.history') {
        return { ok: true, value: { events: [], hasMore: false } }
      }
      if (request.method === 'session.list') return { ok: true, value: { items: [] } }
      if (request.method === 'workspace.list') {
        return { ok: true, value: { items: [], archivedSessionIds: [] } }
      }
      return { ok: true, value: {} }
    },
    async *events(signal) { await abortWait(signal) },
    async respond() { return { accepted: false, reason: 'not-pending' } },
  }
  bridge = new BridgeServer({
    token: TOKEN,
    pairing,
    api,
    toolTimeoutMs: 20_000,
    caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    injectBrowserSnapshot: () => {},
    purgeSession: async () => {},
  })
  http = createServer((req, res) => {
    if (req.url === '/fixture') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>Stride fixture</title>
        <label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
        <input id="retarget" aria-label="Account" value="old" oninput="this.setAttribute('aria-label','Different account')" onchange="this.dataset.changed='yes'">
        <input id="locked" aria-label="Locked" value="old" readonly>
        <input id="validation" type="email" aria-label="Email" value="not-an-email" oninput="this.setCustomValidity(this.value.startsWith('blocked') ? 'private-validation-message' : '');this.setAttribute('aria-invalid',String(this.value.startsWith('blocked')))">
        <input autocomplete="one-time-code" value="synthetic-one-time-value">
        <input autocomplete="section-payment billing cc-number" value="synthetic-card-value">
        <textarea autocomplete="one-time-code">synthetic-textarea-value</textarea>
        <div id="otp" contenteditable="true"><span id="sensitive-child">synthetic-editor-value</span></div>
        <form id="guarded" onsubmit="this.dataset.submissions=String(Number(this.dataset.submissions||0)+1);event.preventDefault()">
          <input id="guarded-field" aria-label="Guarded field" required oninvalid="this.setAttribute('aria-invalid','true')" oninput="this.removeAttribute('aria-invalid')" onkeydown="if(event.key==='Enter' &amp;&amp; this.value==='page-handled')this.form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))">
          <button id="guarded-submit">Guarded submit</button>
        </form>
        <form id="destination" action="/draft"><button id="submit-action">Save</button></form>
        <a id="native-link" href="/target" target="_blank" rel="noreferrer">Open child</a>
        <a id="ordinary-link" href="/destination">Open destination</a><iframe src="/frame"></iframe>`)
      return
    }
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Child frame</title><button id="child" onclick="this.dataset.clicked=\'yes\'">Confirm child</button>')
      return
    }
    if (req.url === '/destination') {
      destinationRequests += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Destination</title><p>Arrived</p>')
      return
    }
    if (req.url === '/ext/bridge-config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${String(port)}/ext/bridge` }))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  http.on('upgrade', (req, socket, head) => { bridge?.handleUpgrade(req, socket, head) })
  await new Promise<void>((resolveListen) => { http?.listen(0, '127.0.0.1', resolveListen) })
  port = (http.address() as AddressInfo).port

  browser = await chromium.launchPersistentContext(profile, {
    executablePath: executable,
    channel: 'chromium',
    headless: true,
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await bridge?.close()
  if (http !== undefined) {
    await new Promise<void>((resolveClose) => { http?.close(() => { resolveClose() }) })
  }
  if (profile !== undefined) await rm(profile, { recursive: true, force: true })
}, 30_000)

describe.skipIf(process.env.STRIDE_REAL_BROWSER_E2E !== '1')('extension ↔ migrated bridge smoke', () => {
  it('connects, negotiates caps, and initializes a Session through the private bridge protocol', { timeout: 60_000 }, async () => {
    if (executable === undefined) throw new Error('A Chromium executable is required for this opt-in test')
    if (browser === undefined || port === undefined || pairingCode === undefined) throw new Error('Build the extension before running this opt-in test')

    let worker = browser.serviceWorkers()[0]
    worker ??= await browser.waitForEvent('serviceworker', { timeout: 30_000 })
    const extensionId = new URL(worker.url()).host
    const panel = await browser.newPage()
    await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
    await panel.waitForSelector('header.topbar', { timeout: 15_000 })

    await panel.click('button[aria-label="Open settings"]')
    await panel.fill('input[placeholder*="Auto-detect"]', `ws://127.0.0.1:${String(port)}/ext/bridge`)
    await panel.fill('input[type="password"]', pairingCode)
    await panel.click('text=Save & Connect')

    await expect.poll(
      () => panel.locator('.connection').textContent(),
      { timeout: 30_000 },
    ).toContain('Connected')
    await expect.poll(
      () => calls.some(request => request.method === 'session.history'),
      { timeout: 15_000 },
    ).toBe(true)
    expect(calls.map(request => request.method)).toEqual(expect.arrayContaining([
      'session.create', 'session.history',
    ]))
    const publicSettings = await worker.evaluate(async () => (await chrome.storage.local.get('dshSettings')).dshSettings)
    expect(publicSettings).not.toHaveProperty('token')
    expect((await new PairingStore(join(profile!, 'pairings.json')).list())).toHaveLength(1)

    // Exercise the packaged content script on a disposable local page. The
    // approval and target-routing paths are covered separately by unit tests.
    const fixture = await browser.newPage()
    await fixture.goto(`http://127.0.0.1:${port}/fixture`)
    const tabId = await worker.evaluate(async (fixtureUrl) => {
      const tabs = await chrome.tabs.query({ url: fixtureUrl })
      return tabs[0]?.id
    }, `http://127.0.0.1:${port}/fixture`)
    expect(tabId).toBeDefined()
    const snapshot = await worker.evaluate(async (id) => chrome.tabs.sendMessage(id!, {
      type: 'DSH_ACTION', action: 'browser_snapshot', args: {},
    }, { frameId: 0 }), tabId) as { ok: boolean; result?: { text: string } }
    expect(snapshot.ok).toBe(true)
    expect(snapshot.result?.text).toContain('0="Small", 1="Large"')
    const index = Number(await fixture.locator('#size').getAttribute('data-dsh-el'))
    const directRef = snapshot.result?.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${index})`, 'i'))?.[1]
    expect(directRef).toBeDefined()
    const selected = await worker.evaluate(async ({ id, elementRef }) => chrome.tabs.sendMessage(id!, {
      type: 'DSH_ACTION', action: 'browser_select', args: { elementRef, optionIndex: 1 },
    }, { frameId: 0 }), { id: tabId, elementRef: directRef }) as { ok: boolean; result?: { text: string } }
    expect(selected.ok).toBe(true)
    expect(selected.result?.text).toContain('control state was read back')
    expect(await fixture.locator('#size').inputValue()).toBe('Large')
    await fixture.locator('#size option').nth(1).evaluate(option => { option.textContent = 'Changed' })
    const stale = await worker.evaluate(async ({ id, elementRef }) => chrome.tabs.sendMessage(id!, {
      type: 'DSH_ACTION', action: 'browser_select', args: { elementRef, optionIndex: 1 },
    }, { frameId: 0 }), { id: tabId, elementRef: directRef }) as { ok: boolean; error?: { message: string } }
    expect(stale.ok).toBe(false)
    expect(stale.error?.message).toContain('changed')

    // Exercise the actual Bridge → background → content chain, including user
    // approval, frame routing and a reference superseded by another snapshot.
    const request = (name: string, args: Record<string, unknown>) => bridge!.requestTool(
      name, args, new AbortController().signal, 20_000, 'session-browser-e2e',
    )
    const approve = async (): Promise<void> => {
      await panel.locator('.approval-dialog button.allow').click({ timeout: 15_000 })
    }
    const follow = request('browser_follow_tab', { tabId })
    await approve()
    await follow
    const first = await request('browser_snapshot', {}) as { text: string }
    expect(first.text).toContain('native-constraints=invalid(type-mismatch)')
    expect(first.text).not.toContain('synthetic-one-time-value')
    expect(first.text).not.toContain('synthetic-card-value')
    expect(first.text).not.toContain('synthetic-textarea-value')
    expect(first.text).not.toContain('synthetic-editor-value')
    const sensitiveText = await request('browser_get_text', { selector: '#sensitive-child' }) as { text: string }
    expect(sensitiveText.text).not.toContain('synthetic-editor-value')
    const bridgeIndex = Number(await fixture.locator('#size').getAttribute('data-dsh-el'))
    const firstTopRef = first.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${bridgeIndex})`, 'i'))?.[1]
    expect(firstTopRef).toBeDefined()
    const second = await request('browser_snapshot', {}) as { text: string }
    const [top, child] = second.text.split('--- iframe frame=')
    const topRef = top?.match(new RegExp(`ref=(obs_[a-f0-9-]+:${bridgeIndex})`, 'i'))?.[1]
    const childFrame = Number(child?.match(/^(\d+)/)?.[1])
    const childRef = child?.match(/ref=(obs_[a-f0-9-]+:\d+)/i)?.[1]
    expect(topRef).toBeDefined()
    expect(topRef).not.toBe(firstTopRef)
    expect(childFrame).toBeGreaterThan(0)
    expect(childRef).toBeDefined()

    const staleAction = request('browser_select', { elementRef: firstTopRef, optionIndex: 0 })
    const staleFailure = expect(staleAction).rejects.toThrow(/stale/i)
    await approve()
    await staleFailure
    expect(await fixture.locator('#size').inputValue()).toBe('Changed')

    const select = request('browser_select', { elementRef: topRef, optionIndex: 0 })
    await approve()
    const selectText = (await select as { text: string }).text
    expect(selectText).toContain('control state was read back')
    expect(selectText).toContain(`base: ${topRef?.split(':')[0]}`)
    expect(await fixture.locator('#size').inputValue()).toBe('Small')

    const crossed = request('browser_click', { frame: childFrame, elementRef: topRef })
    const crossedFailure = expect(crossed).rejects.toThrow(/stale/i)
    await approve()
    await crossedFailure
    const childButton = fixture.frameLocator('iframe').locator('#child')
    expect(await childButton.getAttribute('data-clicked')).toBeNull()
    const childClick = request('browser_click', { frame: childFrame, elementRef: childRef })
    await approve()
    await childClick
    expect(await childButton.getAttribute('data-clicked')).toBe('yes')

    const validationSnapshot = await request('browser_snapshot', {}) as { text: string }
    const validationIndex = Number(await fixture.locator('#validation').getAttribute('data-dsh-el'))
    const validationRef = validationSnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${validationIndex})`, 'i'))?.[1]
    expect(validationRef).toBeDefined()
    const invalidInput = request('browser_type', { elementRef: validationRef, text: 'blocked@example.test', replace: true })
    await approve()
    const invalidText = (await invalidInput as { text: string }).text
    expect(invalidText).toContain('<UNTRUSTED_PAGE_CONTENT')
    expect(invalidText).toContain('native-constraints=invalid(custom-error) aria-invalid=true')
    expect(invalidText).toContain('does not confirm a saved change')
    expect(invalidText).not.toContain('private-validation-message')
    const correctionRef = invalidText.match(new RegExp(`ref=(obs_[a-f0-9-]+:${validationIndex})`, 'i'))?.[1]
    expect(correctionRef).toBeDefined()
    const correctedInput = request('browser_type', { elementRef: correctionRef, text: 'valid@example.test', replace: true })
    await approve()
    const correctedText = (await correctedInput as { text: string }).text
    expect(correctedText).toContain('native-constraints=valid')
    expect(correctedText).not.toContain('aria-invalid=true')
    expect(await fixture.locator('#validation').inputValue()).toBe('valid@example.test')

    const invalidForm = await request('browser_snapshot', {}) as { text: string }
    const guardedIndex = Number(await fixture.locator('#guarded-submit').getAttribute('data-dsh-el'))
    const invalidSubmitRef = invalidForm.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${guardedIndex})`, 'i'))?.[1]
    expect(invalidSubmitRef).toBeDefined()
    const invalidClick = request('browser_click', { elementRef: invalidSubmitRef })
    await approve()
    expect((await invalidClick as { text: string }).text).toContain('aria-invalid=true')
    expect(await fixture.locator('#guarded').getAttribute('data-submissions')).toBeNull()

    await fixture.locator('#guarded-field').focus()
    const invalidEnter = request('browser_press', { key: 'Enter' })
    await approve()
    expect((await invalidEnter as { text: string }).text).toContain('native key behavior is not guaranteed')
    expect(await fixture.locator('#guarded').getAttribute('data-submissions')).toBeNull()
    await fixture.locator('#guarded-field').fill('page-handled')
    await fixture.locator('#guarded-field').focus()
    const handledEnter = request('browser_press', { key: 'Enter' })
    await approve()
    expect((await handledEnter as { text: string }).text).toContain('Page handlers may have caused effects')
    expect(await fixture.locator('#guarded').getAttribute('data-submissions')).toBe('1')
    const guardedSnapshot = await request('browser_snapshot', {}) as { text: string }
    const guardedRef = guardedSnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${guardedIndex})`, 'i'))?.[1]
    expect(guardedRef).toBeDefined()
    const guardedClick = request('browser_click', { elementRef: guardedRef })
    await approve()
    await guardedClick
    expect(await fixture.locator('#guarded').getAttribute('data-submissions')).toBe('2')

    const refreshed = await request('browser_snapshot', {}) as { text: string }
    const retargetIndex = Number(await fixture.locator('#retarget').getAttribute('data-dsh-el'))
    const retargetRef = refreshed.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${retargetIndex})`, 'i'))?.[1]
    expect(retargetRef).toBeDefined()
    const partial = request('browser_type', { elementRef: retargetRef, text: 'synthetic-value', replace: true })
    await approve()
    expect((await partial as { text: string }).text).toContain('may have partially changed')
    expect(await fixture.locator('#retarget').inputValue()).toBe('')
    expect(await fixture.locator('#retarget').getAttribute('data-changed')).toBeNull()

    const finalSnapshot = await request('browser_snapshot', {}) as { text: string }
    const lockedIndex = Number(await fixture.locator('#locked').getAttribute('data-dsh-el'))
    const lockedRef = finalSnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${lockedIndex})`, 'i'))?.[1]
    expect(lockedRef).toBeDefined()
    const locked = request('browser_type', { elementRef: lockedRef, text: 'synthetic-value', replace: true })
    const lockedFailure = expect(locked).rejects.toThrow(/read-only/)
    await approve()
    await lockedFailure
    expect(await fixture.locator('#locked').inputValue()).toBe('old')

    const scoped = await request('browser_snapshot', { region: '#locked' }) as { text: string }
    expect(scoped.text).toContain('Text scope: selector "#locked"; control inventory: current frame.')
    expect(scoped.text).toContain('Different account')
    await expect(request('browser_snapshot', { region: '#missing' })).rejects.toThrow(/requested snapshot region does not exist/i)

    const historySnapshot = await request('browser_snapshot', {}) as { text: string }
    const historyIndex = Number(await fixture.locator('#size').getAttribute('data-dsh-el'))
    const historyRef = historySnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${historyIndex})`, 'i'))?.[1]
    expect(historyRef).toBeDefined()
    await worker.evaluate((id) => {
      const state = globalThis as typeof globalThis & { __strideHistorySeen?: boolean }
      state.__strideHistorySeen = false
      chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
        if (details.tabId === id) state.__strideHistorySeen = true
      })
    }, tabId)
    await fixture.evaluate(() => { history.pushState({ record: 'different' }, '', location.href) })
    await expect.poll(
      () => worker!.evaluate(() => (globalThis as typeof globalThis & { __strideHistorySeen?: boolean }).__strideHistorySeen),
      { timeout: 5_000 },
    ).toBe(true)
    await expect(request('browser_select', { elementRef: historyRef, optionIndex: 1 })).rejects.toThrow(/current document/i)
    expect(await fixture.locator('#size').inputValue()).toBe('Small')

    const formSnapshot = await request('browser_snapshot', {}) as { text: string }
    const buttonIndex = Number(await fixture.locator('#submit-action').getAttribute('data-dsh-el'))
    const buttonRef = formSnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${buttonIndex})`, 'i'))?.[1]
    expect(buttonRef).toBeDefined()
    await fixture.locator('#destination').evaluate((form) => { (form as HTMLFormElement).action = '/different-record' })
    const changedForm = request('browser_click', { elementRef: buttonRef })
    const changedFormFailure = expect(changedForm).rejects.toThrow(/changed/i)
    await approve()
    await changedFormFailure
    expect(fixture.url()).toContain('/fixture')

    const linkSnapshot = await request('browser_snapshot', {}) as { text: string }
    const linkIndex = Number(await fixture.locator('#native-link').getAttribute('data-dsh-el'))
    const linkRef = linkSnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${linkIndex})`, 'i'))?.[1]
    expect(linkRef).toBeDefined()
    const newPage = browser.waitForEvent('page', { timeout: 10_000 })
    const link = request('browser_click', { elementRef: linkRef })
    await approve()
    expect((await link as { text: string }).text).toContain('not confirmed')
    const popup = await newPage
    await popup.waitForLoadState('domcontentloaded')
    expect(popup.url()).toContain('/target')
    await popup.close()

    const followAgain = request('browser_follow_tab', { tabId })
    await approve()
    await followAgain
    const ordinarySnapshot = await request('browser_snapshot', {}) as { text: string }
    const ordinaryIndex = Number(await fixture.locator('#ordinary-link').getAttribute('data-dsh-el'))
    const ordinaryRef = ordinarySnapshot.text.match(new RegExp(`ref=(obs_[a-f0-9-]+:${ordinaryIndex})`, 'i'))?.[1]
    expect(ordinaryRef).toBeDefined()
    const navigation = fixture.waitForURL('**/destination', { timeout: 10_000 })
    const ordinaryClick = request('browser_click', { elementRef: ordinaryRef })
    await approve()
    await ordinaryClick
    await navigation
    expect(destinationRequests).toBe(1)
    await fixture.close()
    await panel.close()
  })
})
