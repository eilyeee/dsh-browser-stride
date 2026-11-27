import { jenkinsQueueId, localFormFill, localJenkinsLog, localJsonUrl, localPageUrl } from '@eilyeee/dsh-browser-stride/src/local-browser-contract.ts'
import { isSensitiveField } from './privacy.ts'

/** Preflight all controls before the caller can submit. */
export function fillLocalPostForm(element: Element, expectedUrl: string, value: unknown) {
  const { formSelector, fields, jenkinsQueueReceipt } = localFormFill.parse(value)
  const submit = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : undefined
  const form = submit?.form
  if (submit === undefined || form == null || !form.contains(submit) || submit.type !== 'submit' || submit.matches(':disabled')
    || submit.hasAttribute('formaction') || submit.hasAttribute('formmethod') || submit.hasAttribute('formtarget')
    || form.method !== 'post' || form.action !== expectedUrl || location.href !== expectedUrl
    || !['', '_self'].includes(form.target.toLowerCase()) || document.querySelector('base[target]') !== null
    || formSelector !== undefined && !form.matches(formSelector)) {
    throw new Error('The observed button is not the submit control of the expected same-page POST form.')
  }
  const seen = new Set<Element>()
  const changes = fields.map(({ selector, value }) => {
    const matches = form.querySelectorAll(selector)
    const field = matches[0]
    if (matches.length !== 1 || !(field instanceof HTMLInputElement) || field.type !== 'text'
      || field.form !== form || field.matches(':disabled') || field.readOnly || isSensitiveField(field) || seen.has(field)) {
      throw new Error('A required form field is missing, ambiguous or not an editable text input.')
    }
    seen.add(field)
    return { field, value, original: field.value }
  })
  const enqueue = jenkinsQueueReceipt ? jenkinsQueueSubmission(form, expectedUrl, fields[0]!.value) : undefined
  for (const { field, value } of changes) field.value = value
  if (changes.some(({ field, value }) => field.value !== value || !field.validity.valid)) {
    for (const { field, original } of changes) field.value = original
    throw new Error('The page did not accept the exact form values.')
  }
  return enqueue
}

function jenkinsQueueSubmission(form: HTMLFormElement, expectedUrl: string, branch: string) {
  const page = new URL(expectedUrl)
  if (!/^(?:\/[A-Za-z0-9_.$-]+)*\/job\/[A-Za-z0-9_.-]+\/build$/.test(page.pathname)
    || page.search !== '?delay=0sec' || page.hash || navigator.serviceWorker?.controller != null) {
    throw new Error('Expected a classic Jenkins build form.')
  }
  const endpoint = new URL('buildWithParameters', page)
  const queuePath = page.pathname.split('/job/')[0] + '/queue/item/'
  const configuredField = document.head.getAttribute('data-crumb-header')
  const configuredValue = document.head.getAttribute('data-crumb-value')
  const crumbField = configuredField || 'Jenkins-Crumb'
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(crumbField) || /^(branch|delay|token|json)$/i.test(crumbField)
    || Boolean(configuredField) !== Boolean(configuredValue)) throw new Error('Invalid Jenkins crumb configuration.')
  const crumbs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')).filter(input => input.name === crumbField)
  const crumb = crumbs[0]
  if (crumbs.length > 1 || (crumb !== undefined && (crumb.form !== form || crumb.matches(':disabled')))
    || (configuredValue && crumb?.value !== configuredValue)) throw new Error('Ambiguous Jenkins form crumb.')
  const body = new URLSearchParams({ BRANCH: branch })
  if (crumb?.value) body.set(crumbField, crumb.value)
  return async (): Promise<number | undefined> => {
    try {
      // Manual redirects prevent a second request or silently adopting a previously queued build.
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', mode: 'same-origin',
        redirect: 'manual', cache: 'no-store', body, signal: AbortSignal.timeout(10_000) })
      const receipt = response.headers.get('Location')
      if (response.status !== 201 || receipt === null || navigator.serviceWorker?.controller != null) return
      const target = new URL(receipt, endpoint)
      if (target.origin !== page.origin || target.username || target.password || target.search || target.hash
        || !target.pathname.startsWith(queuePath)) return
      const number = /^([1-9]\d*)\/$/.exec(target.pathname.slice(queuePath.length))?.[1]
      const parsed = jenkinsQueueId.safeParse(Number(number))
      if (parsed.success) return parsed.data
    } catch { /* A request may already have reached Jenkins. Return no receipt. */ }
  }
}

export async function readLocalJson(value: unknown): Promise<string> {
  const url = new URL(localJsonUrl.parse(value))
  const text = await readLocalResponse(url, 'application/json', 180_000)
  JSON.parse(text)
  return text
}

export async function readLocalJenkinsCheckout(value: unknown): Promise<{ checkoutSha: string | null }> {
  const spec = localJenkinsLog.parse(value)
  const url = new URL(spec.url)
  const job = new URL('../', url)
  const console = new URL('console', url).href
  const page = location.href
  if (![job.href, new URL('build?delay=0sec', job).href, console].includes(page)) {
    throw new Error('Select the exact Jenkins Job or original build.')
  }
  const text = await readLocalResponse(url, 'text/plain', 8 * 1024 * 1024)
  if (location.href !== page) throw new Error('The selected Jenkins page changed.')
  const checkoutSha = jenkinsCheckoutSha(text, new URL(spec.repository), spec.branch)
  return { checkoutSha }
}

function jenkinsCheckoutSha(log: string, repository: URL, branch: string): string | null {
  const lines = log.trimEnd().split(/\r?\n/).map(line => line.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /, ''))
  if (lines.at(-1) !== 'Finished: SUCCESS') return null
  const key = (url: URL) => url.host + url.pathname.replace(/\/$/, '').replace(/\.git$/, '')
  const expected = key(repository)
  let selected = false
  let candidate: string | undefined
  let observed: string | null = null
  for (const line of lines) {
    const remote = /^(?:Cloning repository |>\s+git config remote\.origin\.url )(\S+)/.exec(line)
    if (remote) {
      const parsed = localPageUrl.safeParse(remote[1])
      selected = parsed.success && key(new URL(parsed.data)) === expected
      candidate = undefined
    }
    if (!selected) continue
    const revision = /^Checking out Revision ([a-f0-9]{40}) \(([^)]+)\)$/.exec(line)
    if (revision) {
      if (observed !== null && revision[1] !== observed
        || !['origin/' + branch, 'refs/remotes/origin/' + branch].includes(revision[2]!)) return null
      candidate = revision[1]
    }
    const command = /^>\s+git checkout (?:-f )?([a-f0-9]{40})(?:\s+# timeout=\d+)?$/.exec(line)
    if (command) {
      if ((candidate !== undefined && command[1] !== candidate) || (observed !== null && command[1] !== observed)) return null
      if (candidate !== undefined) observed = candidate
    }
  }
  return observed
}

async function readLocalResponse(url: URL, mimeType: string, maxBytes: number): Promise<string> {
  if (url.origin !== location.origin) throw new Error('The endpoint must belong to the authorized page.')
  if (navigator.serviceWorker?.controller != null) throw new Error('A page service worker controls the source.')
  const response = await fetch(url, {
    method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: mimeType },
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The endpoint returned no body.')
  try {
    if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== mimeType) {
      throw new Error('The endpoint did not return the expected response type.')
    }
    const decoder = new TextDecoder()
    let size = 0
    let text = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > maxBytes) throw new Error('The response exceeded its size limit.')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    if (navigator.serviceWorker?.controller != null) throw new Error('A page service worker took control of the source.')
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
