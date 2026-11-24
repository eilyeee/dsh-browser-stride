import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { TabAffinityState } from '../background/tab-affinity.ts'
import type { RecoveryDecisions } from '@eilyeee/dsh-browser-stride/src/native-review.ts'
import { RECOVERY_OFFER_LIMIT, parseRecoveryWriteLabel } from '@eilyeee/dsh-browser-stride/src/recovery-context.ts'
import { PanelRpcError, type PageRecoveryItem, type PageRecoveryOffer, type PanelApi } from './api.ts'
import { DiagnosticRequests } from './diagnostic-requests.ts'

export interface RecoveryControls { inspect(event: Event): void }

function reviewLabel(item: PageRecoveryItem, zh: boolean): string {
  if (item.button) return zh ? `点击「${item.button}」` : `Clicked “${item.button}”`
  if (item.kind === 'recovery') return zh ? '中断的任务' : 'Interrupted task'
  const context = item.kind === 'write' ? parseRecoveryWriteLabel(item.label) : undefined
  const labels: Record<string, string> = {
    browser_click: zh ? '点击网页控件' : 'Clicked a page control',
    browser_click_at: zh ? '点击网页位置' : 'Clicked a point on the page',
    browser_type: zh ? '填写网页内容' : 'Entered text',
    browser_press: zh ? '在网页按键' : 'Pressed a key on the page',
    browser_select: zh ? '选择网页选项' : 'Selected a page option',
    browser_open_tab: zh ? '打开标签页' : 'Opened a tab',
    browser_follow_tab: zh ? '切换对话目标' : 'Changed the conversation target',
    browser_close_tab: zh ? '关闭标签页' : 'Closed a tab',
    browser_navigate: zh ? '跳转网页' : 'Navigated to a page',
    browser_set_design_zoom: zh ? '调整设计稿缩放' : 'Changed design zoom',
  }
  return labels[context?.operation ?? ''] ?? (zh ? '网页操作' : 'Page action')
}

