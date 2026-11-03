import type { BrowserTaskTargetLoss, ToolExecutionScope } from '@eilyeee/dsh-browser-stride/src/protocol.ts'
import type { ToolTargetLease } from './target-leases.ts'

export interface RunTargetBinding { readonly id: string; current(): boolean; accept(): boolean }
interface Binding { scope: Extract<ToolExecutionScope, { kind: 'run' }>; sessionId: string; id: string; target: ToolTargetLease; awaiting: boolean; lost: boolean }

/** Worker-owned tab lifetime/binding pins; never infer identity from page text. */
export class RunTargetRegistry {
  private owner = {}
  private readonly entries = new Map<string, Binding>()
  private readonly prepared = new Map<string, { key: string; binding: Binding }>()
  constructor(private readonly capacity = 5000, private readonly makeId = () => `page_${crypto.randomUUID()}`) {}

  /** A user-selected future revision; never usable as an unscoped first pin. */
  prepare(scope: Extract<ToolExecutionScope, { kind: 'run' }>, sessionId: string, target: ToolTargetLease): Pick<RunTargetBinding, 'id' | 'current'> | undefined {
    const key = JSON.stringify([scope.runId, scope.controlRevision])
    if (!target.current() || this.entries.has(key) || [...this.prepared.values()].some(value => value.key === key)
      || this.entries.size + this.prepared.size >= this.capacity) return
    const binding: Binding = { scope: { ...scope }, sessionId, id: this.makeId(), target, awaiting: true, lost: false }
    this.prepared.set(binding.id, { key, binding })
    const owner = this.owner
    return Object.freeze({ id: binding.id, current: () => this.owner === owner && !binding.lost && binding.target.current()
      && (this.prepared.get(binding.id)?.binding === binding || this.entries.get(key) === binding) })
  }

  discardPrepared(id: string): void { this.prepared.delete(id) }

  join(scope: Extract<ToolExecutionScope, { kind: 'run' }>, sessionId: string, target: ToolTargetLease, expected?: string): RunTargetBinding | undefined {
    if (!target.current()) return
    const key = JSON.stringify([scope.runId, scope.controlRevision])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      if (expected !== undefined) {
        const prepared = this.prepared.get(expected)
        // A missing pin after restart cannot be recreated from a Host's old id.
        if (prepared?.key !== key || prepared.binding.lost || prepared.binding.sessionId !== sessionId || !prepared.binding.target.current()) return
        entry = prepared.binding
        this.prepared.delete(expected)
      } else {
        if (this.entries.size + this.prepared.size >= this.capacity || [...this.prepared.values()].some(value => value.key === key)) return
        entry = { scope: { ...scope }, sessionId, id: this.makeId(), target, awaiting: false, lost: false }
      }
      this.entries.set(key, entry)
    }
    if (entry.lost || entry.sessionId !== sessionId || (expected !== undefined && entry.id !== expected)
      || !entry.target.sameBinding() || entry.target.target.tabId !== target.target.tabId
      || entry.target.target.windowId !== target.target.windowId) return
    const binding = entry
    const owner = this.owner
    const current = () => this.owner === owner && !binding.lost && this.entries.get(key) === binding
      && binding.target.sameBinding() && (!binding.awaiting || binding.target.current())
    return Object.freeze({ id: entry.id, current, accept: () => {
      if (!current() || !target.current()) return false
      binding.awaiting = false
      return true
    } })
  }

  /** One-way revocation, including native pins still waiting for startup. */
  takeLost(): { payload: BrowserTaskTargetLoss; owned(): boolean }[] {
    const result: { payload: BrowserTaskTargetLoss; owned(): boolean }[] = []
    const owner = this.owner
    const visit = (key: string, binding: Binding) => {
      if (binding.lost || (binding.target.sameBinding() && (!binding.awaiting || binding.target.current()))) return
      binding.lost = true
      result.push({ payload: { runId: binding.scope.runId, controlRevision: binding.scope.controlRevision,
        sessionId: binding.sessionId, targetBinding: binding.id },
        owned: () => this.owner === owner && (this.entries.get(key) === binding || this.prepared.get(binding.id)?.binding === binding) })
    }
    for (const [key, binding] of this.entries) visit(key, binding)
    for (const { key, binding } of this.prepared.values()) visit(key, binding)
    return result
  }

  revokeAll(): void { this.owner = {}; this.entries.clear(); this.prepared.clear() }
}
