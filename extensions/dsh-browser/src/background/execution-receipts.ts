import { isToolActionIdentity, type ServerFrame, type ToolActionIdentity } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import { computeToolCommandDigest } from '@eilyeee/dsh-browser-stride/src/tool-identity.ts'
import type { ToolAnswer } from './tools.ts'

const DATABASE = 'dsh-browser-execution'
const STORE = 'receipts'
/** Never evict automatically: forgetting an id would permit its replay. */
const CAPACITY = 5000
interface Receipt extends ToolActionIdentity { phase: 'admitted' | 'finished'; createdAt: number; finishedAt?: number }
type Admission = 'admitted' | 'duplicate' | 'conflict'

function validReceipt(value: unknown): value is Receipt {
  if (!isToolActionIdentity(value)) return false
  const row = value as Receipt
  return (row.phase === 'admitted' || row.phase === 'finished')
    && Number.isSafeInteger(row.createdAt) && row.createdAt >= 0
    && (row.phase === 'admitted' ? row.finishedAt === undefined
      : Number.isSafeInteger(row.finishedAt) && row.finishedAt! >= row.createdAt)
    && Object.keys(row).every(key => ['actionId', 'requestDigest', 'phase', 'createdAt', 'finishedAt'].includes(key))
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'actionId' }) }
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close() }
      resolve(request.result)
    }
    request.onerror = () => { reject(new Error('Execution receipt storage is unavailable')) }
    request.onblocked = () => { blocked = true; reject(new Error('Execution receipt storage is blocked')) }
  })
}

/** Atomic across worker lifetimes and extension contexts; commits before return. */
export async function admitExecution(action: ToolActionIdentity): Promise<Admission> {
  if (!isToolActionIdentity(action)) throw new TypeError('Invalid execution identity')
  const identity = { actionId: action.actionId, requestDigest: action.requestDigest }
  const db = await database()
  try {
    return await new Promise<Admission>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite', { durability: 'strict' })
      const store = transaction.objectStore(STORE)
      let decision: Admission | undefined
      const existing = store.get(identity.actionId)
      existing.onsuccess = () => {
        if (existing.result !== undefined) {
          if (!validReceipt(existing.result)) { transaction.abort(); return }
          decision = existing.result.requestDigest === identity.requestDigest ? 'duplicate' : 'conflict'
          return
        }
        const count = store.count()
        count.onsuccess = () => {
          if (count.result >= CAPACITY) { transaction.abort(); return }
          store.add({ ...identity, phase: 'admitted', createdAt: Date.now() } satisfies Receipt)
          decision = 'admitted'
        }
      }
      transaction.oncomplete = () => { decision === undefined ? reject(new Error('Missing execution admission')) : resolve(decision) }
      transaction.onerror = transaction.onabort = () => { reject(new Error('Execution receipt could not be committed')) }
    })
  } finally { db.close() }
}

/** Only metadata is retained; neither reply payload nor a success claim is cached. */
export async function finishExecution(action: ToolActionIdentity): Promise<void> {
  if (!isToolActionIdentity(action)) throw new TypeError('Invalid execution identity')
  const identity = { actionId: action.actionId, requestDigest: action.requestDigest }
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite', { durability: 'strict' })
      const store = transaction.objectStore(STORE)
      const request = store.get(identity.actionId)
      request.onsuccess = () => {
        const row: unknown = request.result
        if (!validReceipt(row) || row.requestDigest !== identity.requestDigest) { transaction.abort(); return }
        if (row.phase === 'admitted') store.put({ ...row, phase: 'finished', finishedAt: Math.max(Date.now(), row.createdAt) } satisfies Receipt)
      }
      transaction.oncomplete = () => { resolve() }
      transaction.onerror = transaction.onabort = () => { reject(new Error('Execution completion could not be committed')) }
    })
  } finally { db.close() }
}

type WireCall = Extract<ServerFrame, { t: 'tool.call' }>
const failure = (code: 'action-duplicate' | 'action-conflict' | 'receipt-unavailable' | 'action-failed', message: string): ToolAnswer => ({ ok: false, error: { code, message } })

/** A duplicate is refused, including after restart; it is never re-executed. */
export async function executeRecordedTool(call: WireCall, signal: AbortSignal, work: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
  const cancelled = (): boolean => signal.aborted || Date.now() >= call.expiresAt
  try {
    const digest = await computeToolCommandDigest({ ...call, actionId: call.action.actionId })
    if (digest !== call.action.requestDigest) return failure('action-conflict', 'Action digest does not match this command; this attempt was not executed')
    if (cancelled()) return failure('action-failed', 'Tool call was cancelled before execution admission')
    const admission = await admitExecution(call.action)
    if (admission === 'conflict') return failure('action-conflict', 'Action id is already bound to another command; this attempt was not executed')
    if (admission === 'duplicate') return failure('action-duplicate', 'This action was previously admitted and may have executed. Reconcile using a new observation; it was not executed again')
  } catch { return failure('receipt-unavailable', 'Execution admission could not be committed; this attempt was not executed. Earlier results may be unknown') }
  let answer: ToolAnswer
  try { answer = cancelled() ? failure('action-failed', 'Tool call was cancelled after admission') : await work() }
  catch { answer = failure('action-failed', 'Browser execution failed; the result may be unknown') }
  try { await finishExecution(call.action) }
  catch { return failure('receipt-unavailable', 'Execution completion could not be committed; the result may be unknown. Do not repeat the action') }
  return answer
}
