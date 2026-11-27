import { DOCUMENT_READ_MESSAGES, localDocumentResult, localDocumentSpec, localPageUrl, type DocumentReadErrorCode } from '@eilyeee/dsh-browser-stride/src/local-browser-contract.ts'
import { componentText } from './component-text.ts'
import { redactSensitivePageText } from './privacy.ts'

const visibility = { checkOpacity: true, checkVisibilityCSS: true }
const MAX_HTML_BYTES = 4_000_000
const MAX_IMAGE_BYTES = 256_000
const LOGIN_FORM = 'form#loginform input[type="password"], form[name="loginform"] input[type="password"]'
const headerText = (cell: HTMLTableCellElement) => componentText(cell).replace(/\s+/g, '').toLowerCase()

export class VersionedDocumentError extends Error {
  constructor(readonly code: DocumentReadErrorCode | 'target-navigated') {
    super(code === 'target-navigated' ? 'Select the exact document in this conversation and try again.' : DOCUMENT_READ_MESSAGES[code])
    this.name = 'VersionedDocumentError'
  }
}

function only(root: ParentNode, selector: string, checkLogin = false): Element {
  const elements = root.querySelectorAll(selector)
  if (elements.length !== 1) {
    const loginRequired = elements.length === 0 && checkLogin && root.querySelector(LOGIN_FORM) !== null
    throw new VersionedDocumentError(loginRequired ? 'document-login-required' : 'document-source-unavailable')
  }
  return elements[0]!
}

function versionText(element: Element): string {
  return (element instanceof HTMLMetaElement ? element.content : element.textContent ?? '').trim()
}

function linkUrl(value: string): URL | undefined {
  try {
    const parsed = localPageUrl.safeParse(new URL(value, location.href).href)
    if (parsed.success) return new URL(parsed.data)
  } catch { /* discard invalid page data */ }
}

function repository(value: string): string | undefined {
  const text = value.trim()
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/-]+$/.test(text) && text.length <= 2048) return text
  if (!/^https?:\/\//i.test(text)) return undefined
  const parsed = linkUrl(text)
  if (parsed === undefined) return undefined
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

function permissionLink(value: string): string[] {
  const parsed = linkUrl(value)
  if (parsed === undefined) return []
  const pageId = parsed.origin === location.origin ? parsed.searchParams.get('pageId') : null
  parsed.search = ''
  parsed.hash = ''
  if (pageId !== null && /^\d{1,16}$/.test(pageId)) parsed.searchParams.set('pageId', pageId)
  return [parsed.href]
}

function anchors(cell?: HTMLTableCellElement): HTMLAnchorElement[] {
  return Array.from(cell?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])
    .filter(link => link.checkVisibility(visibility))
}

function projectEntries(root: Element) {
  const entries: Array<{ name: string; repositoryUrl: string; permissionUrls?: string[] }> = []
  for (const table of root.querySelectorAll('table')) {
    const headers = Array.from(table.rows[0]?.cells ?? [], headerText)
    const nameIndex = headers.findIndex(text => ['项目名', '项目名称', '系统名', '系统名称'].includes(text))
    const repoIndex = headers.findIndex(text => ['git地址', 'gitlab地址', '仓库地址', 'gitlab'].includes(text))
    if (nameIndex < 0 || repoIndex < 0) continue
    const permissionIndexes = headers.flatMap((text, index) => text.includes('权限') ? [index] : [])
    for (const row of Array.from(table.rows).slice(1)) {
      const nameCell = row.cells[nameIndex], repoCell = row.cells[repoIndex]
      if (!nameCell?.checkVisibility(visibility) || !repoCell?.checkVisibility(visibility)) continue
      const name = componentText(nameCell).slice(0, 100)
      if (!name) continue
      const urlsIn = (text: string) => text.match(/(?:https?:\/\/|git@)[^\s<>，。；]+/g) ?? []
      const visibleLinks = anchors(repoCell)
      // An anchor's label might look like another URL; the actual href is authoritative for that row.
      const labels = visibleLinks.flatMap(link => urlsIn(componentText(link)))
      const bareUrls = urlsIn(componentText(repoCell)).filter(url => {
        const index = labels.indexOf(url)
        if (index < 0) return true
        labels.splice(index, 1)
        return false
      })
      const addresses = [...new Set([...visibleLinks.map(link => link.getAttribute('href')!), ...bareUrls]
        .filter(url => redactSensitivePageText(repoCell, url) === url).flatMap(url => repository(url) ?? []))]
      const permissionUrls = [...new Set(permissionIndexes.flatMap(index => anchors(row.cells[index]).flatMap(link => {
        const href = link.getAttribute('href')!
        return redactSensitivePageText(link, href) === href ? permissionLink(href) : []
      })))].slice(0, 20)
      for (const repositoryUrl of addresses.length ? addresses : ['']) {
        entries.push({ name, repositoryUrl, ...(permissionUrls.length ? { permissionUrls } : {}) })
        if (entries.length > 100) throw new Error('The project directory exceeds the read limit.')
      }
    }
  }
  return entries
}

