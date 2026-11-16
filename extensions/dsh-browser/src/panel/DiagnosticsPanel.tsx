import { useEffect, useRef, useState } from 'react'
import type { PanelApi, PageDiagnosticsRequest, PageDiagnosticsStatus } from './api.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'

/** Capture purpose is granted by a native panel click, never by a chat tool. */
export function DiagnosticsPanel({ api, sessionId, affinity, available, locale }: {
  api: PanelApi; sessionId: string | null; affinity: TabAffinityState | null; available: boolean; locale: string
}) {
  const zh = locale === 'zh'
  const [status, setStatus] = useState<PageDiagnosticsStatus>({ enabled: false, count: 0, dropped: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const tab = affinity?.controlled
  const ready = available && sessionId !== null && tab != null && affinity !== null
  const identity = `${sessionId}:${tab?.tabId}:${tab?.url}:${affinity?.revision}:${available}`
  const selected = useRef(identity)
  selected.current = identity
  useEffect(() => {
    let active = true
    setStatus({ enabled: false, count: 0, dropped: 0 }); setError('')
    if (!ready || !tab || !affinity || !sessionId) return
    const request: PageDiagnosticsRequest = { action: 'status', sessionId, tabId: tab.tabId, expectedUrl: tab.url, revision: affinity.revision }
    const refresh = () => { void api.pageDiagnostics(request).then(value => { if (active) setStatus(value) }, () => { if (active) setStatus({ enabled: false, count: 0, dropped: 0 }) }) }
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [api, ready, sessionId, tab?.tabId, tab?.url, affinity?.revision])
  if (import.meta.env.EXT_TARGET === 'firefox') return null
  return <details className="page-diagnostics">
    <summary>{zh ? '页面诊断' : 'Page diagnostics'}{status.enabled ? ` · ${status.count}` : ''}</summary>
    <p>{zh ? '开启后记录当前对话所选页面的错误类型和请求状态，供模型联调。最长 10 分钟；导航、切换控制范围或关闭面板后停止。不含消息原文、请求头、正文和完整网址，不能证明业务已保存。'
      : 'Capture error types and request status for this session’s selected page for up to 10 minutes. Stops after navigation, scope changes or panel close. Excludes messages, headers, bodies and full URLs; does not prove a saved change.'}</p>
    <button type="button" className="secondary" disabled={!ready || busy} onClick={event => {
      if (!event.nativeEvent.isTrusted || !ready || !sessionId || !tab || !affinity) return
      setBusy(true); setError('')
      void api.pageDiagnostics({ action: status.enabled ? 'stop' : 'start', sessionId, tabId: tab.tabId, expectedUrl: tab.url,
        revision: affinity.revision, ...(status.captureId ? { captureId: status.captureId } : {}) }).then(value => { if (selected.current === identity) setStatus(value) },
        () => { if (selected.current === identity) setError(zh ? '请求未能确认，请核对所选页面及连接状态' : 'Request was not confirmed. Check the selected page and connection.') }).finally(() => setBusy(false))
    }}>{busy ? (zh ? '正在确认…' : 'Confirming…') : status.enabled ? (zh ? '停止并清空诊断' : 'Stop and clear diagnostics') : (zh ? '开启此页诊断' : 'Enable diagnostics for this page')}</button>
    {status.enabled && <p role="status">{zh ? `已记录 ${status.count} 条，已丢弃 ${status.dropped} 条；请重新触发问题后让模型读取诊断。` : `${status.count} entries, ${status.dropped} dropped. Reproduce the problem, then ask the model to read diagnostics.`}</p>}
    {error && <p role="status">{error}</p>}
  </details>
}
