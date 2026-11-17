import { useEffect, useMemo, useRef, useState } from 'react'
import type { PanelApi, PageDiagnosticsRequest, PageDiagnosticsStatus } from './api.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'
import { DiagnosticRequests, type DiagnosticReplyTicket } from './diagnostic-requests.ts'

interface DiagnosticView { owner: DiagnosticRequests; status: PageDiagnosticsStatus; busy: boolean; error: string }
const emptyView = (owner: DiagnosticRequests): DiagnosticView => ({ owner, status: { enabled: false, count: 0, dropped: 0 }, busy: false, error: '' })

/** Capture purpose is granted by a native panel click, never by a chat tool. */
export function DiagnosticsPanel({ api, sessionId, affinity, available, locale }: {
  api: PanelApi; sessionId: string | null; affinity: TabAffinityState | null; available: boolean; locale: string
}) {
  const zh = locale === 'zh'
  const tab = affinity?.controlled
  const ready = available && sessionId !== null && tab != null && affinity !== null
  const owner = useMemo(() => new DiagnosticRequests(), [api, sessionId, tab?.tabId, tab?.url, affinity?.revision, available])
  const selected = useRef(owner); selected.current = owner
  const [savedView, setView] = useState(() => emptyView(owner))
  const { status, busy, error } = savedView.owner === owner ? savedView : emptyView(owner)
  const update = (ticket: DiagnosticReplyTicket, patch: Partial<Omit<DiagnosticView, 'owner'>>) => {
    if (selected.current !== owner || !ticket.current()) return
    setView(previous => selected.current === owner && ticket.current()
      ? { ...(previous.owner === owner ? previous : emptyView(owner)), ...patch } : previous)
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
        void api.pageDiagnostics(request).then(value => { if (active) update(ticket, { status: value }) },
          () => { if (active) update(ticket, { status: { enabled: false, count: 0, dropped: 0 } }) })
      }
      refresh(); timer = setInterval(refresh, 5000)
    }
    return () => { active = false; owner.invalidate(); clearInterval(timer) }
  }, [owner])
  if (import.meta.env.EXT_TARGET === 'firefox') return null
  return <details className="page-diagnostics">
    <summary>{zh ? '页面诊断' : 'Page diagnostics'}{status.enabled ? ` · ${status.count}` : ''}</summary>
    <p>{zh ? '开启后记录当前对话所选页面的错误类型和请求状态，供模型联调。最长 10 分钟；导航、切换控制范围或关闭面板后停止。不含消息原文、请求头、正文和完整网址，不能证明业务已保存。'
      : 'Capture error types and request status for this session’s selected page for up to 10 minutes. Stops after navigation, scope changes or panel close. Excludes messages, headers, bodies and full URLs; does not prove a saved change.'}</p>
    <button type="button" className="secondary" disabled={!ready || busy} onClick={event => {
      if (!event.nativeEvent.isTrusted || !ready || !sessionId || !tab || !affinity) return
      const ticket = owner.mutate()
      if (ticket === undefined) return
      update(ticket, { busy: true, error: '' })
      void api.pageDiagnostics({ action: status.enabled ? 'stop' : 'start', sessionId, tabId: tab.tabId, expectedUrl: tab.url,
        revision: affinity.revision, ...(status.captureId ? { captureId: status.captureId } : {}) }).then(value => update(ticket, { status: value }),
        () => update(ticket, { error: zh ? '请求未能确认，请核对所选页面及连接状态' : 'Request was not confirmed. Check the selected page and connection.' }))
        .finally(() => { if (ticket.finish()) update(ticket, { busy: false }) })
    }}>{busy ? (zh ? '正在确认…' : 'Confirming…') : status.enabled ? (zh ? '停止并清空诊断' : 'Stop and clear diagnostics') : (zh ? '开启此页诊断' : 'Enable diagnostics for this page')}</button>
    {status.enabled && <p role="status">{zh ? `已记录 ${status.count} 条，已丢弃 ${status.dropped} 条；请重新触发问题后让模型读取诊断。` : `${status.count} entries, ${status.dropped} dropped. Reproduce the problem, then ask the model to read diagnostics.`}</p>}
    {error && <p role="status">{error}</p>}
  </details>
}
