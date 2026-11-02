import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, findChromiumExecutable } from './chromium.mjs'

export async function startExtensionBrowser({ repoRoot, benchmarkRoot, bridgeUrl, pairingCode, deferPairing = false, trustedOrigin, connectTimeoutMs = 30_000, actionTimeoutMs = 8_000, chromiumArgs = [] }) {
  if (!deferPairing && (typeof pairingCode !== 'string' || !/^[a-f0-9]{32}$/u.test(pairingCode))) {
    throw new Error('a fresh extension pairing code is required')
  }
  const extensionDir = resolve(repoRoot, 'extensions/dsh-browser/dist')
  const executablePath = await findChromiumExecutable(undefined, { requireExtensions: true })
  if (executablePath === undefined) throw new Error('no Chromium executable found; set PLAYWRIGHT_CHROMIUM_PATH')
  const tempParent = resolve(benchmarkRoot, '.tmp')
  await mkdir(tempParent, { recursive: true })
  const profileDir = await mkdtemp(join(tempParent, 'extension-profile-'))
  let context
  let stage = 'launching Chromium'
  const launch = () => chromium.launchPersistentContext(profileDir, {
      executablePath,
      channel: 'chromium',
      headless: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--enable-unsafe-extension-debugging',
        ...chromiumArgs,
        '--disable-background-networking',
        '--disable-component-update',
      ],
    })
  try {
    context = await launch()
    stage = 'waiting for extension service worker'
    let worker = context.serviceWorkers()[0]
    if (worker === undefined) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 })
    const extensionId = new URL(worker.url()).host
    // Tests provide one full extension panel page below. Disable a duplicate
    // native sidebar view; the toolbar action still grants real activeTab access.
    await worker.evaluate(() => chrome.sidePanel.setOptions({ enabled: false }))
    stage = 'opening benchmark target tab'
    let target = await context.newPage()
    target.setDefaultTimeout(actionTimeoutMs)
    await target.goto(`${trustedOrigin}/health`, { waitUntil: 'domcontentloaded' })
    stage = 'opening extension panel'
    let panel = await context.newPage()
    panel.setDefaultTimeout(actionTimeoutMs)
    await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
    await panel.waitForSelector('header.topbar', { timeout: 15_000 })
    stage = 'configuring extension bridge'
    await panel.evaluate(async ({ configuredBridgeUrl, configuredPairingCode, configuredOrigin, timeoutMs, deferred }) => {
      await new Promise((resolveConnection, rejectConnection) => {
        const port = chrome.runtime.connect({ name: 'dsh-panel' })
        window.__dshBenchmarkPort = port
        const settingsId = crypto.randomUUID()
        const timer = setTimeout(() => {
          port.disconnect()
          rejectConnection(new Error(`extension bridge did not connect within ${timeoutMs}ms`))
        }, timeoutMs)
        port.onDisconnect.addListener(() => {
          clearTimeout(timer)
          rejectConnection(new Error(chrome.runtime.lastError?.message ?? 'extension benchmark port disconnected'))
        })
        port.onMessage.addListener((message) => {
          if (deferred && message?.type === 'settings.result' && message.id === settingsId) {
            clearTimeout(timer)
            message.ok ? resolveConnection() : rejectConnection(new Error('extension settings failed'))
            return
          }
          if (message?.type !== 'status' || message.state !== 'connected') return
          clearTimeout(timer)
          resolveConnection()
        })
        port.postMessage({
          type: 'settings',
          id: settingsId,
          settings: {
            bridgeUrl: configuredBridgeUrl,
            ...(configuredPairingCode === undefined ? {} : { token: configuredPairingCode }),
            sharePageContent: 'auto',
            trustedActionOrigins: [configuredOrigin],
            approvalNotifications: false,
            autoResumeSession: false,
          },
        })
      })
    }, { configuredBridgeUrl: bridgeUrl, configuredPairingCode: pairingCode, configuredOrigin: trustedOrigin, timeoutMs: connectTimeoutMs, deferred: deferPairing })
    async function authorizePage(page = target) {
      await page.bringToFront()
      const cdp = await context.browser().newBrowserCDPSession()
      try {
        // The browser's native extension action grants activeTab. A worker or
        // panel message cannot substitute for this user gesture.
        const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] })
        const tab = targetInfos.find(value => value.url === page.url())
        if (tab === undefined) throw new Error('No native tab target for the authorization gesture')
        await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: tab.targetId })
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          const allowed = await worker.evaluate(async expected => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
            const grants = (await chrome.storage.session.get('dshPageAccess')).dshPageAccess?.grants ?? []
            return tab?.url === expected && grants.some(grant => grant.tabId === tab.id && grant.origin === new URL(expected).origin && grant.groupId !== undefined)
          }, page.url())
          if (allowed) return
          await page.waitForTimeout(50)
        }
        throw new Error('Native page authorization did not finish')
      } finally { await cdp.detach() }
    }
    stage = 'waiting for extension bridge connection'
    try {
      if (!deferPairing) await panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: connectTimeoutMs })
    } catch (error) {
      const status = await panel.locator('.connection').textContent().catch(() => '(status unavailable)')
      const discovery = await panel.evaluate(async (configuredBridge) => {
        try {
          const target = new URL(configuredBridge)
          target.protocol = 'http:'
          target.pathname = '/ext/bridge-config'
          return { status: (await fetch(target)).status }
        } catch (cause) {
          return { error: String(cause) }
        }
      }, bridgeUrl).catch((cause) => ({ error: String(cause) }))
      throw new Error(`extension did not connect to benchmark DSH; UI=${JSON.stringify(status)} discovery=${JSON.stringify(discovery)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await target.bringToFront()
    return {
      context,
      worker,
      panel,
      target,
      executablePath,
      authorizePage,
      /** Keep installation data while replacing the whole browser/worker lifetime. */
      async restart({ connected = true } = {}) {
        const targetUrl = target.url()
        await context.close()
        context = await launch()
        const restartedWorker = context.serviceWorkers().find(value => new URL(value.url()).host === extensionId)
          ?? await context.waitForEvent('serviceworker', { timeout: 15000 })
        await restartedWorker.evaluate(() => chrome.sidePanel.setOptions({ enabled: false }))
        target = await context.newPage()
        target.setDefaultTimeout(actionTimeoutMs)
        await target.goto(targetUrl, { waitUntil: 'domcontentloaded' })
        panel = await context.newPage()
        panel.setDefaultTimeout(actionTimeoutMs)
        await panel.goto(`chrome-extension://${extensionId}/panel/index.html`)
        await panel.waitForSelector('header.topbar', { timeout: 15000 })
        if (connected) await panel.locator('.connection .dot.connected').waitFor({ state: 'visible', timeout: connectTimeoutMs })
        worker = context.serviceWorkers().find(value => new URL(value.url()).host === extensionId)
          ?? await context.waitForEvent('serviceworker', { timeout: 15000 })
        await panel.evaluate(() => { window.__dshBenchmarkPort = chrome.runtime.connect({ name: 'dsh-panel' }) })
        await target.bringToFront()
        return { context, worker, target, panel }
      },
      async prepare(url) {
        await target.goto(url, { waitUntil: 'domcontentloaded' })
        await target.bringToFront()
        await authorizePage(target)
        await target.waitForTimeout(200)
      },
      async bindSession(sessionId, targetPage = target) {
        await authorizePage(targetPage)
        await targetPage.bringToFront()
        await panel.evaluate(({ session, timeoutMs }) => new Promise((resolveBinding, rejectBinding) => {
          const port = window.__dshBenchmarkPort
          if (port === undefined) { rejectBinding(new Error('benchmark panel port is unavailable')); return }
          const id = crypto.randomUUID()
          const finish = (error) => {
            clearTimeout(timer)
            port.onMessage.removeListener(onMessage)
            port.onDisconnect.removeListener(onDisconnect)
            if (error) rejectBinding(error)
            else resolveBinding()
          }
          const onMessage = (message) => {
            if (message?.type !== 'tab-affinity.rebind.result' || message.id !== id) return
            finish(message.ok ? undefined : new Error(message.error?.message ?? 'session binding failed'))
          }
          const onDisconnect = () => finish(new Error('benchmark panel port disconnected'))
          const timer = setTimeout(() => finish(new Error('session binding timed out')), timeoutMs)
          port.onMessage.addListener(onMessage)
          port.onDisconnect.addListener(onDisconnect)
          port.postMessage({ type: 'tab-affinity.rebind', id, sessionId: session })
        }), { session: sessionId, timeoutMs: actionTimeoutMs })
      },
      async close() {
        await context.close()
        await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      },
    }
  } catch (error) {
    if (context !== undefined) await context.close().catch(() => undefined)
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    const browserHint = stage === 'waiting for extension service worker'
      ? ' Install Chrome for Testing with `pnpm --dir benchmark install-browser`; current Google Chrome Stable builds ignore --load-extension.'
      : ''
    throw new Error(`extension browser failed while ${stage}: ${error instanceof Error ? error.message : String(error)}.${browserHint}`, { cause: error })
  }
}
