/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { pageText, truncate } from './extract.ts'
import { SELECT_OPTION_LIMIT, type ElementIds } from './ids.ts'
import { isControlDisabled, isFieldReadOnly } from './custom-options.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshotDetails, resolveSnapshotRegion } from './snapshot.ts'
import { parseElementRef, type ObservationId } from '@eilyeee/dsh-browser-stride/src/contracts/ids.ts'
import { visualViewportState } from './visual.ts'
import { measureLayout } from './layout.ts'
import { componentText } from './component-text.ts'
import { DOCUMENT_READ_MESSAGES, versionedDocumentRequest, type DocumentReadErrorCode } from '@eilyeee/dsh-browser-stride/src/local-browser-contract.ts'
import { readLocalDocument, VersionedDocumentError } from './local-document.ts'
import { fillLocalPostForm, readLocalJenkinsCheckout, readLocalJson } from './local-guarded-forms.ts'
import { isSensitiveField } from './privacy.ts'
import { OPEN_TREE_LIMITS, queryOpenRoots } from './dom-tree.ts'
import { changeDesignZoom, nativeDesignZoomControls } from './design-zoom.ts'
import { DesignZoomNotSelectedError } from './design-zoom-error.ts'
import { clearLanhuZoom, commitLanhuZoom, prepareLanhuZoom } from './lanhu-zoom.ts'
import type { DesignZoomStep } from '../design-zoom-step.ts'
import type { VisualObservation } from '@eilyeee/dsh-browser-stride/src/visual.ts'
import type { ContentObservation } from '@eilyeee/dsh-browser-stride/src/snapshot-observation.ts'
import type { SnapshotView } from './snapshot.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  document?: Awaited<ReturnType<typeof readLocalDocument>>
  observation?: ContentObservation
  feedback?: { version: 1; state: 'observed' | 'dispatched' | 'readback-unconfirmed'; businessChange: 'not-verified' }
  designZoomStep?: DesignZoomStep
  /** Packaged controller metadata, never constructed by page-world scripts. */
  visual?: VisualObservation
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
  jenkinsQueueId?: number
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000
const TYPABLE_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week'])

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. Watch accessible open roots as well as the
 * document, including roots attached to existing hosts during the wait. This
 * is bounded DOM quiet, not network/framework readiness or business success.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let checkQueued = false
  let finished = false
  let observer: MutationObserver | undefined
  const roots = new Set<ShadowRoot>()
  let incomplete = false
  const observeOptions = { subtree: true, childList: true, attributes: true, characterData: true }

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      roots.clear()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      checkQueued = false
      discoverRoots()
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if (!incomplete && afterReady >= policy.minimumMs && quietFor >= policy.quietMs) {
          finish(true)
          return
        }
        if (afterReady >= policy.maxAfterReadyMs) {
          finish(false)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, incomplete ? Math.max(1, policy.maxAfterReadyMs - afterReady)
          : Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      // Keep the first queued check: faster mutation streams must not keep
      // cancelling it and thereby postpone even the hard wait deadline.
      if (finished || checkQueued) return
      if (timer !== undefined) clearTimeout(timer)
      checkQueued = true
      timer = setTimeout(check, 0)
    }
    function discoverRoots(): void {
      if (incomplete || observer === undefined) return
      const scan = queryOpenRoots(document, '*')
      if (scan.limited) { incomplete = true; return }
      for (const element of scan.elements) {
        const root = element.shadowRoot
        if (root === null || roots.has(root)) continue
        // Bound cumulative subscriptions too, even if components churn during
        // a wait. Incomplete observation must never be reported as quiet.
        if (roots.size >= OPEN_TREE_LIMITS.roots) { incomplete = true; return }
        observer.observe(root, observeOptions)
        roots.add(root)
        lastMutationAt = performance.now()
      }
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(records => {
        if (!records.some(record => record.target.isConnected)) return
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, observeOptions)
      discoverRoots()
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function settleNote(settled: boolean): string {
  return settled ? '' : ' The page did not become quiet within the limit; re-observe before continuing.'
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('element-stale', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current references.`)
  }
  if (ids.isActionTargetCurrent?.(index) === false) {
    throw new ActionError('element-stale', `Element [${index}] changed, disappeared or is not actionable. Call browser_snapshot again.`)
  }
  return el
}

function referenceArg(args: Record<string, unknown>, ids: ElementIds, needsOptions = false): number {
  const index = ids.resolveReference(args.elementRef, needsOptions)
  if (index === undefined) {
    throw new ActionError('element-stale', 'The element reference is missing, stale, or was not fully shown in the current observation. Call browser_snapshot again and use its elementRef. Update the bridge and extension together.')
  }
  return index
}

function referenceStillCurrent(args: Record<string, unknown>, ids: ElementIds, index: number, needsOptions = false): boolean {
  return ids.resolveReference(args.elementRef, needsOptions) === index && ids.isActionTargetCurrent?.(index) !== false
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'element-stale' | 'field-readonly' | 'action-failed' | 'bad-args' | 'guarded-form-rejected' | 'design-zoom-not-selected' | 'target-navigated' | 'content-unavailable' | DocumentReadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write, rechecking identity between page event handlers. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string, stillCurrent: () => boolean): boolean {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  if (!stillCurrent()) return false
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return stillCurrent()
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Installed controllers require a fresh observation before DOM input. */
  requireObservation?: boolean
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
  /** Child-frame observations label their origin without the iframe's login URL. */
  scopedIframe?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  if (args.localPageUrl !== undefined && ctx.scopedIframe !== true && (window !== window.top || location.href !== args.localPageUrl)) {
    throw new ActionError('target-navigated', 'This request targets a different page.')
  }
  if (ctx.requireObservation === true && ['browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_set_design_zoom'].includes(action)
    && !ctx.ids.hasCurrentObservation()) throw new ActionError('element-stale', 'The page was reloaded or native input changed its context. Take a fresh snapshot before DOM input.')
  // Capture the caller's reference before awaiting page events. Another call
  // may publish a different observation while this action is settling.
  ctx = { ...ctx }
  if (['browser_click', 'browser_type', 'browser_select', 'browser_scroll'].includes(action) && typeof args.elementRef === 'string') {
    const base = parseElementRef(args.elementRef)?.observationId
    if (base !== undefined) actionBaseByContext.set(ctx, base)
  }
  switch (action) {
    case 'browser_screenshot': {
      await waitForPageSettled(ACTION_SETTLE)
      return { text: 'Screenshot viewport prepared.', visual: visualViewportState.capture() }
    }
    case 'browser_visual_check': return { text: 'Screenshot viewport checked.', visual: visualViewportState.check(args.screenshotRef) }
    case 'browser_click_at': {
      visualViewportState.click(args.screenshotRef, args.x, args.y)
      const settled = await waitForPageSettled(ACTION_SETTLE)
      return withPageDelta(`Sent a synthetic coordinate click.${settleNote(settled)}`, ctx, settled)
    }
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_select':
      return selectAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args, ctx)
    case 'browser_back':
      return historyAction(-1, ctx)
    case 'browser_forward':
      return historyAction(1, ctx)
    case 'browser_reload':
      return reloadAction(ctx)
    case 'browser_get_text':
      return getTextAction(args, ctx)
    case 'browser_measure_layout': {
      const scope = args.elementRef === undefined ? document : readScope(args, ctx)
      try { return { text: JSON.stringify(measureLayout(args, scope)) } }
      catch (error) { throw new ActionError('action-failed', error instanceof Error ? error.message : 'Layout could not be measured.') }
    }
    case 'browser_set_design_zoom':
      try {
        if (args.phase === 'prepare' && nativeDesignZoomControls().length === 0) {
          // prepareLanhuZoom can open a menu, but never selects a percentage.
          // Commit/readback failures below deliberately cannot use this code.
          let step: DesignZoomStep | undefined
          try { step = await prepareLanhuZoom(args.percent) }
          catch (error) { throw new DesignZoomNotSelectedError(error instanceof Error ? error.message : 'Design zoom menu preparation failed.') }
          if (step !== undefined) return { text: 'Lanhu zoom menu prepared; selection needs a fresh authority check.', designZoomStep: step }
        }
        const readback = args.phase === 'commit' ? commitLanhuZoom(args.ticket, args.percent) : changeDesignZoom(args.percent)
        const settled = await waitForPageSettled(ACTION_SETTLE)
        const result = readback()
        return withPageDelta('Design zoom control readback: ' + result.before + '% → ' + result.percent + '%. '
          + (result.changed ? 'Changed once. ' : 'Already at this scale. ')
          + 'Take a fresh screenshot; control readback alone is not proof of canvas rendering.', ctx, settled)
      } catch (error) {
        throw new ActionError(error instanceof DesignZoomNotSelectedError ? 'design-zoom-not-selected' : 'action-failed',
          error instanceof Error ? error.message : 'Design zoom could not be confirmed.')
      }
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const previous = snapshotByRegistry.get(ctx.ids) ?? null
  if (args.baseObservationId !== undefined && (typeof args.baseObservationId !== 'string' || args.baseObservationId.trim() === '' || args.baseObservationId.length > 200)) {
    throw new ActionError('bad-args', 'baseObservationId must be a non-empty observation ID of at most 200 characters.')
  }
  let scope: ReturnType<typeof resolveSnapshotRegion>
  try { scope = resolveSnapshotRegion(args.region as string | undefined) }
  catch (error) { throw new ActionError('bad-args', error instanceof Error ? error.message : 'Invalid snapshot region.') }
  const { region, element: regionNode } = scope
  const lastSnapshot = previous?.view.url === location.href ? previous.view : null
  const base = typeof args.baseObservationId === 'string' ? args.baseObservationId.trim() : undefined
  const fallback = base === undefined ? 'missing-base'
    : lastSnapshot === null || base !== lastSnapshot.observationId ? 'base-unavailable'
    : previous!.regionNode !== regionNode || lastSnapshot.region !== region ? 'region-changed'
    : !previous!.renderComplete ? 'previous-render-clipped'
    : !sameBudget(previous!.budget, ctx.budget) ? 'budget-changed' : undefined
  const delta = args.delta === true && fallback === undefined
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  if (args.delta === true && fallback !== undefined) view.deltaFallback = fallback
  const rendered = renderSnapshotDetails(view, delta, undefined, ctx.scopedIframe ? location.origin : view.url)
  snapshotByRegistry.set(ctx.ids, { view, budget: { ...ctx.budget }, regionNode, renderComplete: rendered.renderComplete })
  ctx.ids.publishObservation(view.observationId, rendered.targets, rendered.selects)
  return { text: rendered.text, observation: snapshotObservation(view, delta, rendered.renderComplete) }
}

function snapshotObservation(view: SnapshotView, delta: boolean, renderComplete: boolean): ContentObservation {
  return { version: 1, observationId: view.observationId, ...(delta && view.baseObservationId ? { baseObservationId: view.baseObservationId } : {}),
    kind: delta ? 'delta' : 'snapshot', observedAt: Date.now(), complete: false, renderComplete,
    textScope: view.region === undefined ? 'main-text' : 'region-text', redaction: 'recognized-sensitive-values',
    omitted: { mainCharacters: view.truncated.mainChars, controls: view.truncated.itemsDropped, fields: view.truncated.formsDropped,
      selectsWithOmittedOptions: view.forms.filter(form => form.optionsTruncated).length, openTreeLimited: view.truncated.openTreeLimited === true } }
}

/** Delta state belongs to the content-script registry, not another instance. */
const snapshotByRegistry = new WeakMap<ElementIds, { view: ReturnType<typeof buildSnapshot>; budget: SnapshotBudget; regionNode: Element | null; renderComplete: boolean }>()
const actionBaseByContext = new WeakMap<ActionContext, ObservationId>()
function sameBudget(a: SnapshotBudget, b: SnapshotBudget): boolean {
  return a.maxItems === b.maxItems && a.maxForms === b.maxForms && a.maxChars === b.maxChars
}

/** Invalidate delta state after navigation (new document). */
export function resetDeltaState(ids: ElementIds): void {
  clearLanhuZoom()
  snapshotByRegistry.delete(ids)
  ids.clearObservation()
}

/** A partial field edit is not undone by retiring its observation. */
function unconfirmedFieldTarget(index: number, ctx: ActionContext, reason = 'the target changed during page events'): ActionResult {
  resetDeltaState(ctx.ids)
  return {
    text: `Field [${index}] may have partially changed, but ${reason}. Re-observe and check its state before continuing.`,
    feedback: { version: 1, state: 'readback-unconfirmed', businessChange: 'not-verified' },
  }
}

/** Attach bounded feedback; only a completely rendered result can seed a delta. */
function withPageDelta(text: string, ctx: ActionContext, settled = true, state: 'observed' | 'dispatched' | 'readback-unconfirmed' = 'dispatched'): ActionResult {
  const feedback = { version: 1 as const, state, businessChange: 'not-verified' as const }
  if (!settled) {
    resetDeltaState(ctx.ids)
    return { text, feedback }
  }
  const previous = snapshotByRegistry.get(ctx.ids) ?? null
  if (ctx.includePageDelta !== true || previous === null) return { text, feedback }
  const lastSnapshot = previous.view.url === location.href ? previous.view : null
  const delta = lastSnapshot !== null && previous.renderComplete && lastSnapshot.region === undefined
    && actionBaseByContext.get(ctx) === lastSnapshot.observationId
    && previous.budget.maxItems === ctx.budget.maxItems && previous.budget.maxForms === ctx.budget.maxForms
  const view = buildSnapshot(ctx.ids, { delta, budget: ctx.budget }, lastSnapshot)
  const rendered = renderSnapshotDetails(view, delta, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS), ctx.scopedIframe ? location.origin : view.url)
  snapshotByRegistry.set(ctx.ids, { view, budget: { ...ctx.budget }, regionNode: null, renderComplete: rendered.renderComplete })
  ctx.ids.publishObservation(view.observationId, rendered.targets, rendered.selects)
  return {
    text,
    feedback,
    pageContent: rendered.text,
    observation: snapshotObservation(view, delta, rendered.renderComplete),
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = referenceArg(args, ctx.ids)
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  // Synchronous scroll handlers can change the page before activation.
  referenceArg(args, ctx.ids)
  elementOrThrow(ctx.ids, index)
  if (args.localFormFill !== undefined) {
    if (typeof args.localPageUrl !== 'string') throw new ActionError('bad-args', 'A guarded form requires a local browser service.')
    let enqueue
    try { enqueue = fillLocalPostForm(el, args.localPageUrl, args.localFormFill) }
    catch { throw new ActionError('guarded-form-rejected', 'The guarded form changed or cannot accept the exact values. No submit control was activated.') }
    if (enqueue !== undefined) {
      const jenkinsQueueId = await enqueue()
      return jenkinsQueueId === undefined
        ? { text: 'The original Jenkins queue receipt is unavailable.',
          feedback: { version: 1, state: 'readback-unconfirmed', businessChange: 'not-verified' } }
        : { text: 'Read the new Jenkins queue ID from this submission.', jenkinsQueueId }
    }
    ;(el as HTMLElement).click()
    return { text: 'Sent one click to the verified POST form. Check the service for its result.', navigationPending: true }
  }
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { if (referenceStillCurrent(args, ctx.ids, index)) el.click() }, 0)
        return {
          text: `Scheduled native browser activation for link [${index}]; its outcome is not confirmed. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch once: in browsers this also performs the link's native
      // default activation unless a page handler cancels it. Assigning the
      // URL again would issue a second navigation.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        const settled = await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].${settleNote(settled)}`, ctx, settled)
      }
      if (!referenceStillCurrent(args, ctx.ids, index)) {
        resetDeltaState(ctx.ids)
        return { text: `Click was sent to link [${index}], but its target changed during page events. Its outcome is unknown; re-observe and check the result before continuing.` }
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        const settled = await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].${settleNote(settled)}`, ctx, settled)
      }
      // Native activation can unload the content script before its reply. A
      // lost response is an unknown result, not permission to click again.
      return {
        text: `Click was sent to link [${index}]; navigation is not confirmed. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { if (referenceStillCurrent(args, ctx.ids, index)) el.click() }, 0)
    return { text: `Link [${index}] activation was scheduled but is not confirmed. It may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button [${index}] is disabled.`)
  }
  ;(el as HTMLElement).click()
  const settled = await waitForPageSettled(ACTION_SETTLE)
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const observed = el.isConnected ? (el.checked ? 'checked' : 'unchecked') : 'unavailable (element was removed)'
    return withPageDelta(`Clicked [${index}]. Observed control state: ${observed}; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled, el.isConnected ? 'observed' : 'readback-unconfirmed')
  }
  return withPageDelta(`Clicked [${index}].${settleNote(settled)}`, ctx, settled)
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (typeof el.isContentEditable === 'boolean' ? el.isContentEditable : editingHost(el) !== null)
}

/** Rendered plain text only; formatting and business persistence remain unverified. */
function editorText(host: HTMLElement): string {
  const text = typeof host.innerText === 'string' ? host.innerText : host.textContent ?? ''
  return normalizeEditorText(text)
}
function normalizeEditorText(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ') }

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` uses the browser's editing pipeline. The bridge
 * offers a synthetic cancelable beforeinput because the command does not
 * consistently emit it (MDN: Web/API/Document/execCommand). Hosts without the
 * command keep the direct-write fallback. A present command that fails or
 * throws is never followed by another write: it may have been cancelled or
 * partially applied by the editor.
 *
 * @param host - the verified editable host.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(host: HTMLElement, text: string, replace: boolean, stillCurrent: () => boolean): boolean {
  host.focus()
  const doc = host.ownerDocument
  if (!stillCurrent() || doc.activeElement !== host) return false
  const selection = doc.getSelection()
  if (selection === null) return false
  const range = doc.createRange()
  range.selectNodeContents(host)
  // A caret collapsed to the end appends; a full selection is replaced by insertText.
  if (!replace) range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
  const boundary = { start: range.startContainer, from: range.startOffset, end: range.endContainer, to: range.endOffset }
  // execCommand does not consistently emit beforeinput across browsers. Offer
  // cancellation explicitly and never suppress any browser-emitted event.
  if (!host.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true,
  }))) return false
  if (!stillCurrent() || doc.activeElement !== host || selection.rangeCount !== 1) return false
  const current = selection.getRangeAt(0)
  if (current.startContainer !== boundary.start || current.startOffset !== boundary.from
    || current.endContainer !== boundary.end || current.endOffset !== boundary.to) return false
  if (typeof doc.execCommand === 'function') {
    try {
      return doc.execCommand('insertText', false, text) && stillCurrent()
    } catch {
      return false
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
  return stillCurrent()
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = referenceArg(args, ctx.ids)
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)
  if (args.localPageUrl !== undefined && isSensitiveField(el)) throw new ActionError('bad-args', 'Fill sensitive fields manually.')
  if (isFieldReadOnly(el)) throw new ActionError('field-readonly', `Field [${index}] is read-only for direct editing. Do not force this edit; choose another writable control or ask the user.`)
  const editableHost = !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isEditable(el)
    ? editingHost(el) ?? el : undefined
  if (editableHost?.getRootNode() instanceof ShadowRoot) {
    throw new ActionError('bad-args', 'Rich-text editing inside a shadow root is not supported. Do not force or retry this edit.')
  }
  const stillCurrent = (): boolean => referenceStillCurrent(args, ctx.ids, index)
    && !isFieldReadOnly(el)
    && (!(el instanceof HTMLInputElement) || TYPABLE_INPUT_TYPES.has(el.type))
    && (editableHost === undefined || (isEditable(el) && (editingHost(el) ?? el) === editableHost))
  let expectedValue: string | undefined
  if (!stillCurrent()) throw new ActionError('action-failed', `Element [${index}] is read-only or does not support text input.`)
  if (editableHost !== undefined) {
    expectedValue = normalizeEditorText((replace ? '' : editorText(editableHost)) + text)
    if (!typeIntoContentEditable(editableHost, text, replace, stillCurrent)) {
      return unconfirmedFieldTarget(index, ctx, 'the editor did not confirm the input command')
    }
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    expectedValue = `${replace ? '' : el.value}${text}`
    if ((replace && !setNativeValue(el, '', stillCurrent)) || !setNativeValue(el, `${el.value}${text}`, stillCurrent)) {
      return unconfirmedFieldTarget(index, ctx)
    }
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  const settled = await waitForPageSettled(TYPE_SETTLE)
  if (!stillCurrent()) return unconfirmedFieldTarget(index, ctx)
  if (editableHost !== undefined && editorText(editableHost) !== expectedValue) {
    return withPageDelta(`Input was sent to [${index}], but the editor text could not be confirmed at readback. Observe again before continuing.${settleNote(settled)}`, ctx, settled, 'readback-unconfirmed')
  }
  if (expectedValue !== undefined && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    && (!el.isConnected || el.value !== expectedValue)) {
    return withPageDelta(`Input was sent to [${index}], but its value could not be confirmed at readback. Observe again before continuing.${settleNote(settled)}`, ctx, settled, 'readback-unconfirmed')
  }
  if (expectedValue !== undefined) {
    return withPageDelta(`Entered ${text.length} characters into [${index}]. The field value was read back; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled, 'observed')
  }
  return withPageDelta(`Entered ${text.length} characters into [${index}].${settleNote(settled)}`, ctx, settled)
}

async function selectAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = referenceArg(args, ctx.ids, true)
  const optionIndex = numberArg(args, 'optionIndex')
  const el = elementOrThrow(ctx.ids, index)
  if (!(el instanceof HTMLSelectElement) || el.multiple) {
    throw new ActionError('action-failed', `Element [${index}] is not a supported single-select control.`)
  }
  if (args.localPageUrl !== undefined && isSensitiveField(el)) throw new ActionError('bad-args', 'Fill sensitive fields manually.')
  if (isFieldReadOnly(el)) throw new ActionError('field-readonly', `Field [${index}] is read-only for direct editing. Do not force this edit; choose another writable control or ask the user.`)
  const option = optionIndex < SELECT_OPTION_LIMIT ? el.options.item(optionIndex) : null
  if (option === null || option.matches(':disabled')) {
    throw new ActionError('bad-args', 'The option is unavailable or was not included in the snapshot.')
  }
  el.selectedIndex = optionIndex
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  const stillCurrent = (): boolean => referenceStillCurrent(args, ctx.ids, index, true) && !isFieldReadOnly(el)
  if (!stillCurrent()) {
    return unconfirmedFieldTarget(index, ctx)
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (!stillCurrent()) {
    return unconfirmedFieldTarget(index, ctx)
  }
  const settled = await waitForPageSettled(TYPE_SETTLE)
  if (!stillCurrent()) return unconfirmedFieldTarget(index, ctx)
  if (!el.isConnected || !option.isConnected || el.selectedIndex !== optionIndex || !option.selected) {
    return withPageDelta(`Selection was sent to [${index}], but could not be confirmed at readback. Observe again before continuing.${settleNote(settled)}`, ctx, settled, 'readback-unconfirmed')
  }
  return withPageDelta(`Selected option ${optionIndex} in [${index}]. The control state was read back; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled, 'observed')
}

/** Named control keys have layout-independent legacy codes used by Vue 2 widgets. */
const CONTROL_KEYS: Record<string, readonly [string, number]> = {
  Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], ' ': ['Space', 32],
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '' || key.length > 64 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new ActionError('bad-args', 'key must be a non-empty KeyboardEvent.key value of at most 64 characters without control characters.')
  }
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  const target = active instanceof HTMLElement ? active : document.body
  if (target.getRootNode() instanceof ShadowRoot && !ctx.ids.isObservedActionTarget(target)) {
    throw new ActionError('element-stale', 'The focused shadow control was not exposed by the current observation. Take a fresh snapshot before sending keys.')
  }
  if (isControlDisabled(target)) throw new ActionError('bad-args', 'The focused control is disabled or inert; re-observe before sending keys.')
  const control = Object.hasOwn(CONTROL_KEYS, key) ? CONTROL_KEYS[key] : undefined
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true,
    ...(control === undefined ? {} : { code: control[0], keyCode: control[1], which: control[1] }) }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  const settled = await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent synthetic key events for ${JSON.stringify(key)}; native key behavior is not guaranteed. Page handlers may have caused effects; re-observe and check before continuing.${settleNote(settled)}`, ctx, settled)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
  if (!['up', 'down', 'top', 'bottom'].includes(direction)) {
    throw new ActionError('bad-args', 'direction must be up, down, top, or bottom.')
  }
  if ((direction === 'up' || direction === 'down') && args.amount !== undefined
    && (typeof args.amount !== 'number' || !Number.isFinite(args.amount) || args.amount <= 0 || args.amount > 100_000)) {
    throw new ActionError('bad-args', 'amount must be a finite positive number of at most 100000 pixels.')
  }
  if (args.elementRef !== undefined) {
    const index = referenceArg(args, ctx.ids)
    elementOrThrow(ctx.ids, index)
    const container = ctx.ids.scrollContainerFor(index)
    if (container === undefined) throw new ActionError('element-stale', 'The observed scroll container is missing or changed. Take a fresh snapshot; omit elementRef only to scroll the viewport.')
    const style = getComputedStyle(container)
    if (style.flexDirection === 'column-reverse' || (style.writingMode !== '' && style.writingMode !== 'horizontal-tb')) {
      throw new ActionError('bad-args', 'Reverse-flow and vertical-writing scroll containers are not supported.')
    }
    const before = container.scrollTop
    const max = container.scrollHeight - container.clientHeight
    const amount = typeof args.amount === 'number' ? args.amount : Math.max(1, Math.floor(container.clientHeight * 0.8))
    const destination = direction === 'top' ? 0 : direction === 'bottom' ? max
      : Math.max(0, Math.min(max, before + (direction === 'up' ? -amount : amount)))
    container.scrollTo({ top: destination, behavior: 'instant' })
    const settled = await waitForPageSettled(SCROLL_SETTLE)
    if (!referenceStillCurrent(args, ctx.ids, index) || ctx.ids.scrollContainerFor(index) !== container) {
      resetDeltaState(ctx.ids)
      return { text: 'Scroll was sent, but its observed container changed. Re-observe before continuing.',
        feedback: { version: 1, state: 'readback-unconfirmed', businessChange: 'not-verified' } }
    }
    const after = container.scrollTop
    const confirmed = Math.abs(after - destination) <= 1
    return withPageDelta(`Scroll position in the observed container: ${Math.round(before)} → ${Math.round(after)} px; requested ${Math.round(destination)}, read back ${Math.round(after)}.`
      + (destination === before ? ' It was already at the requested boundary; no outer container was scrolled.' : '')
      + (confirmed ? ' Position readback does not verify loaded content or a saved change.' : ' Requested position was not confirmed; re-observe before continuing.')
      + settleNote(settled), ctx, settled, confirmed ? 'observed' : 'readback-unconfirmed')
  }
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  const settled = await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.${settleNote(settled)}`, ctx, settled)
}

