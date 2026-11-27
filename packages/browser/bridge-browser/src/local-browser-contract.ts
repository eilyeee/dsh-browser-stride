import { z } from 'zod'
import { isExactHttpOrigin } from './iframe-scopes.ts'

export const LOCAL_BROWSER_PATH = '/ext/local-browser'
export const LOCAL_REQUEST_PREFIX = 'local:'

export const localPageUrl = z.string().max(2048).transform((value, ctx) => {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048) return url.href
  } catch { /* rejected below */ }
  ctx.addIssue({ code: 'custom', message: 'Expected a credential-free HTTP(S) page URL' })
  return z.NEVER
})

export function isAutonomousWikiUrl(value: unknown): value is string {
  const parsed = localPageUrl.safeParse(value)
  if (!parsed.success || parsed.data !== value) return false
  const url = new URL(parsed.data)
  return (url.protocol === 'https:' || ['127.0.0.1', '[::1]'].includes(url.hostname))
    && url.pathname === '/pages/viewpage.action' && !url.hash && url.searchParams.size === 1
    && /^[1-9]\d{0,19}$/.test(url.searchParams.get('pageId') ?? '')
}

const selector = z.string().trim().min(1).max(500)
export const localDocumentSpec = z.strictObject({
  titleSelector: selector,
  contentSelector: selector,
  versionSelector: selector,
  includeProjectEntries: z.literal(true).optional(),
})

export const versionedDocumentRequest = localDocumentSpec.extend({ expectedUrl: localPageUrl })

export function isAutonomousWikiTool(name: string, args: Record<string, unknown>): boolean {
  if (args.localAutonomousWiki !== true) return false
  if (name === 'browser_open_tab') return Object.keys(args).length === 3 && args.active === false && isAutonomousWikiUrl(args.url)
  if (args.frame !== 0 || !isAutonomousWikiUrl(args.localPageUrl)) return false
  return name === 'browser_reload' && Object.keys(args).length === 3
    || name === 'browser_get_text' && Object.keys(args).length === 4 && localDocumentSpec.safeParse(args.localDocument).success
}

export const DOCUMENT_READ_MESSAGES = {
  'document-login-required': 'Sign in to the selected document in Chrome, then read it again.',
  'document-version-stale': 'Reload the selected document in Chrome before reading it again.',
  'document-source-unavailable': 'Check that the selected document opens and exposes a readable version. Verify the document selectors and sign in if prompted.',
} as const
export type DocumentReadErrorCode = keyof typeof DOCUMENT_READ_MESSAGES

export function documentReadGuidance(code: string): string | undefined {
  return Object.hasOwn(DOCUMENT_READ_MESSAGES, code)
    ? DOCUMENT_READ_MESSAGES[code as DocumentReadErrorCode] : undefined
}

