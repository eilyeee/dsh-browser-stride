// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://lanhuapp.com/web/#/item/project/detailDetach"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLanhuZoom, commitLanhuZoom, prepareLanhuZoom } from '../src/content/lanhu-zoom.ts'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
beforeEach(() => { history.replaceState({}, '', '/web/#/item/project/detailDetach?image=a') })
afterEach(() => { clearLanhuZoom(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(before = 27) {
  document.body.innerHTML = '<div id="detail_container"><div class="operation-wrap"><div class="operation-center"><div class="choose_size_box"><div class="choose_size"><mu-button><span class="more_warp"><span class="more">' + before + '%</span></span></mu-button></div></div></div></div></div>'
    + '<aside><span>100%</span><select aria-label="Opacity"><option>50%</option><option>150%</option></select></aside>'
    + '<div class="mu-popover percent-pop" style="display:none"><div class="choose_dialog"><div class="choose_item">放大</div><div class="choose_item">缩小</div><div class="choose_item">100%</div><div class="choose_item">150%</div><div class="choose_item">200%</div></div></div>'
  const owner = document.querySelector<HTMLElement>('.choose_size')!, trigger = owner.querySelector<HTMLElement>('mu-button')!
  const popup = document.querySelector<HTMLElement>('.percent-pop')!, menu = popup.firstElementChild as HTMLElement
  for (const element of document.querySelectorAll<HTMLElement>('div, mu-button, .more')) {
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
      if (element.closest('.percent-pop') && popup.style.display === 'none') return new DOMRect()
      return element === trigger ? new DOMRect(100, 14, 48, 20) : element.closest('.percent-pop') ? new DOMRect(100, 34, 162, 265) : new DOMRect(100, 0, 120, 48)
    })
  }
  const opened = vi.fn(() => { owner.classList.add('open'); popup.style.display = 'block' })
  owner.addEventListener('mouseenter', opened)
  const chosen = vi.fn()
  for (const option of menu.children) option.addEventListener('click', () => {
    chosen(option.textContent!.trim()); trigger.querySelector('.more')!.textContent = option.textContent
    owner.classList.remove('open'); popup.style.display = 'none'
  })
  return { owner, trigger, popup, menu, opened, chosen }
}
describe('observed Lanhu menu zoom', () => {
  it('marks only preparation failures as no-selection, while commit failures remain fenced', async () => {
    const context = { ids: new ElementIds(), budget: { maxItems: 20, maxForms: 10, maxChars: 2000 } }
    const first = fixture(); first.menu.children[3]!.textContent = '120%'
    await expect(runAction('browser_set_design_zoom', { phase: 'prepare', percent: 150 }, context))
      .rejects.toMatchObject({ code: 'design-zoom-not-selected' })
    expect(first.chosen).not.toHaveBeenCalled()
    const next = fixture()
    await runAction('browser_set_design_zoom', { phase: 'prepare', percent: 150 }, context)
    await expect(runAction('browser_set_design_zoom', { phase: 'commit', ticket: 'invalid', percent: 150 }, context))
      .rejects.toMatchObject({ code: 'action-failed' })
    expect(next.chosen).not.toHaveBeenCalled()
  })
  it('uses the HTTP-compatible secure nonce generator and rejects detached or misplaced popups', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    fixture()
    const step = (await prepareLanhuZoom(150))!
    expect(step.ticket).toMatch(/^zoom_[0-9a-f-]{36}$/u)
    clearLanhuZoom()
    const bad = fixture()
    vi.spyOn(bad.popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 34, 162, 265))
    await expect(prepareLanhuZoom(150)).rejects.toThrow('anchored')
    expect(bad.chosen).not.toHaveBeenCalled()
  })
  it('opens the exact toolbar without selecting, then consumes a pinned option once and checks readback', async () => {
    const f = fixture(), step = (await prepareLanhuZoom(150))!
    expect(f.opened).toHaveBeenCalledOnce(); expect(f.chosen).not.toHaveBeenCalled()
    expect(commitLanhuZoom(step.ticket, 150)()).toEqual({ before: 27, percent: 150, changed: true })
    expect(f.chosen).toHaveBeenCalledExactlyOnceWith('150%')
    expect(document.querySelector('select')!.selectedIndex).toBe(0)
    expect(() => commitLanhuZoom(step.ticket, 150)).toThrow('stale')
    expect(f.chosen).toHaveBeenCalledOnce()
  })
  it('does not open or change an already correct control', async () => {
    const f = fixture(150), step = (await prepareLanhuZoom(150))!
    expect(commitLanhuZoom(step.ticket, 150)()).toEqual({ before: 150, percent: 150, changed: false })
    expect(f.opened).not.toHaveBeenCalled(); expect(f.chosen).not.toHaveBeenCalled()
  })
  it('requires the foreground before opening or choosing, without replaying the consumed step', async () => {
    const f = fixture(), visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await expect(prepareLanhuZoom(150)).rejects.toThrow('foreground')
    expect(f.opened).not.toHaveBeenCalled(); expect(f.chosen).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    const step = (await prepareLanhuZoom(150))!
    visibility.mockReturnValue('hidden')
    expect(() => commitLanhuZoom(step.ticket, 150)).toThrow('foreground')
    visibility.mockReturnValue('visible')
    expect(() => commitLanhuZoom(step.ticket, 150)).toThrow('stale')
    expect(f.chosen).not.toHaveBeenCalled()
  })
  it('waits for the popup itself to become visible before pinning its percentage', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.popup.style.opacity = '0'
    let prepared = false
    const result = prepareLanhuZoom(150).then(step => { prepared = true; return step! })
    await vi.advanceTimersByTimeAsync(50)
    expect(prepared).toBe(false); expect(f.chosen).not.toHaveBeenCalled()
    f.popup.style.opacity = '1'
    await vi.advanceTimersByTimeAsync(25)
    const step = await result
    expect(commitLanhuZoom(step.ticket, 150)().percent).toBe(150)
    expect(f.chosen).toHaveBeenCalledOnce()
  })
  it('does not treat another page route or duplicate toolbar as authorization to open a menu', async () => {
    const f = fixture(); history.replaceState({}, '', '/other')
    expect(await prepareLanhuZoom(150)).toBeUndefined()
    expect(f.opened).not.toHaveBeenCalled()
    history.replaceState({}, '', '/web/#/item/project/detailDetach')
    const duplicate = f.owner.cloneNode(true) as HTMLElement
    vi.spyOn(duplicate, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 120, 48))
    f.owner.parentElement!.append(duplicate)
    await expect(prepareLanhuZoom(150)).rejects.toThrow('unique')
    expect(f.chosen).not.toHaveBeenCalled()
  })
  it('refuses missing, disabled and duplicate percentages without clicking a guessed option', async () => {
    for (const mode of ['missing', 'disabled', 'duplicate']) {
      const f = fixture(), target = f.menu.children[3] as HTMLElement
      if (mode === 'missing') target.textContent = '120%'
      if (mode === 'disabled') target.setAttribute('aria-disabled', 'true')
      if (mode === 'duplicate') f.menu.children[2]!.textContent = '150%'
      await expect(prepareLanhuZoom(150)).rejects.toThrow('unique available')
      expect(f.chosen).not.toHaveBeenCalled()
    }
  })
  it('refuses a stale, expired, removed, closed or changed step before the option effect', async () => {
    for (const mode of ['token', 'percent', 'url', 'value', 'removed', 'closed', 'clear', 'expired']) {
      const f = fixture(), step = (await prepareLanhuZoom(150))!
      if (mode === 'url') history.replaceState({}, '', '/web/#/item/project/detailDetach?image=b')
      if (mode === 'value') f.trigger.querySelector('.more')!.textContent = '100%'
      if (mode === 'removed') f.menu.children[3]!.remove()
      if (mode === 'closed') f.owner.classList.remove('open')
      if (mode === 'clear') clearLanhuZoom()
      if (mode === 'expired') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 90_001) }
      expect(() => commitLanhuZoom(mode === 'token' ? 'forged' : step.ticket, mode === 'percent' ? 100 : 150)).toThrow()
      expect(f.chosen).not.toHaveBeenCalled()
      vi.useRealTimers(); history.replaceState({}, '', '/web/#/item/project/detailDetach?image=a')
    }
  })
  it('requires the zoom label readback after one click, without replaying an ignored change', async () => {
    const f = fixture(), step = (await prepareLanhuZoom(150))!
    const readback = commitLanhuZoom(step.ticket, 150)
    f.trigger.querySelector('.more')!.textContent = '27%'
    expect(readback).toThrow('readback')
    expect(f.chosen).toHaveBeenCalledOnce()
    expect(() => commitLanhuZoom(step.ticket, 150)).toThrow('stale')
  })
})
