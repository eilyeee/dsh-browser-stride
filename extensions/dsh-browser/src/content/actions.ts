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
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshotDetails } from './snapshot.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
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
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if (afterReady >= policy.minimumMs && quietFor >= policy.quietMs) {
          finish(true)
          return
        }
        if (afterReady >= policy.maxAfterReadyMs) {
          finish(false)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
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
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
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
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current references.`)
  }
  if (ids.isActionTargetCurrent?.(index) === false) {
    throw new ActionError('action-failed', `Element [${index}] changed, disappeared or is not actionable. Call browser_snapshot again.`)
  }
  return el
}

function referenceArg(args: Record<string, unknown>, ids: ElementIds, needsOptions = false): number {
  const index = ids.resolveReference(args.elementRef, needsOptions)
  if (index === undefined) {
    throw new ActionError('action-failed', 'The element reference is missing, stale, or was not fully shown in the current observation. Call browser_snapshot again and use its elementRef. Update the bridge and extension together.')
  }
  return index
}

function referenceStillCurrent(args: Record<string, unknown>, ids: ElementIds, index: number, needsOptions = false): boolean {
  return ids.resolveReference(args.elementRef, needsOptions) === index && ids.isActionTargetCurrent?.(index) !== false
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args',
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
  input.dispatchEvent(new Event('input', { bubbles: true }))
  if (!stillCurrent()) return false
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return stillCurrent()
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
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
      return getTextAction(args)
    case 'browser_wait':
      return waitAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const previous = snapshotByRegistry.get(ctx.ids) ?? null
  const lastSnapshot = previous?.url === location.href ? previous : null
  const delta = args.delta === true && lastSnapshot !== null
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  snapshotByRegistry.set(ctx.ids, view)
  const rendered = renderSnapshotDetails(view, delta)
  ctx.ids.publishObservation(view.observationId, rendered.targets, rendered.selects)
  return { text: rendered.text }
}

/** Delta state belongs to the content-script registry, not another instance. */
const snapshotByRegistry = new WeakMap<ElementIds, ReturnType<typeof buildSnapshot>>()

/** Invalidate delta state after navigation (new document). */
export function resetDeltaState(ids: ElementIds): void {
  snapshotByRegistry.delete(ids)
  ids.clearObservation()
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext, settled = true): ActionResult {
  if (!settled) {
    resetDeltaState(ctx.ids)
    return { text }
  }
  const lastSnapshot = snapshotByRegistry.get(ctx.ids) ?? null
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const delta = lastSnapshot.url === location.href
  const view = buildSnapshot(ctx.ids, { delta, budget: ctx.budget }, delta ? lastSnapshot : null)
  snapshotByRegistry.set(ctx.ids, view)
  const rendered = renderSnapshotDetails(view, delta, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS))
  ctx.ids.publishObservation(view.observationId, rendered.targets, rendered.selects)
  return {
    text,
    pageContent: rendered.text,
  }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = referenceArg(args, ctx.ids)
  const el = elementOrThrow(ctx.ids, index)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  // Synchronous scroll handlers can change the page before activation.
  referenceArg(args, ctx.ids)
  elementOrThrow(ctx.ids, index)
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
    return withPageDelta(`Clicked [${index}]. Observed control state: ${observed}; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled)
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
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean, stillCurrent: () => boolean): boolean {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  if (!stillCurrent()) return false
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return stillCurrent()
    } catch {
      // Fall through to the direct-write path below.
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
  const stillCurrent = (): boolean => referenceStillCurrent(args, ctx.ids, index)
    && el.closest('[aria-readonly="true"]') === null
    && (!(el instanceof HTMLInputElement) || (!el.readOnly && TYPABLE_INPUT_TYPES.has(el.type)))
    && (!(el instanceof HTMLTextAreaElement) || !el.readOnly)
  let expectedValue: string | undefined
  if (!stillCurrent()) throw new ActionError('action-failed', `Element [${index}] is read-only or does not support text input.`)
  if (isEditable(el)) {
    if (!typeIntoContentEditable(el, text, replace, stillCurrent)) {
      resetDeltaState(ctx.ids)
      return { text: `Input to [${index}] may have partially changed the field, but the target changed during page events. Re-observe and check its state before continuing.` }
    }
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    expectedValue = `${replace ? '' : el.value}${text}`
    if ((replace && !setNativeValue(el, '', stillCurrent)) || !setNativeValue(el, `${el.value}${text}`, stillCurrent)) {
      resetDeltaState(ctx.ids)
      return { text: `Input to [${index}] may have partially changed the field, but the target changed during page events. Re-observe and check its state before continuing.` }
    }
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  const settled = await waitForPageSettled(TYPE_SETTLE)
  if (expectedValue !== undefined && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    && (!el.isConnected || el.value !== expectedValue)) {
    return withPageDelta(`Input was sent to [${index}], but its value could not be confirmed at readback. Observe again before continuing.${settleNote(settled)}`, ctx, settled)
  }
  if (expectedValue !== undefined) {
    return withPageDelta(`Entered ${text.length} characters into [${index}]. The field value was read back; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled)
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
  const option = optionIndex < SELECT_OPTION_LIMIT ? el.options.item(optionIndex) : null
  if (option === null || option.matches(':disabled')) {
    throw new ActionError('bad-args', 'The option is unavailable or was not included in the snapshot.')
  }
  el.selectedIndex = optionIndex
  el.dispatchEvent(new Event('input', { bubbles: true }))
  const stillCurrent = (): boolean => referenceStillCurrent(args, ctx.ids, index, true)
  if (!stillCurrent()) {
    resetDeltaState(ctx.ids)
    return { text: `Selection in [${index}] may have partially changed, but the target changed during page events. Re-observe and check its state before continuing.` }
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (!stillCurrent()) {
    resetDeltaState(ctx.ids)
    return { text: `Selection in [${index}] may have partially changed, but the target changed during page events. Re-observe and check its state before continuing.` }
  }
  const settled = await waitForPageSettled(TYPE_SETTLE)
  if (!el.isConnected || !option.isConnected || el.selectedIndex !== optionIndex || !option.selected) {
    return withPageDelta(`Selection was sent to [${index}], but could not be confirmed at readback. Observe again before continuing.${settleNote(settled)}`, ctx, settled)
  }
  return withPageDelta(`Selected option ${optionIndex} in [${index}]. The control state was read back; this does not confirm a saved change.${settleNote(settled)}`, ctx, settled)
}

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const key = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (key === '' || key.length > 64 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new ActionError('bad-args', 'key must be a non-empty KeyboardEvent.key value of at most 64 characters without control characters.')
  }
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  const settled = await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent synthetic key events for ${JSON.stringify(key)}; native key behavior is not guaranteed. Page handlers may have caused effects; re-observe and check before continuing.${settleNote(settled)}`, ctx, settled)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const direction = typeof args.direction === 'string' ? args.direction : ''
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
  setTimeout(() => { location.href = parsed.href }, 0)
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

async function getTextAction(args: Record<string, unknown>): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const source = selector !== undefined ? document.querySelector(selector) : null
  const text = source !== null ? pageText(source) : selector !== undefined ? `No element matched selector: ${selector}` : pageText()
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
