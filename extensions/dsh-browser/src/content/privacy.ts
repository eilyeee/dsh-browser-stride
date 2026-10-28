/**
 * Privacy boundary for page snapshots: sensitive form fields are never echoed.
 *
 * The browser page channel uses text snapshots, so the
 * snapshot is the ONLY representation of a form field's value that reaches the
 * model. Recognizable password, one-time-code and payment fields are masked to
 * a constant placeholder. Heuristics cannot identify every custom widget.
 *
 * @module
 */

/** Name/id/aria-label fragments that mark a field as sensitive. */
const SENSITIVE_PATTERNS = [
  /password/i,
  /passwd/i,
  /credit/i,
  /(?:^|[^a-z0-9])card(?:$|[^a-z0-9])/i,
  /(?:^|[^a-z0-9])card(?:number|num|no|holder|security|expiry|expiration|name|date)/i,
  /[a-z0-9]Card(?:Number|Num|No|Holder|Security|Expiry|Expiration|Name|Date)/,
  /(?:credit|debit|payment|bank|gift)[\s_-]*card/i,
  /cvv/i,
  /cvc/i,
  /secret/i,
  /pwd/i,
  /one[\s_-]?time[\s_-]?(?:password|passcode|code)/i,
  /verification[\s_-]?(?:code|number|token)/i,
  /security[\s_-]?code/i,
  /auth(?:entication)?[\s_-]?(?:code|token)/i,
  /(?:^|[^a-z0-9])(?:otp|totp|2fa|mfa)(?:[^a-z0-9]|$)/i,
  /(?:otp|totp)(?:code|token)?$/i,
  /验证码|一次性(?:密码|口令|代码)|动态(?:密码|口令)|安全(?:码|代码)/,
]

/**
 * Whether a form field must never be echoed back to the model.
 * @param el - the form element (input/select/textarea).
 * @returns true for recognizable password, one-time-code or payment fields.
 */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/)
  if (autocomplete.some(token => token === 'one-time-code' || token === 'current-password'
    || token === 'new-password' || token === 'credit-card' || token.startsWith('cc-'))) return true

  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
    ? el : undefined
  const labels = field?.labels === null || field?.labels === undefined
    ? [] : Array.from(field.labels, label => label.textContent ?? '')
  const root = el.getRootNode()
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '').trim().split(/\s+/)
    .map(id => (root instanceof Document || root instanceof ShadowRoot) ? root.getElementById(id)?.textContent ?? '' : '')
  const haystack = [el.id, field?.name, el.getAttribute('aria-label'), ...labels, ...labelledBy].filter(Boolean).join(' ')
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(haystack))
}

const FIELD_SELECTOR = 'input, textarea, select, [contenteditable]'
const MAX_REDACTION_FIELDS = 2_000
const MAX_REDACTION_FRAGMENTS = 200
const MAX_REDACTION_CHARS = 8_192
const MAX_REDACTION_TEXT = 250_000

/** Hide recognized field values that also occur in ordinary extracted page text. */
export function redactSensitivePageText(root: Element, text: string): string {
  for (let ancestor = root.parentElement?.closest(FIELD_SELECTOR) ?? null; ancestor !== null;
    ancestor = ancestor.parentElement?.closest(FIELD_SELECTOR) ?? null) {
    // A selector can point to part of a sensitive editable, whose full value
    // need not appear in the returned substring.
    if (isSensitiveField(ancestor)) return text === '' ? '' : '••••'
  }
  // The requested region can contain a copy of a field's value even when the
  // field itself is elsewhere on the page, so inspect the enclosing tree.
  const tree = root.getRootNode()
  const scope: ParentNode = tree instanceof Document || tree instanceof ShadowRoot ? tree : root
  const includeScope = scope instanceof Element && scope.matches(FIELD_SELECTOR)
  const descendants = scope.querySelectorAll(FIELD_SELECTOR)
  if (descendants.length + Number(includeScope) > MAX_REDACTION_FIELDS) return '[Sensitive page text withheld: too many fields to inspect safely.]'
  const fields = [...(includeScope ? [scope as Element] : []), ...descendants]
  const fragments = new Set<string>()
  let totalChars = 0
  const add = (value: string | null | undefined): boolean => {
    const normalized = value?.replace(/\s+/g, ' ').trim() ?? ''
    if (normalized === '' || fragments.has(normalized)) return true
    fragments.add(normalized)
    totalChars += normalized.length
    return fragments.size <= MAX_REDACTION_FRAGMENTS && totalChars <= MAX_REDACTION_CHARS
  }
  for (const field of fields) {
    if (!isSensitiveField(field)) continue
    const values: Array<string | null | undefined> = []
    if (field instanceof HTMLInputElement && field.type !== 'checkbox' && field.type !== 'radio'
      || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) values.push(field.value)
    if (field instanceof HTMLTextAreaElement || field.hasAttribute('contenteditable')) {
      values.push(field.textContent, field instanceof HTMLElement ? field.innerText : undefined)
    }
    for (const value of values) {
      if (!add(value)) return '[Sensitive page text withheld: too much data to redact safely.]'
    }
    if (field instanceof HTMLSelectElement) {
      // Some text extractors include every option, not just the selected one.
      if (field.options.length > MAX_REDACTION_FRAGMENTS) return '[Sensitive page text withheld: too many options to inspect safely.]'
      if (!add(field.textContent)) return '[Sensitive page text withheld: too much data to redact safely.]'
      for (const option of field.options) {
        if (!add(option.textContent) || !add(option.label)) return '[Sensitive page text withheld: too much data to redact safely.]'
      }
    }
  }
  if (fragments.size > 0 && text.length > MAX_REDACTION_TEXT) return '[Sensitive page text withheld: text exceeds the safe redaction limit.]'
  let redacted = text
  // Longer matches first avoid exposing the tail when values overlap.
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) redacted = redacted.replaceAll(fragment, '••••')
  return redacted
}

/**
 * Mask a sensitive value for snapshots. Non-empty values become a fixed
 * placeholder so the model knows a value is present without learning it.
 * @param value - the field's current value.
 * @returns the masked representation.
 */
export function maskValue(value: string): string {
  return value.length === 0 ? '' : '••••'
}
