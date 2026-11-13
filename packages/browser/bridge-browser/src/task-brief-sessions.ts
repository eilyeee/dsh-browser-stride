import { isRecord, type BrowserHostApi, type HostRpcResult } from './host-api.ts'
import { TaskBriefError, taskBriefInputSchema, type TaskBriefStore } from './task-brief.ts'
import type { TaskBriefInput } from './task-brief-contract.ts'

async function retain(api: BrowserHostApi, sessionId: string, signal: AbortSignal): Promise<HostRpcResult> {
  signal.throwIfAborted()
  return api.retainSession?.(sessionId, signal)
    ?? api.call({ rpcId: crypto.randomUUID(), method: 'session.history', payload: { sessionId }, signal })
}
/** Save only after the original provisional Session is durable; no prompt is sent. */
export async function saveSessionBrief(api: BrowserHostApi, store: TaskBriefStore, sessionId: string, version: number, input: TaskBriefInput, signal: AbortSignal) {
  if (!taskBriefInputSchema.safeParse(input).success) throw new TaskBriefError('bad-request')
  if (store.get(sessionId).version !== version) throw new TaskBriefError('stale-version')
  const kept = await retain(api, sessionId, signal)
  signal.throwIfAborted()
  if (!kept.ok) throw new TaskBriefError('session-unavailable')
  return store.save(sessionId, version, input, 'user', signal)
}
/** Explicit history selection can recover older orphan notes into an idle default-workspace Session.
 * Saved paths never choose the workspace, and no chat history or model turn is invented. */
export async function openSessionBrief(api: BrowserHostApi, store: TaskBriefStore, sessionId: string, signal: AbortSignal) {
  if (store.get(sessionId).version === 0) throw new TaskBriefError('not-found')
  let kept = await retain(api, sessionId, signal)
  signal.throwIfAborted()
  if (!kept.ok && ['not-found', 'session/not-found'].includes(kept.error.code)) {
    const created = await api.call({ rpcId: crypto.randomUUID(), method: 'session.create', payload: { sessionId }, signal })
    signal.throwIfAborted()
    if (!created.ok) throw new TaskBriefError('session-unavailable')
    kept = await retain(api, sessionId, signal)
  }
  if (!kept.ok) throw new TaskBriefError('session-unavailable')
  signal.throwIfAborted()
  return { sessionId }
}
/** Overlay the extension's history picker without turning notes into fake chat messages. */
export function briefSessionItems(items: unknown[], store: TaskBriefStore | undefined, includeOrphans: boolean): unknown[] {
  if (store === undefined) return items
  let saved
  try { saved = store.list() } catch { return items }
  const notes = new Map(saved.map(brief => [brief.sessionId, brief]))
  const projected = items.map(item => {
    if (!isRecord(item) || typeof item.sessionId !== 'string') return item
    const brief = notes.get(item.sessionId)
    notes.delete(item.sessionId)
    if (brief === undefined) return item
    const projection = isRecord(item.projections) ? item.projections : {}
    const values = isRecord(projection.values) ? projection.values : {}
    return { ...item, blank: false, updatedAt: Math.max(typeof item.updatedAt === 'number' ? item.updatedAt : 0, brief.updatedAt),
      ...(item.blank === true ? { notesOnly: true } : {}),
      projections: { ...projection, values: { ...values, title: typeof values.title === 'string' && values.title.trim() !== ''
        ? values.title : brief.goal.slice(0, 120) || '任务资料 / Saved task notes' } } }
  })
  if (includeOrphans) for (const brief of notes.values()) projected.push({ sessionId: brief.sessionId, updatedAt: brief.updatedAt,
    running: false, blank: false, notesOnly: true, projections: { asOfSeq: -1, values: { title: brief.goal.slice(0, 120) || '任务资料 / Saved task notes' } } })
  return projected
}
