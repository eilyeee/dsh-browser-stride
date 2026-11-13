import { safeMaterialUrl, type TaskMaterial } from '@eilyeee/dsh-browser-stride/src/task-brief-contract.ts'
import type { AffinityTab } from '../background/tab-affinity.ts'
import { pageUrlKey } from '../background/open-tab-reuse.ts'

/** Page titles and URLs are metadata only; importing them never chooses a role or grants access. */
export function materialFromPage(page: AffinityTab): TaskMaterial | undefined {
  if (page.url.length > 2000 || !safeMaterialUrl(page.url)) return undefined
  const title = page.title.replace(/[\r\n]/g, ' ').trim().slice(0, 120)
  const label = /\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i.test(title)
    ? new URL(page.url).hostname : title
  return { url: page.url, label, role: 'unknown' }
}

export function availableMaterialPages(pages: AffinityTab[], materials: TaskMaterial[]): AffinityTab[] {
  const seen = new Set(materials.map(material => pageUrlKey(material.url)))
  return pages.filter(page => {
    const key = pageUrlKey(page.url)
    if (key === undefined || seen.has(key) || materialFromPage(page) === undefined) return false
    seen.add(key)
    return true
  })
}

/** Keep all copies visible so the user chooses explicitly; never match just a site or title. */
export function matchingMaterialPages(url: string, pages: AffinityTab[]): AffinityTab[] {
  const key = pageUrlKey(url)
  return key === undefined ? [] : pages.filter(page => pageUrlKey(page.url) === key)
}