export const localDocumentResult = z.strictObject({
  title: z.string().min(1).max(160),
  content: z.string().min(10).max(12000),
  version: z.string().min(1).max(200),
  materials: z.array(z.strictObject({ kind: z.literal('file'), name: z.string().regex(/^wiki-image-[1-3]$/),
    mimeType: z.enum(['image/png', 'image/jpeg']), base64: z.base64().max(341_336), hash: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(3).optional(),
  projectEntries: z.array(z.strictObject({
    name: z.string().min(1).max(100), repositoryUrl: z.string().max(2048),
    permissionUrls: z.array(localPageUrl).max(20).optional(),
  })).max(100).optional(),
})

const expectedUrl = localPageUrl
const operationId = z.uuidv4().transform(value => value.toLowerCase())
const elementRef = z.string().min(1).max(200)
const jenkinsBranch = z.string().max(500).regex(/^(?:feat-\d+|merge-\d+(?:-\d+)+)$/)
export const JENKINS_BRANCH_FIELD = '[name="parameter"]:has(> input[type="hidden"][name="name"][value="BRANCH"]) input[name="value"]'
export const jenkinsQueueId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const localFormFill = z.strictObject({
  formSelector: selector.optional(),
  fields: z.array(z.strictObject({ selector, value: z.string().max(2000) })).min(1).max(16),
  jenkinsQueueReceipt: z.literal(true).optional(),
}).refine(form => form.jenkinsQueueReceipt !== true || (form.fields.length === 1
  && form.fields[0]?.selector === JENKINS_BRANCH_FIELD
  && jenkinsBranch.safeParse(form.fields[0].value).success), 'Jenkins queue receipts require exactly the verified BRANCH field')

export function requestsJenkinsQueueReceipt(name: string, args: Record<string, unknown>): boolean {
  return name === 'browser_click' && typeof args.localPageUrl === 'string'
    && (args.localFormFill as { jenkinsQueueReceipt?: unknown } | undefined)?.jenkinsQueueReceipt === true
}
export const localJsonUrl = localPageUrl.refine(value => {
  const url = new URL(value)
  return url.pathname.endsWith('/api/json') && !url.hash
}, 'Expected a read-only /api/json URL')
export const localJenkinsLog = z.strictObject({
  url: localPageUrl.refine(value => {
    const url = new URL(value)
    return /^(?:\/[A-Za-z0-9_.$-]+)*\/job\/[A-Za-z0-9_.-]+\/[1-9]\d*\/consoleText$/.test(url.pathname)
      && !url.search && !url.hash
  }),
  repository: localPageUrl.refine(value => {
    const url = new URL(value)
    return !url.search && !url.hash && /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(url.pathname)
  }),
  branch: jenkinsBranch,
})
export const localOperationId = operationId
const iframeDiscovery = z.strictObject({ origin: z.string().refine(isExactHttpOrigin) })
const iframeTarget = iframeDiscovery.extend({ frame: z.number().int().positive() })
export const localBrowserRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('snapshot'), expectedUrl, region: selector.optional(), iframe: iframeDiscovery.optional() }),
  z.strictObject({ action: z.literal('text'), expectedUrl, selector: selector.optional(), iframe: iframeTarget.optional() }),
  z.strictObject({ action: z.literal('json'), expectedUrl, url: localJsonUrl }),
  z.strictObject({ action: z.literal('jenkins-log'), expectedUrl, log: localJenkinsLog }),
  z.strictObject({ action: z.literal('document'), expectedUrl, document: localDocumentSpec, autoOpen: z.literal(true).optional() }),
  z.strictObject({ action: z.literal('navigate'), expectedUrl, operationId, url: localPageUrl }),
  z.strictObject({ action: z.literal('click'), expectedUrl, operationId, elementRef, formFill: localFormFill.optional(), iframe: iframeTarget.optional() }),
  z.strictObject({ action: z.literal('type'), expectedUrl, operationId, elementRef, text: z.string().min(1).max(2000), replace: z.boolean().optional(), iframe: iframeTarget.optional() }),
  z.strictObject({ action: z.literal('select'), expectedUrl, operationId, elementRef, optionIndex: z.number().int().min(0).max(19), iframe: iframeTarget.optional() }),
])

const iframeActionArgs = new Map<string, string[]>([
  ['browser_snapshot', ['region']], ['browser_get_text', ['selector']], ['browser_click', ['elementRef']],
  ['browser_type', ['elementRef', 'text', 'replace']], ['browser_select', ['elementRef', 'optionIndex']],
])

/** The iframe path carries only ordinary DOM operations from the local service. */
export function isLocalIframeTool(name: string, args: Record<string, unknown>): boolean {
  const allowed = iframeActionArgs.get(name)
  if (allowed === undefined || typeof args.localPageUrl !== 'string' || !isExactHttpOrigin(args.localIframeOrigin)) return false
  if (typeof args.frame !== 'number' || !Number.isSafeInteger(args.frame)
    || (name === 'browser_snapshot' ? args.frame !== 0 : args.frame <= 0)) return false
  return Object.keys(args).every(key => key === 'localPageUrl' || key === 'localIframeOrigin' || key === 'frame' || allowed.includes(key))
}
