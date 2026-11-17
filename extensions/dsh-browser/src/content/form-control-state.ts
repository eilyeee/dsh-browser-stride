/** Passive, bounded DOM observations. These declarations grant no permission. */
import { isControlDisabled, isFieldReadOnly } from './custom-options.ts'
import { isSensitiveField } from './privacy.ts'

type NumericAttribute = { state: 'absent' | 'unusable' } | { state: 'declared'; value: number | 'any' }
type NumericDeclarations = { state: 'masked' | 'not-input' } | {
  state: 'attributes'
  min: NumericAttribute
  max: NumericAttribute
  step: NumericAttribute
  ariaMin: NumericAttribute
  ariaMax: NumericAttribute
}
export interface FormControlState {
  disabled: boolean
  readOnly: boolean
  nativeRequired: boolean
  numeric: NumericDeclarations
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
function numericAttribute(element: HTMLInputElement, name: string, step = false): NumericAttribute {
  const raw = element.getAttribute(name)
  if (raw === null) return { state: 'absent' }
  if (raw.length > 64) return { state: 'unusable' }
  if (raw.trim() === '') return { state: 'absent' }
  const text = raw.trim()
  if (step && text.toLowerCase() === 'any') return { state: 'declared', value: 'any' }
  if (!NUMBER.test(text)) return { state: 'unusable' }
  const value = Number(text)
  return Number.isFinite(value) && (!step || value > 0) ? { state: 'declared', value } : { state: 'unusable' }
}

export function readFormControlState(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): FormControlState {
  // Never read the numeric attributes of a recognized sensitive field, and
  // never collect pattern, validationMessage, aria-valuenow or option values.
  const numeric: NumericDeclarations = isSensitiveField(element) ? { state: 'masked' }
    : element instanceof HTMLInputElement ? { state: 'attributes',
      min: numericAttribute(element, 'min'), max: numericAttribute(element, 'max'), step: numericAttribute(element, 'step', true),
      ariaMin: numericAttribute(element, 'aria-valuemin'), ariaMax: numericAttribute(element, 'aria-valuemax') }
      : { state: 'not-input' }
  return { disabled: isControlDisabled(element), readOnly: isFieldReadOnly(element), nativeRequired: element.required, numeric }
}

function renderAttribute(attribute: NumericAttribute): string {
  return attribute.state === 'declared' ? String(attribute.value) : attribute.state
}
export function renderFormControlState(state: FormControlState | undefined): string {
  if (state === undefined) return 'dom-state=unreported'
  const flags = `dom-state(disabled=${state.disabled},readonly=${state.readOnly},native-required=${state.nativeRequired})`
  const numeric = state.numeric
  if (numeric.state !== 'attributes') return `${flags} numeric-attributes=${numeric.state}`
  const values = [numeric.min, numeric.max, numeric.step, numeric.ariaMin, numeric.ariaMax]
  if (values.every(value => value.state === 'absent')) return `${flags} numeric-attributes=absent`
  return `${flags} numeric-attributes(min=${renderAttribute(numeric.min)},max=${renderAttribute(numeric.max)},step=${renderAttribute(numeric.step)},aria-min=${renderAttribute(numeric.ariaMin)},aria-max=${renderAttribute(numeric.ariaMax)})`
}
