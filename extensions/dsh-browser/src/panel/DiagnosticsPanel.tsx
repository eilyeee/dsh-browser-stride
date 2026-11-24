import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { PanelApi, PageDiagnosticsRequest, PageDiagnosticsStatus } from './api.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'
import { DiagnosticRequests, type DiagnosticReplyTicket } from './diagnostic-requests.ts'

interface DiagnosticView { owner: DiagnosticRequests; status: PageDiagnosticsStatus; busy: boolean; error: string; statusUnavailable: boolean; ended: boolean }
const emptyView = (owner: DiagnosticRequests): DiagnosticView => ({ owner, status: { enabled: false, count: 0, dropped: 0 }, busy: false, error: '', statusUnavailable: false, ended: false })
export interface DiagnosticsControls { start(event: Event): void }

/** Capture purpose is granted by a native panel click, never by a chat tool. */
export function DiagnosticsPanel({ api, sessionId, affinity, available, locale, controls, onInspect, canInspect = false }: {
  api: PanelApi; sessionId: string | null; affinity: TabAffinityState | null; available: boolean; locale: string
  controls?: Ref<DiagnosticsControls>; onInspect?(): void; canInspect?: boolean
}) {
  const zh = locale === 'zh'
  const tab = affinity?.controlled
  const ready = available && sessionId !== null && tab != null && affinity !== null
  const owner = useMemo(() => new DiagnosticRequests(), [api, sessionId, tab?.tabId, tab?.url, affinity?.revision, available])
  const selected = useRef(owner); selected.current = owner
  const details = useRef<HTMLDetailsElement>(null)
  const [savedView, setView] = useState(() => emptyView(owner))
  const { status, busy, error, statusUnavailable, ended } = savedView.owner === owner ? savedView : emptyView(owner)
  const update = (ticket: DiagnosticReplyTicket, patch: Partial<Omit<DiagnosticView, 'owner'>>) => {
    if (selected.current !== owner || !ticket.current()) return
    setView(previous => {
      if (selected.current !== owner || !ticket.current()) return previous
      const view = previous.owner === owner ? previous : emptyView(owner)
      return { ...view, ...(view.status.enabled && patch.status?.enabled === false ? { ended: true } : {}), ...patch }
    })
  }
  useEffect(() => {
    let active = true
    setView(emptyView(owner))
    let timer: ReturnType<typeof setInterval> | undefined
    if (ready && tab && affinity && sessionId) {
      const request: PageDiagnosticsRequest = { action: 'status', sessionId, tabId: tab.tabId, expectedUrl: tab.url, revision: affinity.revision }
      const refresh = () => {
        const ticket = owner.read()
        if (ticket === undefined) return
        void api.pageDiagnostics(request).then(value => { if (active) update(ticket, { status: value, statusUnavailable: false }) },
          () => { if (active) update(ticket, { statusUnavailable: true }) })
      }
      refresh(); timer = setInterval(refresh, 5000)
    }
    return () => { active = false; owner.invalidate(); clearInterval(timer) }
  }, [owner])
  function change(event: Event, action: 'start' | 'stop') {
    if (!event.isTrusted) return
    if (details.current) {
      details.current.open = true
      details.current.scrollIntoView?.({ block: 'nearest' })
    }
    if (!ready || !sessionId || !tab || !affinity || action === 'start' && status.enabled) return
    const ticket = owner.mutate()
    if (ticket === undefined) return
    update(ticket, { busy: true, error: '', ended: false })
    void api.pageDiagnostics({ action, sessionId, tabId: tab.tabId, expectedUrl: tab.url,
      revision: affinity.revision, ...(status.captureId ? { captureId: status.captureId } : {}) })
      .then(value => update(ticket, { status: value, statusUnavailable: false }),
        () => update(ticket, { error: zh ? '诊断请求未确认。请检查连接和所选页面。' : 'Check the connection and the selected page, then try again.' }))
      .finally(() => { if (ticket.finish()) update(ticket, { busy: false }) })
  }
  useImperativeHandle(controls, () => ({ start: event => change(event, 'start') }))

  if (import.meta.env.EXT_TARGET === 'firefox') return null
  return <details className="page-diagnostics" ref={details}>
    <summary>{status.enabled && !statusUnavailable
      ? (zh ? `诊断记录中 · ${status.count} 条` : `Recording diagnostics · ${status.count}`)
      : statusUnavailable ? (zh ? '诊断状态待确认' : 'Diagnostic status unconfirmed') : (zh ? '更多' : 'More')}</summary>
    <p><strong>{zh ? '页面诊断' : 'Page diagnostics'}</strong>{tab && <> · <bdi>{tab.title || (zh ? '所选页面' : 'Selected page')}</bdi></>}</p>
    {ready ? <p>{zh ? '记录接下来发生的页面错误和请求状态，最多 10 分钟。切换页面或关闭侧栏时结束。'
      : 'Record new page errors and request status for up to 10 minutes. Capture ends when you switch pages or close the panel.'}</p>
      : <p>{zh ? '连接 DSH，并从控制分组选择要排查的页面。' : 'Connect to DSH and select a page from the control group.'}</p>}
    <div className="troubleshooting-actions">
      <button type="button" className="secondary" disabled={!ready || busy}
        onClick={event => change(event.nativeEvent, status.enabled ? 'stop' : 'start')}>
        {busy ? (zh ? '正在确认…' : 'Confirming…') : status.enabled ? (zh ? '停止并清空诊断' : 'Stop and clear diagnostics') : (zh ? '开启此页诊断' : 'Enable diagnostics for this page')}
      </button>
      {status.enabled && status.count > 0 && onInspect && <button type="button" className="secondary" disabled={!ready || busy || !canInspect || statusUnavailable}
        onClick={event => { if (event.nativeEvent.isTrusted && ready && canInspect) onInspect() }}>{zh ? '让 DSH 查看' : 'Ask DSH to inspect'}</button>}
    </div>
    {status.enabled && !statusUnavailable && <p role="status">{zh ? `已记录 ${status.count} 条${status.count === 0 ? '，等待页面事件。' : '。'}`
      : `${status.count} entries.${status.count === 0 ? ' Waiting for page events.' : ''}`}
      {status.dropped > 0 && (zh ? `较早的 ${status.dropped} 条已清理。` : ` ${status.dropped} older entries were cleared.`)}</p>}
    {ended && !status.enabled && !statusUnavailable && <p role="status">{zh ? '诊断已停止，记录已清空。' : 'Capture ended and the record was cleared.'}</p>}
    {statusUnavailable && <p role="status">{zh ? '正在确认记录状态，请检查连接或页面是否切换。' : 'Capture status is unavailable. Check the connection and selected page.'}</p>}
    <details className="diagnostic-details"><summary>{zh ? '记录范围' : 'What gets recorded'}</summary>
      <p>{zh ? '仅记录错误类型及请求状态等概要。保存结果请查实际业务记录。'
        : 'Only a summary of error types and request status is collected. Check the business record to verify a save.'}</p>
    </details>
    {error && <p role="status">{error}</p>}
  </details>
}
