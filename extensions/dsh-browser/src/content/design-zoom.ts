import { accessibleName, isVisible } from './extract.ts'
import { DesignZoomNotSelectedError } from './design-zoom-error.ts'

function controlName(control: HTMLSelectElement): string {
  if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return accessibleName(control)
  return [...control.labels].map(label => {
    const clone = label.cloneNode(true) as HTMLElement
    for (const child of clone.querySelectorAll('select, input, textarea')) child.remove()
    return clone.textContent ?? ''
  }).join(' ').replace(/\s+/gu, ' ').trim()
}

export function nativeDesignZoomControls(): HTMLSelectElement[] {
  return [...document.querySelectorAll('select')].filter(element =>
    isVisible(element) && /^(?:design\s+zoom|canvas\s+zoom|view\s+zoom|zoom|(?:设计|画布|视图)缩放|缩放)$/iu.test(controlName(element)))
}
/** Only an explicitly named native select is supported here. No CSS or browser zoom. */
export function changeDesignZoom(percent: unknown) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 100 || percent > 200) {
    throw new DesignZoomNotSelectedError('Design zoom must be a percentage between 100 and 200.')
  }
  const candidates = nativeDesignZoomControls()
  if (candidates.length !== 1) throw new DesignZoomNotSelectedError('No unique supported design zoom control.')
  const control = candidates[0]!
  if (control.multiple || control.matches(':disabled')) throw new DesignZoomNotSelectedError('The design zoom control is unavailable.')
  const percentage = (option: HTMLOptionElement | undefined) => {
    const match = option?.textContent?.trim().match(/^(\d+(?:\.\d+)?)\s*%$/u)
    return match === undefined || match === null ? undefined : Number(match[1])
  }
  const before = percentage(control.selectedOptions[0])
  if (before === undefined || !Number.isFinite(before)) throw new DesignZoomNotSelectedError('The current design zoom cannot be confirmed.')
  const choices = [...control.options].filter(option => percentage(option) === percent)
  if (choices.length !== 1 || choices[0]!.disabled || choices[0]!.closest('optgroup')?.disabled) {
    throw new DesignZoomNotSelectedError('The requested design zoom is not a unique available option.')
  }
  if (before !== percent) {
    control.selectedIndex = choices[0]!.index
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return () => {
    if (!control.isConnected || percentage(control.selectedOptions[0]) !== percent) {
      throw new Error('Design zoom readback did not confirm the requested percentage. Stop and ask for manual enlargement.')
    }
    return { before, percent, changed: before !== percent }
  }
}
