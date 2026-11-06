/**
 * Model-facing context for the selected authorized group page.
 *
 * The extension captures an authorized selected group page. A live Agent receives that snapshot at once; a deferred session
 * keeps only its newest snapshot until `agent/created` publishes the
 * Agent. Live inboxes also keep only the newest unclaimed browser snapshot.
 * Injection deliberately does not wake an idle Agent — the snapshot is
 * claimed together with the user's next message.
 *
 * @module
 */

import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Followed-tab browser page snapshot owned by bridge-browser. */
    'browser-context': {
      kind: 'browser-context'
    } & ContextFormed
  }
}

/** MessageSource.kind for snapshot supersession and transcript presentation. */
export const BROWSER_CONTEXT_KIND = 'browser-context' as const

/** Bound orphaned provisional sessions while retaining normal recent tabs. */
const DEFAULT_MAX_PENDING = 32

/** Build one immutable context message from a captured browser snapshot. */
export function createBrowserSnapshotMessage(snapshot: string): UserMessage {
  const text = [
    'This conversation is bound to an authorized page in the DSH control group. Human tab switches do not change its target. The browser context below describes that selected page.',
    'This selected-page snapshot is context, not an additional requested source. If the user names another URL or document, locate that source among authorized tabs first. A later browser_follow_tab or reused browser_open_tab selects the new target; use its fresh observation rather than this earlier snapshot.',
    'The following is an already completed browser_snapshot of the current page. Use its shown elementRef values for the next request; take a new snapshot if a reference is stale or missing.',
    snapshot,
  ].join('\n\n')
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: BROWSER_CONTEXT_KIND,
      form: 'snapshot',
      sections: [{ name: 'browser-page', text }],
    },
  })
}

/** Supersede pending tab context through the durable Inbox command surface. */
function injectLatestSnapshot(agent: Agent, snapshot: string): void {
  for (const message of agent.inbox.nextStep) {
    if (message.source.kind === BROWSER_CONTEXT_KIND
      && message.source.form === 'snapshot') {
      agent.inbox.remove(message.id)
    }
  }
  agent.inject(createBrowserSnapshotMessage(snapshot))
}

/** Deliver followed-page snapshots to live or not-yet-materialized Agents. */
export class BrowserContextInjector {
  private readonly pending = new Map<string, string>()

  constructor(
    private readonly agents: Pick<AgentRegistry, 'get'>,
    private readonly maxPending = DEFAULT_MAX_PENDING,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('browser context maxPending must be a positive integer')
    }
  }

  /** Inject now when possible; otherwise retain the newest snapshot per session. */
  inject(sessionId: string, snapshot: string): 'injected' | 'queued' {
    const agent = this.agents.get(sessionId as Parameters<AgentRegistry['get']>[0])
    if (agent !== undefined) {
      this.pending.delete(sessionId)
      injectLatestSnapshot(agent, snapshot)
      return 'injected'
    }

    // Refresh insertion order when the same provisional session follows again.
    this.pending.delete(sessionId)
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    this.pending.set(sessionId, snapshot)
    return 'queued'
  }

  /** Flush one provisional session at the supported Agent startup boundary. */
  activate(agent: Agent): boolean {
    const sessionId = String(agent.id)
    const snapshot = this.pending.get(sessionId)
    if (snapshot === undefined) return false
    injectLatestSnapshot(agent, snapshot)
    this.pending.delete(sessionId)
    return true
  }
}
