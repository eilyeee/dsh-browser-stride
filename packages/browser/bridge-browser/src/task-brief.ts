import { defineDomain, domainTable, type DomainFacility, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { TaskBrief, TaskBriefInput } from './task-brief-contract.ts'
export * from './task-brief-contract.ts'

const id = z.string().min(1).max(200).refine(value => value.trim() === value)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = (max: number) => z.string().trim().max(max).refine(value =>
  !/\bBearer\s+\S+|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/i.test(value), 'Do not store credentials in task notes')
export function safeMaterialUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return value === value.trim() && !/[\u0000-\u0020\u007f]/.test(value)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /^(?:token|access_token|api[_-]?key|password|authorization)$/i.test(key))
      && !/[?&#](?:token|access_token|api[_-]?key|password|authorization)=/i.test(url.hash)
  } catch { return false }
}
export const taskBriefInputSchema = z.strictObject({
  goal: text(2000), projectPath: text(1000),
  materials: z.array(z.strictObject({ url: z.string().max(2000).refine(safeMaterialUrl), label: text(120),
    role: z.enum(['unknown', 'requirement', 'design', 'api', 'reference']),
    inferredRole: z.enum(['requirement', 'design', 'api', 'reference']).optional() })).max(8)
    .refine(items => new Set(items.map(item => item.url)).size === items.length),
  criteria: z.array(z.strictObject({ id, text: text(400).refine(value => value.length > 0) })).max(16)
    .refine(items => new Set(items.map(item => item.id)).size === items.length),
})
export const progressInputSchema = z.strictObject({
  criterionId: id, implementation: z.enum(['pending', 'implemented', 'blocked']),
  observation: z.enum(['unverified', 'observed', 'uncertain']),
  evidence: z.array(text(500).refine(value => value.length > 0)).max(4), nextStep: text(500),
}).superRefine((value, ctx) => {
  if (value.observation === 'observed' && value.evidence.length === 0) ctx.addIssue({ code: 'custom', message: 'Observed results need evidence' })
  if ((value.observation === 'uncertain' || value.implementation === 'blocked') && value.nextStep === '') ctx.addIssue({ code: 'custom', message: 'Blocked or uncertain results need a next step' })
})
const recordSchema = taskBriefInputSchema.extend({ sessionId: id, version: counter, updatedAt: counter,
  userEdited: z.boolean(), progress: z.array(progressInputSchema.safeExtend({ userConfirmed: z.boolean() })).max(16),
}).superRefine((value, ctx) => {
  if (new Set(value.progress.map(item => item.criterionId)).size !== value.progress.length
    || value.progress.some(item => !value.criteria.some(criterion => criterion.id === item.criterionId)
      || (item.userConfirmed && (item.observation !== 'observed' || item.implementation !== 'implemented')))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid criterion progress' })
  }
})
function specification(profile: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new TypeError('invalid profile')
  return defineDomain({ name: `browser_briefs_${Buffer.from(profile).toString('hex')}`, version: 1,
    tables: { briefs: domainTable(recordSchema) } })
}
type BriefDomain = Domain<ReturnType<typeof specification>>
export class TaskBriefError extends Error {
  constructor(readonly code: 'bad-request' | 'stale-version' | 'user-edited' | 'storage-unavailable' | 'closed' | 'cancelled' | 'not-found' | 'limit') { super(`Task notes: ${code}`) }
}
export class TaskBriefStore {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private faulted = false
  private disposal?: Promise<void>
  private constructor(private readonly domain: BriefDomain) {}
  static async open(facility: Pick<DomainFacility, 'open'>, profile: string): Promise<TaskBriefStore> {
    const domain = await facility.open(specification(profile))
    try {
      for (const [key, value] of domain.table('briefs').entries()) if (key !== value.sessionId) throw new Error('Invalid task notes key')
      return new TaskBriefStore(domain)
    } catch (error) { await domain.close(); throw error }
  }
  get(sessionId: string): TaskBrief {
    if (this.closed) throw new TaskBriefError('closed')
    if (this.faulted) throw new TaskBriefError('storage-unavailable')
    if (!id.safeParse(sessionId).success) throw new TaskBriefError('bad-request')
    const record = this.domain.table('briefs').get(sessionId)
    return structuredClone(record ?? { sessionId, version: 0, updatedAt: 0, userEdited: false,
      goal: '', projectPath: '', materials: [], criteria: [], progress: [] })
  }
  save(sessionId: string, version: number, input: TaskBriefInput, author: 'user' | 'model', signal?: AbortSignal): Promise<TaskBrief> {
    return this.mutate(sessionId, version, signal, old => {
      const parsed = taskBriefInputSchema.safeParse(input)
      if (!parsed.success) throw new TaskBriefError('bad-request')
      if (author === 'model' && old.userEdited) throw new TaskBriefError('user-edited')
      const unchanged = parsed.data.goal === old.goal && parsed.data.projectPath === old.projectPath
        && JSON.stringify(parsed.data.materials) === JSON.stringify(old.materials)
      return { ...old, ...parsed.data, userEdited: author === 'user', progress: unchanged
        ? old.progress.filter(item => parsed.data.criteria.some(criterion => criterion.id === item.criterionId
          && old.criteria.some(previous => previous.id === criterion.id && previous.text === criterion.text))) : [] }
    })
  }
  report(sessionId: string, version: number, input: unknown, signal?: AbortSignal): Promise<TaskBrief> {
    return this.mutate(sessionId, version, signal, old => {
      const parsed = progressInputSchema.safeParse(input)
      if (!parsed.success || !old.criteria.some(item => item.id === parsed.data?.criterionId)) throw new TaskBriefError('bad-request')
      return { ...old, progress: [...old.progress.filter(item => item.criterionId !== parsed.data.criterionId), { ...parsed.data, userConfirmed: false }] }
    })
  }
  classify(sessionId: string, version: number, input: unknown, signal?: AbortSignal): Promise<TaskBrief> {
    return this.mutate(sessionId, version, signal, old => {
      const parsed = z.strictObject({ url: z.string(), role: z.enum(['requirement', 'design', 'api', 'reference']) }).safeParse(input)
      if (!parsed.success) throw new TaskBriefError('bad-request')
      const material = old.materials.find(item => item.url === parsed.data.url)
      if (!material) throw new TaskBriefError('not-found')
      if (material.role !== 'unknown') throw new TaskBriefError('user-edited')
      return { ...old, materials: old.materials.map(item => item.url === parsed.data.url ? { ...item, inferredRole: parsed.data.role } : item) }
    })
  }
  review(sessionId: string, version: number, criterionId: string, confirmed: boolean, signal?: AbortSignal): Promise<TaskBrief> {
    return this.mutate(sessionId, version, signal, old => {
      const item = old.progress.find(item => item.criterionId === criterionId)
      if (!item || (confirmed && (item.implementation !== 'implemented' || item.observation !== 'observed'))) throw new TaskBriefError('bad-request')
      return { ...old, progress: old.progress.map(item => item.criterionId === criterionId ? { ...item, userConfirmed: confirmed } : item) }
    })
  }
  purge(sessionId: string): Promise<void> {
    return this.exclusive(async () => { try { await this.domain.table('briefs').delete(sessionId) }
      catch { this.faulted = true; throw new TaskBriefError('storage-unavailable') } })
  }
  close(): Promise<void> { this.closed = true; return this.disposal ??= this.tail.then(() => this.domain.close()) }
  private mutate(sessionId: string, version: number, signal: AbortSignal | undefined, change: (old: TaskBrief) => TaskBrief): Promise<TaskBrief> {
    return this.exclusive(async () => {
      if (signal?.aborted) throw new TaskBriefError('cancelled')
      const old = this.get(sessionId)
      if (!counter.safeParse(version).success || old.version !== version) throw new TaskBriefError('stale-version')
      if (old.version === 0 && [...this.domain.table('briefs').entries()].length >= 1000) throw new TaskBriefError('limit')
      const next = recordSchema.parse({ ...change(old), version: old.version + 1, updatedAt: Math.max(Date.now(), old.updatedAt) })
      try { await this.domain.table('briefs').put(sessionId, next) }
      catch { this.faulted = true; throw new TaskBriefError('storage-unavailable') }
      return structuredClone(next)
    })
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new TaskBriefError('closed'))
    const result = this.tail.then(() => { if (this.faulted) throw new TaskBriefError('storage-unavailable'); return work() })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
