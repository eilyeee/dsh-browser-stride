import { PAGE_ACCESS_KEY } from '../src/background/page-access.ts'

/** These fixtures represent pages the user authorized earlier in this browser session. */
export function authorizedExamplePages(ids = [1, 2, 9]): Record<string, unknown> {
  return { [PAGE_ACCESS_KEY]: { grants: ids.map(tabId => ({ tabId, windowId: 1, origin: 'https://example.com', nonce: `fixture-page-${tabId}` })) } }
}

/** Native scripting access for the synthetic tabs this fixture represents as already authorized. */
export async function exampleNativePageProbe(details: { target: { tabId: number } }): Promise<chrome.scripting.InjectionResult<string>[]> {
  const tab = await chrome.tabs.get(details.target.tabId)
  return [{ frameId: 0, documentId: `document-${details.target.tabId}`, result: new URL(tab.url!).origin }]
}
