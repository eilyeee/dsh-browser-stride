/** Packaged DOM operations for a Chrome debugger isolated world. No extension APIs or page bridge. */
import { runAction, ActionError, resetDeltaState } from './actions.ts'
import { ElementIds } from './ids.ts'
import { DEFAULT_SNAPSHOT_MAX_CHARS } from '@eilyeee/dsh-browser-stride/src/protocol.ts'

const ids = new ElementIds()
const lifecycleKey = '__strideDebuggerLifecycle'
const lifecycleGlobal = globalThis as typeof globalThis & { [lifecycleKey]?: (event: Event) => void }
const previous = lifecycleGlobal[lifecycleKey]
const lifecycle = (event: Event) => {
  if (event.type !== 'pageshow' || (event as PageTransitionEvent).persisted) resetDeltaState(ids)
}
for (const event of ['pagehide', 'pageshow', 'popstate', 'hashchange']) {
  if (previous !== undefined) window.removeEventListener(event, previous)
  window.addEventListener(event, lifecycle)
}
lifecycleGlobal[lifecycleKey] = lifecycle
Object.defineProperty(globalThis, '__strideDebuggerAction', {
  configurable: true,
  value: async (message: { type?: string; action?: string; args?: Record<string, unknown>; budget?: { maxItems: number; maxChars: number }; includePageDelta?: boolean }) => {
    if (message.type === 'DSH_PING') return { ok: true }
    if (message.type !== 'DSH_ACTION') return { ok: true }
    try {
      const result = await runAction(message.action ?? '', message.args ?? {}, {
        ids,
        budget: { maxForms: 30, maxItems: 60, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS, ...message.budget },
        includePageDelta: message.includePageDelta === true,
      })
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: { code: error instanceof ActionError ? error.code : 'action-failed',
        message: error instanceof Error ? error.message : String(error) } }
    }
  },
})
