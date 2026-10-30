import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { BRIDGE_RUN_LIST_METHOD, BRIDGE_RUN_CONTROL_METHOD, type BrowserRunList, type BrowserRunSummary, type PanelRunControl } from '@eilyeee/dsh-stride-browser-bridge/src/protocol.ts'
import { PanelRpcError, type PanelApi } from './api.ts'
import { parseBrowserRuns, type BrowserRunCopy } from './browser-runs.ts'

export function BrowserRuns({ api, sessionId, connected, copy }: {
  api: Pick<PanelApi, 'rpc'>; sessionId: string | null; connected: boolean; copy: BrowserRunCopy
}) {
  const [view, setView] = useState<{ sessionId: string; data: BrowserRunList } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [notice, setNotice] = useState<{ sessionId: string; code: string } | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const controlling = useRef(false)

  useEffect(() => {
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    setView(null)
    setLoadError(false)
    setPending(null)
    controlling.current = false
    if (sessionId === null || !connected) return
    async function load() {
      if (generation.current !== current) return
      try {
        const data = parseBrowserRuns(await api.rpc(BRIDGE_RUN_LIST_METHOD, { sessionId }), sessionId!)
        if (generation.current !== current) return
        setView({ sessionId: sessionId!, data })
        setLoadError(false)
        timer = setTimeout(() => { void load() }, 2000)
      } catch {
        if (generation.current !== current) return
        setView(null)
        setLoadError(true)
      }
    }
    void load()
    return () => { ++generation.current; clearTimeout(timer) }
  }, [api, sessionId, connected, refresh])

  async function control(event: MouseEvent<HTMLButtonElement>, run: BrowserRunSummary, action: PanelRunControl) {
    if (!event.nativeEvent.isTrusted || controlling.current || !connected || sessionId === null || run.sessionId !== sessionId) return
    controlling.current = true
    const current = ++generation.current // Invalidate reads started before this control.
    setPending(run.runId)
    setNotice(null)
    try {
      await api.rpc(BRIDGE_RUN_CONTROL_METHOD, { sessionId, runId: run.runId, expectedVersion: run.version, control: action })
    } catch (error) {
      if (generation.current === current) setNotice({ sessionId, code: error instanceof PanelRpcError ? error.code : 'unknown' })
    } finally {
      if (generation.current === current) {
        setView(null)
        setPending(null)
        controlling.current = false
        setRefresh(value => value + 1) // Re-read state; never retry the command.
      }
    }
  }

  if (!connected || sessionId === null) return null
  const data = view?.sessionId === sessionId ? view.data : null
  const visibleNotice = notice?.sessionId === sessionId ? notice.code : null
  if (data?.items.length === 0 && visibleNotice === null) return null
  // Initial loads stay unobtrusive for ordinary sessions without managed tasks.
  if (data === null && !loadError && pending === null && visibleNotice === null) return null
  return <section className="browser-runs" aria-label={copy.title}>
    <div className="browser-runs-heading">
      <strong>{copy.title}</strong>
      <button type="button" className="secondary" disabled={pending !== null}
        onClick={() => { setNotice(null); setRefresh(value => value + 1) }}>{copy.refresh}</button>
    </div>
    {loadError && <p role="alert">{copy.error('load-failed')}</p>}
    {visibleNotice !== null && <p role="alert">{copy.error(visibleNotice)}</p>}
    {data === null && !loadError && <p role="status">{copy.loading}</p>}
    {data !== null && <ul>
      {data.items.map(run => <li key={run.runId} data-run-id={run.runId}>
        <div className="browser-run-status">
          <span>{copy.task(run.runId.slice(-8))}</span>
          <strong role="status">{copy.states[run.state]}</strong>
        </div>
        {(run.recoveryRequired || run.requiresReconciliation) && <p>{copy.reconcileHelp}</p>}
        {run.state === 'paused' && <p>{copy.pausedHelp}</p>}
        {run.state === 'stopping' && <p>{copy.stoppingHelp}</p>}
        {run.controls.length > 0 && <div className="browser-run-actions">
          {run.controls.map(action => <button key={action} type="button" className="secondary"
            disabled={pending !== null} onClick={event => { void control(event, run, action) }}>
            {action === 'pause' ? copy.pause : copy.stop}
          </button>)}
        </div>}
      </li>)}
    </ul>}
    {data !== null && data.total > data.items.length && <p>{copy.truncated(data.items.length, data.total)}</p>}
  </section>
}
