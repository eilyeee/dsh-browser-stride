// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isSensitiveField, maskValue, redactSensitivePageText } from '../src/content/privacy.ts'

afterEach(() => { document.body.replaceChildren() })

describe('isSensitiveField', () => {
  it('flags password inputs', () => {
    const input = document.createElement('input')
    input.type = 'password'
    expect(isSensitiveField(input)).toBe(true)
  })

  it('flags credit-card autocomplete fields', () => {
    const input = document.createElement('input')
    input.autocomplete = 'cc-number'
    expect(isSensitiveField(input)).toBe(true)
    const credit = document.createElement('input')
    ;(credit as { autocomplete: string }).autocomplete = 'credit-card'
    expect(isSensitiveField(credit)).toBe(true)
  })

  it('flags fields named like secrets', () => {
    for (const id of ['password', 'cardNumber', 'cvv2', 'credit_card', 'token_secret']) {
      const input = document.createElement('input')
      input.id = id
      expect(isSensitiveField(input)).toBe(true)
    }
  })

  it('flags one-time codes and grouped sensitive autocomplete tokens', () => {
    for (const autocomplete of ['one-time-code', 'section-checkout billing cc-number', 'section-login current-password']) {
      const input = document.createElement('input')
      input.setAttribute('autocomplete', autocomplete)
      expect(isSensitiveField(input)).toBe(true)
    }
    const otp = document.createElement('input')
    otp.name = 'loginOtp'
    expect(isSensitiveField(otp)).toBe(true)
  })

  it('uses associated and aria-labelledby labels to identify verification codes', () => {
    document.body.innerHTML = '<label for="code">验证码</label><input id="code"><span id="code-label">Verification code</span><div contenteditable="true" aria-labelledby="code-label"></div>'
    expect(isSensitiveField(document.querySelector('input')!)).toBe(true)
    expect(isSensitiveField(document.querySelector('[contenteditable]')!)).toBe(true)
  })

  it('resolves aria-labelledby inside a shadow root', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<span id="label">Verification code</span><input aria-labelledby="label">'
    expect(isSensitiveField(shadow.querySelector('input')!)).toBe(true)
  })

  it('leaves ordinary fields alone', () => {
    const input = document.createElement('input')
    input.id = 'email'
    expect(isSensitiveField(input)).toBe(false)
    input.id = 'discardNote'
    expect(isSensitiveField(input)).toBe(false)
    expect(isSensitiveField(document.createElement('textarea'))).toBe(false)
  })
})

describe('maskValue', () => {
  it('masks non-empty values and keeps empty values empty', () => {
    expect(maskValue('hunter2')).toBe('••••')
    expect(maskValue('')).toBe('')
  })
})

describe('page text redaction', () => {
  it('redacts overlapping sensitive values longest first', () => {
    document.body.innerHTML = '<p>Values: 123456 and 1234</p><input autocomplete="one-time-code" value="1234"><input autocomplete="one-time-code" value="123456">'
    const result = redactSensitivePageText(document.body, document.body.textContent ?? '')
    expect(result).not.toContain('123456')
    expect(result).not.toContain('1234')
    expect(result).not.toContain('••••56')
  })

  it('withholds text when sensitive content exceeds the redaction budget', () => {
    document.body.innerHTML = '<textarea autocomplete="one-time-code"></textarea><p>Public</p>'
    document.querySelector('textarea')!.value = 'x'.repeat(8_193)
    const result = redactSensitivePageText(document.body, `Public ${'x'.repeat(100)}`)
    expect(result).toContain('withheld')
    expect(result).not.toContain('x'.repeat(100))
  })

  it('withholds text rather than skipping fields beyond the inspection limit', () => {
    document.body.innerHTML = '<input>'.repeat(2_001)
    const result = redactSensitivePageText(document.body, 'Page text')
    expect(result).toContain('too many fields')
    expect(result).not.toContain('Page text')
  })

  it('bounds inspection of a sensitive select even when its options repeat', () => {
    document.body.innerHTML = `<select aria-label="Card choice">${'<option>same</option>'.repeat(201)}</select>`
    const result = redactSensitivePageText(document.body, 'Page text')
    expect(result).toContain('too many options')
    expect(result).not.toContain('Page text')
  })
})
