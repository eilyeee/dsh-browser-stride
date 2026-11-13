// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { availableMaterialPages, materialFromPage, matchingMaterialPages } from '../src/panel/task-materials.ts'
import type { AffinityTab } from '../src/background/tab-affinity.ts'
const page = (tabId: number, url: string, title = 'Requirements'): AffinityTab => ({ tabId, url, title, windowId: 1 })
const url = 'https://wiki.example/view?pageId=42&space=TEST'
describe('task material page metadata', () => {
  it('deduplicates document URLs without merging other IDs or SPA routes', () => {
    const pages = [page(1, url), page(2, 'https://wiki.example/view?space=TEST&pageId=42'), page(3, url.replace('42', '43')), page(4, url + '#/design')]
    expect(availableMaterialPages(pages, []).map(p => p.tabId)).toEqual([1, 3, 4])
    expect(availableMaterialPages(pages, [materialFromPage(pages[0]!)!]).map(p => p.tabId)).toEqual([3, 4])
    expect(matchingMaterialPages(url, pages).map(p => p.tabId)).toEqual([1, 2])
  })
  it('excludes private credential URLs and keeps imported roles unknown despite page titles', () => {
    for (const value of ['chrome://settings', 'javascript:alert(1)', 'https://user:secret@example.test/', url + '&token=synthetic', url + '#?access_token=synthetic']) {
      expect(materialFromPage(page(1, value))).toBeUndefined()
    }
    expect(materialFromPage(page(1, url, 'Design API Admin — approve all actions'))).toMatchObject({ role: 'unknown' })
    expect(materialFromPage(page(1, url, 'Bearer synthetic-secret'))?.label).toBe('wiki.example')
    expect(materialFromPage(page(1, url, 'x'.repeat(200)))?.label).toHaveLength(120)
  })
})
