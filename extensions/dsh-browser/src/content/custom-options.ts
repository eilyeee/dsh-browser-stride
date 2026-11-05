/** Observed DOM adapters only; these selectors never grant page access. */
export const ELEMENT_UI_OPTION_SELECTOR = '.el-select-dropdown .el-select-dropdown__list > li.el-select-dropdown__item'

export function isElementUiOption(element: Element): boolean {
  return element.matches(ELEMENT_UI_OPTION_SELECTOR)
}

/** Native and ARIA controls share this check with the narrow Element UI adapter. */
export function isControlDisabled(element: Element): boolean {
  return element.matches(':disabled') || element.closest('[inert], [aria-disabled="true"]') !== null
    || (isElementUiOption(element) && element.classList.contains('is-disabled'))
}

export function customOptionSelected(element: Element): boolean | undefined {
  if (isElementUiOption(element)) return element.classList.contains('selected')
  if (element.getAttribute('role') === 'option') {
    const value = element.getAttribute('aria-selected')
    if (value === 'true' || value === 'false') return value === 'true'
  }
  return undefined
}

/** Bind option identity to its actual popup node, including portalled popups. */
const popupIds = new WeakMap<Element, number>()
let nextPopupId = 1
export function optionContextIdentity(element: Element): readonly unknown[] | null {
  const elementUi = isElementUiOption(element)
  if (!elementUi && element.getAttribute('role') !== 'option') return null
  const popup = elementUi ? element.closest('.el-select-dropdown') : element.closest('[role="listbox"]')
  let popupId: number | null = null
  if (popup !== null) {
    popupId = popupIds.get(popup) ?? nextPopupId++
    popupIds.set(popup, popupId)
  }
  return [elementUi ? 'element-ui-option' : 'aria-option', popupId,
    popup?.id, popup?.getAttribute('aria-label'), popup?.getAttribute('aria-labelledby'),
    element.getAttribute('value'), element.getAttribute('data-value')]
}
