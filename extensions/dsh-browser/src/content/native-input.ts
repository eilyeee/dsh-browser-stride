/** Native pointer/keyboard intervention invalidates observations, never grants authority. */
import { resetDeltaState } from './actions.ts'
import type { ElementIds } from './ids.ts'
import { visualViewportState } from './visual.ts'

export function watchNativeInput(ids: ElementIds, notify?: () => void): () => void {
  const invalidate = (event: Event) => {
    if (!event.isTrusted) return
    resetDeltaState(ids)
    visualViewportState.dispose()
    notify?.()
  }
  for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, invalidate, true)
  return () => { for (const name of ['pointerdown', 'keydown']) window.removeEventListener(name, invalidate, true) }
}