function fetchSource(url: string, signal: AbortSignal, redirect: 'error' | 'manual' = 'error'): Promise<Response> {
  return fetch(url, { credentials: 'same-origin', mode: 'same-origin', redirect, cache: 'no-store', signal })
}

async function boundedBody(response: Response, maxBytes: number) {
  if (response.body === null) throw new Error('The document source did not return a body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('The source exceeds the read limit.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

async function fetchCurrentVersion(url: string, selector: string, signal: AbortSignal): Promise<string> {
  const response = await fetchSource(url, signal)
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
    await response.body?.cancel().catch(() => {})
    throw new VersionedDocumentError(response.status === 401 ? 'document-login-required' : 'document-source-unavailable')
  }
  // An inert template lets us compare metadata without running or loading the response's page content.
  const template = document.createElement('template')
  template.innerHTML = new TextDecoder().decode(await boundedBody(response, MAX_HTML_BYTES))
  return versionText(only(template.content, selector, true))
}

async function imageMaterial(image: HTMLImageElement, index: number, signal: AbortSignal) {
  if (!image.checkVisibility(visibility)) return undefined
  const url = linkUrl(image.currentSrc || image.src)
  if (url === undefined || url.origin !== location.origin || /token|secret|password|credential|authorization/i.test(url.search)) return undefined
  const response = await fetchSource(url.href, signal, 'manual')
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]
  const size = Number(response.headers.get('content-length'))
  if (!response.ok || (mimeType !== 'image/png' && mimeType !== 'image/jpeg') || size < 1 || size > MAX_IMAGE_BYTES) {
    await response.body?.cancel()
    return undefined
  }
  const data = await boundedBody(response, MAX_IMAGE_BYTES)
  const valid = mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => data[i] === byte)
    : data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217
  if (!valid) return undefined
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return { kind: 'file' as const, name: `wiki-image-${index + 1}`, mimeType, base64: btoa(binary),
    hash: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') }
}

export async function readLocalDocument(url: string, input: unknown, includeImages = true) {
  const spec = localDocumentSpec.parse(input)
  if (window !== window.top || location.href !== url) throw new VersionedDocumentError('target-navigated')
  const pageVersion = () => {
    const element = only(document, spec.versionSelector, true)
    return element instanceof HTMLMetaElement || element.checkVisibility(visibility) ? versionText(element) : ''
  }
  const version = pageVersion()
  if (!version || version.length > 200 || redactSensitivePageText(document.body, version) !== version) {
    throw new Error('The page does not expose a usable document version.')
  }
  if (navigator.serviceWorker?.controller != null) throw new Error('Source freshness cannot be established through a page service worker.')
  const signal = AbortSignal.timeout(8000)
  const fresh = await fetchCurrentVersion(url, spec.versionSelector, signal)
  if (location.href !== url) throw new VersionedDocumentError('target-navigated')
  if (!fresh || fresh.length > 200 || navigator.serviceWorker?.controller != null) {
    throw new VersionedDocumentError('document-source-unavailable')
  }
  if (fresh !== version || pageVersion() !== version) {
    throw new VersionedDocumentError('document-version-stale')
  }
  const title = only(document, spec.titleSelector), body = only(document, spec.contentSelector)
  if (!(title instanceof HTMLElement) || !(body instanceof HTMLElement) || !title.checkVisibility(visibility) || !body.checkVisibility(visibility)) {
    throw new Error('The document is not visible in the selected tab.')
  }
  const content = redactSensitivePageText(body, body.innerText.trim())
  if (/^\[(Component text|Sensitive page text) withheld:/.test(content)) throw new Error('The document exceeds the safe read limit.')
  const fields = { title: redactSensitivePageText(title, title.innerText.trim()), version }
  if (spec.includeProjectEntries) return localDocumentResult.parse({ ...fields, content: content.slice(0, 12_000), projectEntries: projectEntries(body) })
  if (!includeImages) return localDocumentResult.parse({ ...fields, content })
  const images = Array.from(body.querySelectorAll('img')).slice(0, 3)
  const materials = (await Promise.all(images.map((image, index) => imageMaterial(image, index, signal)))).filter(value => value !== undefined)
  if (location.href !== url) throw new VersionedDocumentError('target-navigated')
  if (pageVersion() !== version || !body.isConnected) throw new VersionedDocumentError('document-version-stale')
  return localDocumentResult.parse({ ...fields, content, materials })
}
