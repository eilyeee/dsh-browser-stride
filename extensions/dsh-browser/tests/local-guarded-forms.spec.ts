// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { fillLocalPostForm, readLocalJenkinsCheckout, readLocalJson } from '../src/content/local-guarded-forms.ts'
import { ElementIds } from '../src/content/ids.ts'
import { observedRef } from './observed-ref.ts'
import { JENKINS_BRANCH_FIELD } from '@eilyeee/dsh-browser-stride/src/local-browser-contract.ts'

const fields = [
  { selector: '#branch', value: 'merge-11234-11235' },
  { selector: '#sha', value: 'ab'.repeat(20) },
]
const budget = { maxItems: 20, maxForms: 10, maxChars: 8_000 }

beforeEach(() => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20,
    x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
  document.body.innerHTML = `<form method="post" action="${location.href}">
    <input id="branch" value="master"><input id="sha" pattern="[0-9a-f]{40}">
    <button type="submit">Build</button></form>`
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.head.removeAttribute('data-crumb-header')
  document.head.removeAttribute('data-crumb-value')
  history.replaceState(null, '', '/')
})

describe('guarded Jenkins queue receipt', () => {
  function jenkinsForm() {
    history.replaceState(null, '', '/jenkins/job/fixture/build?delay=0sec')
    document.body.innerHTML = '<form method="post" name="parameters"><input type="hidden" name="Jenkins-Crumb" value="synthetic">' +
      '<div name="parameter"><input type="hidden" name="name" value="BRANCH"><input name="value"></div>' +
      '<button type="submit">Build</button></form>'
    const button = document.querySelector('button')!
    button.scrollIntoView = vi.fn()
    return button
  }
  const formFill = { formSelector: 'form[name="parameters"]', jenkinsQueueReceipt: true,
    fields: [{ selector: JENKINS_BRANCH_FIELD, value: 'merge-11234-11235' }] }

  it('sends BRANCH once through the authorized origin and returns the exact new queue ID', async () => {
    const button = jenkinsForm()
    const activate = vi.fn((event: Event) => event.preventDefault())
    button.addEventListener('click', activate)
    const fetchRequest = vi.fn(async () => new Response(null, { status: 201, headers: { Location: '/jenkins/queue/item/901/' } }))
    vi.stubGlobal('fetch', fetchRequest)
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const elementRef = observedRef(snapshot, ids, button)
    const answer = await runAction('browser_click', { localPageUrl: location.href, localFormFill: formFill, elementRef }, { ids, budget })
    expect(answer.jenkinsQueueId).toBe(901)
    expect(activate).not.toHaveBeenCalled()
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith(new URL('/jenkins/job/fixture/buildWithParameters', location.href),
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'manual',
        body: new URLSearchParams({ BRANCH: 'merge-11234-11235', 'Jenkins-Crumb': 'synthetic' }) }))
  })

  it.each([
    [303, '/jenkins/queue/item/901/'],
    [201, 'https://another.example.invalid/jenkins/queue/item/901/'],
    [201, '/another/queue/item/901/'],
  ])('returns no queue ID for status %s with location %s', async (status, receipt) => {
    const button = jenkinsForm()
    const fetchRequest = vi.fn(async () => new Response(null, { status, headers: { Location: receipt } }))
    vi.stubGlobal('fetch', fetchRequest)
    const enqueue = fillLocalPostForm(button, location.href, formFill)
    expect(await enqueue?.()).toBeUndefined()
    expect(fetchRequest).toHaveBeenCalledTimes(1)
  })

  it('uses only the matching configured crumb already present in the authorized form', async () => {
    const button = jenkinsForm()
    document.head.setAttribute('data-crumb-header', '_crumb')
    document.head.setAttribute('data-crumb-value', 'custom')
    const crumb = document.querySelector<HTMLInputElement>('input[name="Jenkins-Crumb"]')!
    crumb.name = '_crumb'
    expect(() => fillLocalPostForm(button, location.href, formFill)).toThrow()
    crumb.value = 'custom'
    const fetchRequest = vi.fn(async () => new Response(null, { status: 201, headers: { Location: '/jenkins/queue/item/901/' } }))
    vi.stubGlobal('fetch', fetchRequest)
    expect(await fillLocalPostForm(button, location.href, formFill)?.()).toBe(901)
    expect(fetchRequest).toHaveBeenCalledExactlyOnceWith(expect.any(URL),
      expect.objectContaining({ body: new URLSearchParams({ BRANCH: 'merge-11234-11235', _crumb: 'custom' }) }))
  })

  it('reads the complete original console and returns only mutually consistent checkout evidence', async () => {
    history.replaceState(null, '', '/jenkins/job/fixture/')
    const sha = 'a'.repeat(40)
    const checkout = (commit: string) => 'Checking out Revision ' + commit + ' (refs/remotes/origin/feat-11234)\n> git checkout -f ' + commit + ' # timeout=10\n'
    const timestamped = (commit: string) => checkout(commit).trimEnd().split('\n').map(line => '[2026-11-26T02:00:00.000Z] ' + line).join('\n') + '\n'
    const repository = 'https://git.example.invalid/admin/fixture.git'
    const leading = 'Cloning repository ' + repository + '\n' + checkout(sha) + 'build output\n'.repeat(20_000)
    const fetchLog = vi.fn().mockImplementationOnce(async () => new Response(leading + 'Finished: SUCCESS\n', { headers: { 'Content-Type': 'text/plain' } }))
      .mockImplementationOnce(async () => new Response(leading + timestamped('b'.repeat(40)) + 'Finished: SUCCESS\n', { headers: { 'Content-Type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetchLog)
    const log = { url: location.href + '21/consoleText', repository, branch: 'feat-11234' }
    await expect(readLocalJenkinsCheckout(log)).resolves.toEqual({ checkoutSha: sha })
    await expect(readLocalJenkinsCheckout(log)).resolves.toEqual({ checkoutSha: null })
    await expect(readLocalJenkinsCheckout({ ...log, url: location.origin + '/jenkins/job/another/21/consoleText' })).rejects.toThrow()
    expect(fetchLog).toHaveBeenCalledTimes(2)
  })
})

describe('local service form guard', () => {
  it('fills the observed same-page form before one submit activation', async () => {
    const button = document.querySelector('button')!
    button.scrollIntoView = vi.fn()
    const activate = vi.fn((event: Event) => {
      event.preventDefault()
      expect(document.querySelector<HTMLInputElement>('#branch')?.value).toBe(fields[0]!.value)
      expect(document.querySelector<HTMLInputElement>('#sha')?.value).toBe(fields[1]!.value)
    })
    button.addEventListener('click', activate)
    const ids = new ElementIds()
    const snapshot = await runAction('browser_snapshot', {}, { ids, budget })
    const result = await runAction('browser_click', { elementRef: observedRef(snapshot, ids, button), localPageUrl: location.href,
      localFormFill: { fields } }, { ids, budget })
    expect(result.navigationPending).toBe(true)
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('keeps existing values when a required field is missing or fails validation', () => {
    const button = document.querySelector('button')!
    expect(() => fillLocalPostForm(button, location.href, { fields: [fields[0], { selector: '#missing', value: 'value' }] })).toThrow()
    expect(() => fillLocalPostForm(button, location.href, { fields: [fields[0], { selector: '#sha', value: 'bad-sha' }] })).toThrow()
    expect(document.querySelector<HTMLInputElement>('#branch')?.value).toBe('master')
    expect(document.querySelector<HTMLInputElement>('#sha')?.value).toBe('')
  })

  it('rejects a submit override and a field outside the target form', () => {
    const button = document.querySelector('button')!
    button.setAttribute('formaction', '/different-build')
    expect(() => fillLocalPostForm(button, location.href, { fields })).toThrow()
    button.removeAttribute('formaction')
    document.body.append(document.querySelector('#sha')!)
    expect(() => fillLocalPostForm(button, location.href, { fields })).toThrow()
    expect(document.querySelector<HTMLInputElement>('#branch')?.value).toBe('master')
  })

  it('reads exact JSON with same-origin session credentials and refuses other origins or a login page', async () => {
    const path = location.origin + '/job/example/api/json'
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{ "number": 12 }', { headers: { 'Content-Type': 'application/json;charset=utf-8' } }))
      .mockResolvedValueOnce(new Response('<form>Sign in</form>', { headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetcher)
    await expect(readLocalJson(path)).resolves.toBe('{ "number": 12 }')
    expect(fetcher).toHaveBeenCalledWith(new URL(path), expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error' }))
    await expect(readLocalJson('https://other.example.invalid/api/json')).rejects.toThrow()
    await expect(readLocalJson(path)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
