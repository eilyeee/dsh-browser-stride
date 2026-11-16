import { useEffect, useRef, useState } from 'react'
import type { RecoveryOffer, RecoveryDecisions } from '@eilyeee/dsh-browser-stride/src/native-review.ts'
import type { PanelApi } from './api.ts'
import { PanelRpcError } from './api.ts'
import type { TabAffinityState } from '../background/tab-affinity.ts'

/** A human checkpoint. No default decision and no automatic task restart. */
export function RecoveryPanel({ api, sessionId, affinity, available, working, locale }: {
  api: PanelApi; sessionId: string | null; affinity: TabAffinityState | null; available: boolean; working: boolean; locale: string
}) {
  const zh = locale === 'zh', tab = affinity?.controlled
  const [offer, setOffer] = useState<RecoveryOffer | null>(null)
  const [decisions, setDecisions] = useState<Record<string, RecoveryDecisions[number]['decision']>>({})
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const identity = `${sessionId}:${tab?.tabId}:${tab?.url}:${affinity?.revision}:${available}`
  const selected = useRef(identity); selected.current = identity
  const ready = available && !working && sessionId !== null && tab != null && affinity !== null
  useEffect(() => { setOffer(null); setDecisions({}); setNotice('') }, [identity])
  const complete = offer !== null && offer.items.length > 0 && offer.expiresAt > Date.now() && offer.items.every(item => decisions[item.key] !== undefined)
  async function act(confirm: boolean) {
    if (!ready || !sessionId || !tab || !affinity || (confirm && (!offer || !complete))) return
    setBusy(true); setNotice('')
    try {
      const scope = { sessionId, tabId: tab.tabId, expectedUrl: tab.url, revision: affinity.revision }
      const response = await api.pageRecovery(confirm ? { ...scope, action: 'confirm', reviewId: offer!.reviewId,
        decisions: offer!.items.map(item => ({ key: item.key, decision: decisions[item.key]! })) } : { ...scope, action: 'prepare' })
      if (selected.current !== identity) return
      if (confirm) {
        if (!('reviewed' in response) || response.reviewed !== true || response.resumed !== false || response.completed !== false) throw Error('invalid review response')
        setOffer(null); setDecisions({})
        setNotice(zh ? '核对已记录，任务仍未启动，也未标记完成。需要继续时重新选择页面，使用任务的继续入口或发送新指令。' : 'Review recorded. The task has not resumed or been marked complete. Select the intended page and explicitly continue or send a new instruction.')
      } else {
        if (!('items' in response) || !Array.isArray(response.items)) throw Error('invalid review response')
        const value = response; setOffer(value); setDecisions({})
        if (value.items.length === 0) setNotice(zh ? '当前没有需要人工核对的操作。' : 'No operations currently require manual review.')
      }
    } catch (error) {
      if (selected.current !== identity) return
      setOffer(null); setDecisions({})
      const code = error instanceof PanelRpcError ? error.code : 'review-stale'
      setNotice(code === 'review-read-required' ? (zh ? '请先让模型只读当前页面，核对实际业务结果后再刷新清单。页面读取不能替代人工判断。' : 'Ask the model to read the current page, then inspect the actual business result before refreshing. A page read does not replace human judgment.')
        : code === 'review-busy' ? (zh ? '请先暂停或停止任务，并等待当前对话与页面操作结束。' : 'Pause or stop the task and wait for the current conversation and page operations to finish.')
        : (zh ? '核对结果尚未确认，请重新读取页面并刷新清单。未确定的操作保持阻塞，不要重复提交。' : 'Review was not confirmed. Read the page again and refresh. Uncertain operations remain blocked; do not resubmit them.'))
    } finally { setBusy(false) }
  }
  if (import.meta.env.EXT_TARGET === 'firefox' || !available) return null
  return <details className="page-recovery">
    <summary>{zh ? '核对未确认操作' : 'Review uncertain operations'}</summary>
    <p>{zh ? '先暂停任务，让模型只读检查当前页面，再由你核对实际业务记录。仅看到成功提示、HTTP 200 或模型说完成，都不足以确认保存。不能确定的项目保留「仍不确定」，继续保持阻塞。记录核对只解除相应限制，不会重发操作、自动续跑或证明任务完成。'
      : 'Pause the task, request a read-only page check, then inspect actual business records yourself. A toast, HTTP 200 or model claim is insufficient proof of persistence. Keep uncertain items undecided. Recording review only resolves their fence; it does not replay actions, resume the task or verify completion.'}</p>
    <button type="button" className="secondary" disabled={!ready || busy} onClick={event => { if (event.nativeEvent.isTrusted) void act(false) }}>{busy ? (zh ? '正在确认…' : 'Confirming…') : (zh ? '刷新核对清单' : 'Refresh review list')}</button>
    {offer !== null && offer.items.length > 0 && <>
      <ul>{offer.items.map(item => {
        const options: Array<{ value: '' | RecoveryDecisions[number]['decision']; text: string }> = [
          { value: '', text: zh ? '仍不确定，保持阻塞' : 'Still uncertain; keep blocked' },
          ...(item.kind === 'recovery' ? [{ value: 'checked' as const, text: zh ? '已人工核对当前状态' : 'I inspected the current state' }]
            : [{ value: 'applied' as const, text: zh ? '已确认生效，不重做' : 'Confirmed applied; do not repeat' },
              { value: 'not-applied' as const, text: zh ? '已确认未生效，后续重新决定' : 'Confirmed not applied; decide next action separately' }]),
        ]
        return <li key={item.key}><fieldset disabled={busy}>
          <legend>{item.kind === 'recovery' ? (zh ? '中断任务的当前状态' : 'Interrupted task state') : item.label} <small>{item.key.slice(-12)}</small></legend>
          {options.map(option => <label key={option.value}>
            <input type="radio" name={`review-${item.key}`} value={option.value} checked={(decisions[item.key] ?? '') === option.value} onChange={event => {
              if (!event.nativeEvent.isTrusted) return
              setDecisions(previous => { const next = { ...previous }; if (option.value === '') delete next[item.key]; else next[item.key] = option.value; return next })
            }} />{option.text}
          </label>)}
        </fieldset></li>
      })}</ul>
      <button type="button" className="secondary" disabled={!ready || busy || !complete} onClick={event => { if (event.nativeEvent.isTrusted) void act(true) }}>{zh ? '记录人工核对，不自动继续' : 'Record review without resuming'}</button>
    </>}
    {notice && <p role="status">{notice}</p>}
  </details>
}
