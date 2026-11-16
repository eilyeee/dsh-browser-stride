/** Bounded diagnostic metadata. No messages, header values, bodies or original URLs. */
import { z } from 'zod'

export const DIAGNOSTIC_LIMIT = 200
const ROUTE_WORDS = new Set(['api', 'v1', 'v2', 'v3', 'assets', 'static', 'js', 'css', 'index', 'app', 'main', 'health', 'status',
  'user', 'users', 'account', 'accounts', 'session', 'login', 'logout', 'customer', 'customers', 'clue', 'clues', 'channel', 'channels',
  'project', 'projects', 'task', 'tasks', 'requirement', 'requirements', 'config', 'settings', 'state', 'list', 'detail', 'query', 'page',
  'search', 'get', 'set', 'save', 'update', 'create', 'delete', 'collect', 'collection', 'home'])
const PRIVATE_KEYS = new Set(['token', 'secret', 'password', 'credential', 'key', 'code', 'email', 'phone', 'id'])

/** Fixed-vocabulary route template; arbitrary path segments are never copied. */
export function diagnosticRoute(raw: string): string {
  if (raw.length > 4096) return '/[segment]'
  let pathname: string
  try { pathname = new URL(raw, 'https://diagnostic.invalid').pathname } catch { return '/[segment]' }
  let hidden = false
  return '/' + pathname.split('/').filter(Boolean).slice(0, 12).map(part => {
    const word = part.toLowerCase(), privateKey = PRIVATE_KEYS.has(word)
    const safe = !hidden && !privateKey && ROUTE_WORDS.has(word) ? word : '[segment]'
    hidden = privateKey
    return safe
  }).join('/')
}
const route = z.string().max(256).refine(value => value === diagnosticRoute(value))
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const base = { sequence: integer, observedAt: integer }
export const diagnosticEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('console'), level: z.enum(['error', 'warning']),
    errorType: z.enum(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError']).optional(),
    route: route.optional(), line: integer.optional(), column: integer.optional() }),
  z.strictObject({ ...base, kind: z.literal('network'), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']),
    resourceType: z.enum(['document', 'script', 'stylesheet', 'image', 'fetch', 'xhr', 'other']), route, sameOrigin: z.boolean(),
    status: z.number().int().min(100).max(599).optional(), failure: z.enum(['http-error', 'network-error', 'blocked', 'cancelled']).optional(),
    durationMs: z.number().finite().min(0).max(600_000).optional() }),
])
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>
export const diagnosticsSchema = z.strictObject({
  version: z.literal(1), captureId: z.string().regex(/^diag_[a-f0-9-]{36}$/), startedAt: integer,
  scope: z.literal('authorized-top-document'), complete: z.literal(false),
  omitted: z.array(z.enum(['past-events', 'subframes', 'workers', 'messages', 'headers', 'bodies', 'query-values', 'raw-paths', 'buffer-overflow'])).max(9),
  dropped: integer, entries: z.array(diagnosticEntrySchema).max(DIAGNOSTIC_LIMIT),
})
export type DiagnosticsSnapshot = z.infer<typeof diagnosticsSchema>