export function GuidedRecoveryPanel({ api, sessionId, affinity, connected, available, working, locale, controls, onRecorded }: {
  api: Pick<PanelApi, 'pageRecovery'>; sessionId: string | null; affinity: TabAffinityState | null; connected: boolean
  available: boolean; working: boolean; locale: string; controls?: Ref<RecoveryControls>; onRecorded?(): void
}) {
  const zh = locale === 'zh'
  const tab = affinity?.controlled
  const scope = useMemo(() => new DiagnosticRequests(), [api, sessionId, tab?.tabId, tab?.url, affinity?.revision, available, connected])
  const current = useRef(scope); current.current = scope
  const inspectWhenReady = useRef<DiagnosticRequests>(undefined)
  const section = useRef<HTMLElement>(null)
  const [view, setView] = useState<{ owner: DiagnosticRequests; offer?: PageRecoveryOffer; busy: boolean; open: boolean; notice?: string }>({ owner: scope, open: false, busy: false })
  const [count, setCount] = useState<{ sessionId: string; pending: number } | null>(null)
  const [deferred, setDeferred] = useState<{ owner: DiagnosticRequests; keys: string[] }>({ owner: scope, keys: [] })
  const deferredKeys = deferred.owner === scope ? deferred.keys : []
  const visible = view.owner === scope ? view : { owner: scope, open: false, busy: false }
  const pending = count?.sessionId === sessionId ? count.pending : undefined
  const offer = visible.offer
  const offerChanged = offer !== undefined && pending !== undefined && offer.items.length !== pending
    && (offer.items.length < RECOVERY_OFFER_LIMIT || pending < RECOVERY_OFFER_LIMIT)
  const ready = available && !working && sessionId !== null && tab != null && affinity !== null
  const readyNow = useRef(ready); readyNow.current = ready

  useEffect(() => {
    if (!connected || sessionId === null) return
    const sid = sessionId
    const poll = () => {
      const ticket = scope.read()
      if (!ticket) return
      void api.pageRecovery({ action: 'status', sessionId: sid }).then(value => {
        if (current.current === scope && ticket.current() && 'pending' in value) setCount({ sessionId: sid, pending: value.pending })
      }, () => {})
    }
    poll()
    const timer = setInterval(poll, 4000)
    return () => { clearInterval(timer); scope.invalidate() }
  }, [scope])

  function inspect(event: Event, decision?: RecoveryDecisions[number]) {
    if (!event.isTrusted) return
    setView(previous => previous.owner === scope ? { ...previous, open: true } : { owner: scope, open: true, busy: false })
    section.current?.scrollIntoView?.({ block: 'nearest' })
    if (!ready && available && working && !decision) inspectWhenReady.current = scope
    else void inspectPage(decision)
  }

  useEffect(() => {
    if (!ready || inspectWhenReady.current !== scope) return
    inspectWhenReady.current = undefined
    void inspectPage()
  }, [scope, ready])
  useEffect(() => {
    if (ready && visible.open && !visible.busy && offerChanged) void inspectPage()
  }, [scope, ready, visible.open, visible.busy, offerChanged])

  async function inspectPage(decision?: RecoveryDecisions[number]) {
    if (!ready || !tab || !affinity || !sessionId) return
    const ticket = scope.mutate()
    if (!ticket) return
    const request = { sessionId, tabId: tab.tabId, revision: affinity.revision, expectedUrl: tab.url }
    const live = () => current.current === scope && ticket.current()
    const expired = decision !== undefined && offer !== undefined && offer.expiresAt <= Date.now()
    setView({ owner: scope, open: true, busy: true, ...(offer === undefined ? {} : { offer }) })
    let recorded = false
    let refreshDecision = expired
    try {
      if (decision && offer && !expired) {
        const result = await api.pageRecovery({ ...request, action: 'confirm', reviewId: offer.reviewId, decisions: [decision] }).catch(error => {
          if (error instanceof PanelRpcError && ['review-stale', 'review-read-required'].includes(error.code)) return null
          throw error
        })
        if (!live()) return
        if (result === null) refreshDecision = true
        else {
          if (!('reviewed' in result) || result.reviewed !== true || result.resumed !== false || result.completed !== false) throw Error('invalid review reply')
          recorded = true
          onRecorded?.()
          setCount(previous => previous?.sessionId === sessionId ? { sessionId, pending: Math.max(0, previous.pending - 1) } : previous)
        }
      }
      if (!readyNow.current) throw new PanelRpcError('review-busy', '')
      const result = await api.pageRecovery({ ...request, action: 'inspect' })
      if (!live()) return
      if (!('items' in result)) throw Error('invalid review offer')
      if (result.items.length < RECOVERY_OFFER_LIMIT) setCount({ sessionId, pending: result.items.length })
      const notice = result.items.length === 0 ? (recorded
        ? (zh ? '核对已记录，可以接着对话或继续任务。' : 'Review recorded. You can chat or continue the task.')
        : (zh ? '当前对话没有待核对的操作。' : 'This conversation has no actions to review.'))
        : recorded ? (zh ? '已记录这一条。' : 'This result was recorded.')
          : refreshDecision ? (zh ? '页面结果已更新，请重新确认。' : 'The page view was refreshed. Check it and choose an outcome.') : undefined
      setView({ owner: scope, open: true, busy: false, offer: result, ...(notice === undefined ? {} : { notice }) })
    } catch (error) {
      if (!live()) return
      const code = error instanceof PanelRpcError ? error.code : ''
      const notice = code === 'review-busy'
        ? (zh ? '等当前操作结束后再检查。' : 'Wait for the current action to finish.')
        : code === 'review-read-denied' ? (zh ? '允许读取所选页面后，就能检查结果。' : 'Allow reading the selected page to check the result.')
          : zh ? '请检查当前对话目标，再查看页面结果。' : 'Check the selected page, then inspect the result again.'
      setView({ owner: scope, open: true, busy: false, notice: recorded ? (zh ? `这一条已记录。${notice}` : `This result was recorded. ${notice}`) : notice })
    } finally {
      if (ticket.finish() && current.current === scope) {
        setView(previous => previous.owner === scope && previous.busy ? { ...previous, busy: false } : previous)
      }
    }
  }

  useImperativeHandle(controls, () => ({ inspect }))
  if (!visible.open && (pending ?? 0) === 0) return null
  return <section className="page-recovery guided-recovery" ref={section} aria-label={zh ? '核对操作结果' : 'Review action results'}>
    <div className="troubleshooting-heading">
      <strong>{(pending ?? 0) > 0 ? (zh ? `${pending} 条操作待核对` : `${pending} actions to review`) : (zh ? '核对操作结果' : 'Review action results')}</strong>
      {visible.notice && !offerChanged && <span role="status">{visible.notice}</span>}
    </div>
    {!available && <p>{connected
      ? (zh ? '请在控制分组里选择要核对的页面。' : 'Select the page to review in the control group.')
      : (zh ? '等待 DSH 重新连接后就能继续核对。' : 'You can continue reviewing when DSH reconnects.')}</p>}
    {available && working && <p>{zh ? '当前操作正在结束。' : 'The current action is finishing.'}</p>}
    {visible.busy && <p role="status">{zh ? '正在查看页面结果…' : 'Checking the page result…'}</p>}
    {offer === undefined && ready && <button type="button" className="secondary" disabled={visible.busy}
      onClick={event => inspect(event.nativeEvent)}>{zh ? '检查操作结果' : 'Check action results'}</button>}
    {offer?.items.length && !offerChanged ? <>
      {offer.preview ? <details className="recovery-preview">
        <summary>{zh ? '查看页面内容' : 'View page excerpt'}{tab?.title && <> · <bdi>{tab.title}</bdi></>}</summary>
        <pre>{offer.preview}</pre>
      </details> : tab?.title && <p>{zh ? '核对页面' : 'Reviewing'} · <bdi>{tab.title}</bdi></p>}
      <ul>{offer.items.map(item => {
        const activity = item.kind === 'write' ? parseRecoveryWriteLabel(item.label) : undefined
        const skipped = deferredKeys.includes(item.key)
        return <li key={item.key} className="guided-recovery-item">
          <strong>{reviewLabel(item, zh)}</strong>
          <div className="recovery-item-detail">
            {item.page && <bdi>{item.page}</bdi>}
            {activity?.occurredAt && <time dateTime={activity.occurredAt}>{new Date(activity.occurredAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</time>}
            {activity && <span>{{
              'no-reply': zh ? '回执未收到' : 'Reply not received',
              'reply-error': zh ? '收到错误回执' : 'Error reply received',
              'readback-unconfirmed': zh ? '实际结果待核对' : 'Result needs review',
              'review-invalidated': zh ? '后来收到新回执' : 'A later reply arrived',
            }[activity.outcome]}</span>}
          </div>
          {skipped ? <button type="button" className="secondary" onClick={event => {
            if (event.nativeEvent.isTrusted) setDeferred({ owner: scope, keys: deferredKeys.filter(key => key !== item.key) })
          }}>{zh ? '仍待核对，查看选项' : 'Still pending · Show choices'}</button> : <div className="troubleshooting-actions" role="group" aria-label={reviewLabel(item, zh)}>
            {item.kind === 'recovery' ? <button type="button" className="secondary" disabled={!ready || visible.busy}
              onClick={event => { void inspect(event.nativeEvent, { key: item.key, decision: 'checked' }) }}>{zh ? '已核对任务状态' : 'Task state checked'}</button>
              : <>
                <button type="button" className="secondary" disabled={!ready || visible.busy}
                  onClick={event => inspect(event.nativeEvent, { key: item.key, decision: 'applied' })}>{zh ? '已生效' : 'Applied'}</button>
                <button type="button" className="secondary" disabled={!ready || visible.busy}
                  onClick={event => inspect(event.nativeEvent, { key: item.key, decision: 'not-applied' })}>{zh ? '未生效' : 'Not applied'}</button>
              </>}
            <button type="button" className="secondary skip-review" disabled={visible.busy} onClick={event => {
              if (event.nativeEvent.isTrusted) setDeferred({ owner: scope, keys: [...deferredKeys, item.key] })
            }}>{zh ? '还不确定' : 'Still unsure'}</button>
          </div>}
        </li>
      })}</ul>
    </> : null}
  </section>
}
