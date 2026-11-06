import type { ToolAnswer, ToolCall } from './tools.ts'

/** Keep the path, query values and SPA fragment; never equate pages by site/title. */
export function pageUrlKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    url.searchParams.sort()
    return url.href
  } catch { return undefined }
}

interface ReuseContext {
  empty: boolean
  controlledTabId?: number
  allows: (tab: chrome.tabs.Tab) => boolean
  capture: (tabId: number) => () => boolean
  follow: (tabId: number, allows: (tab: chrome.tabs.Tab) => boolean, active: boolean) => Promise<ToolAnswer>
}

/** Undefined means no authorized match: the caller may use its normal new-tab path. */
export async function reuseAuthorizedTab(call: ToolCall, context: ReuseContext): Promise<ToolAnswer | undefined> {
  if (call.args.newTab !== undefined && typeof call.args.newTab !== 'boolean') {
    return { ok: false, error: { code: 'bad-args', message: 'newTab must be a boolean.' } }
  }
  const key = pageUrlKey(call.args.url)
  if (key === undefined || call.args.newTab === true || context.empty) return undefined
  const matchesUrl = (tab: chrome.tabs.Tab): boolean => pageUrlKey(tab.url) === key
    && (tab.pendingUrl === undefined || pageUrlKey(tab.pendingUrl) === key)
  let matches: chrome.tabs.Tab[]
  try {
    matches = (await chrome.tabs.query({})).filter(tab => tab.id !== undefined && context.allows(tab) && matchesUrl(tab))
  } catch {
    return { ok: false, error: { code: 'content-unavailable', message: 'Could not check authorized tabs. No new tab was opened.' } }
  }
  if (matches.length === 0) return undefined
  const tab = matches.find(tab => tab.id === context.controlledTabId) ?? (matches.length === 1 ? matches[0] : undefined)
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'content-unavailable', message: 'Several authorized tabs match this URL. Use browser_list_tabs and browser_follow_tab to choose the intended page. No new tab was opened.' } }
  }
  const current = context.capture(tab.id)
  // Follow rechecks this predicate against native tab metadata before and after
  // approval. Revocation/navigation must fail, never fall back to a new tab.
  const answer = await context.follow(tab.id, candidate => current() && context.allows(candidate) && matchesUrl(candidate), call.args.active !== false)
  if (!answer.ok) return answer
  return { ok: true, result: { text: `Reused already authorized tab ${tab.id}; no new tab was opened or page reloaded. Call browser_snapshot before reading or operating this page.` } }
}