async function navigateAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState(ctx.ids)
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => {
    if (args.localPageUrl === undefined || location.href === args.localPageUrl) location.href = parsed.href
  }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1, ctx: ActionContext): Promise<ActionResult> {
  resetDeltaState(ctx.ids)
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(ctx: ActionContext): ActionResult {
  resetDeltaState(ctx.ids)
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

/** A read scope keeps the observed identity boundary without granting write access. */
function readScope(args: Record<string, unknown>, ctx: ActionContext): Document | ShadowRoot {
  const index = referenceArg(args, ctx.ids)
  const element = ctx.ids.elementByIndex(index)
  if (element === undefined || !ctx.ids.isReadTargetCurrent(index)) {
    throw new ActionError('element-stale', 'The observed read scope changed or disappeared. Take a fresh snapshot.')
  }
  const root = element.getRootNode()
  if (root instanceof Document || root instanceof ShadowRoot && root.mode === 'open') return root
  throw new ActionError('element-stale', 'The observed read scope is no longer accessible. Take a fresh snapshot.')
}

async function versionedDocumentAction(url: string, spec: unknown, includeImages: boolean): Promise<ActionResult> {
  try {
    return { text: 'Read versioned document.', document: await readLocalDocument(url, spec, includeImages) }
  } catch (error) {
    if (error instanceof VersionedDocumentError) throw new ActionError(error.code, error.message)
    throw new ActionError('document-source-unavailable', DOCUMENT_READ_MESSAGES['document-source-unavailable'])
  }
}

async function getTextAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  if (args.document !== undefined) {
    const parsed = versionedDocumentRequest.safeParse(args.document)
    if (!parsed.success) throw new ActionError('bad-args', 'Use an exact document URL and three valid selectors.')
    const { expectedUrl, ...spec } = parsed.data
    return versionedDocumentAction(expectedUrl, spec, false)
  }
  if (typeof args.localPageUrl === 'string') {
    if (args.localJsonUrl !== undefined) return { text: await readLocalJson(args.localJsonUrl) }
    if (args.localJenkinsLog !== undefined) return { text: JSON.stringify(await readLocalJenkinsCheckout(args.localJenkinsLog)) }
    if (args.localDocument !== undefined) {
      return versionedDocumentAction(args.localPageUrl, args.localDocument, true)
    }
    const matches = typeof args.selector === 'string' ? document.querySelectorAll(args.selector) : undefined
    if (matches !== undefined && matches.length !== 1) throw new ActionError('bad-args', 'Choose a selector that matches one element.')
    const { text, truncated } = truncate(componentText(matches?.[0] ?? document), 8_000)
    return { text: text + (truncated > 0 ? `\n(Truncated ${truncated} characters.)` : '') }
  }
  if (args.elementRef !== undefined) {
    const scope = readScope(args, ctx)
    let source: Document | ShadowRoot | Element = scope
    if (args.selector !== undefined) {
      if (typeof args.selector !== 'string' || args.selector.trim() === '' || args.selector.length > 500) {
        throw new ActionError('bad-args', 'selector must be a non-empty CSS selector of at most 500 characters.')
      }
      let matches: NodeListOf<Element>
      try { matches = scope.querySelectorAll(args.selector) } catch { throw new ActionError('bad-args', 'selector is not valid CSS.') }
      if (matches.length !== 1) throw new ActionError('bad-args', `selector matched ${matches.length} elements in the observed tree; choose a unique selector.`)
      source = matches[0]!
    }
    const text = componentText(source), clipped = truncate(text, 8_000)
    return { text: `Text scope: ${scope instanceof ShadowRoot ? 'open shadow root' : 'document'} of the observed control; rendered DOM order.\n${clipped.text}`
      + (clipped.truncated > 0 ? `\n(Truncated ${clipped.truncated} characters after redaction.)` : '') }
  }
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source, true) : selector !== undefined ? `No element matched selector: ${selector}` : pageText(undefined, true)
  const truncated = truncate(text, 8_000)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  if (ms > 0) await sleep(ms)
  const settled = await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  return withPageDelta(settled
    ? `The page was quiet when checked${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`
    : 'The page did not become quiet within the limit; re-observe before continuing.', ctx, settled)
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
