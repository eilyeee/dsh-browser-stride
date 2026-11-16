import { useEffect, useState } from 'react'
import type { PanelApi, PageAccessStatus } from './api.ts'
import type { PageAuthorizationFailure } from '../page-authorization.ts'
const errors: Record<PageAuthorizationFailure, [string, string]> = {
  'unsupported-page': ['请选择普通 HTTP(S) 网页，再点击 Stride 工具栏图标。浏览器内部页无法接管。', 'Choose an ordinary HTTP(S) page and click the Stride toolbar icon. Browser internal pages cannot be controlled.'],
  'pinned-tab': ['固定标签页无法加入控制分组。请先取消固定，再点击 Stride 工具栏图标。', 'Pinned tabs cannot join the control group. Unpin the tab, then click the Stride toolbar icon.'],
  'page-access-denied': ['浏览器未允许访问该页。请检查扩展的网站访问权限或浏览器策略，再点击工具栏图标重试。', 'The browser did not allow page access. Check extension site access or browser policy, then retry the toolbar icon.'],
  'group-unavailable': ['页面未能加入 DSH 控制分组，请回到目标页点击工具栏图标重试。', 'The page could not join the DSH control group. Return to the intended page and retry the toolbar icon.'],
  'storage-unavailable': ['授权状态未能保存。请重载扩展后重新授权；无需删除 DSH 数据。', 'The page grant could not be saved. Reload the extension and authorize the page again; keep your DSH data.'],
  'page-changed': ['授权过程中页面状态改变。请等待页面加载完成，再点击工具栏图标。', 'The page changed during authorization. Wait for it to finish loading, then click the toolbar icon.'],
}
export function authorizationNotice(access: PageAccessStatus, zh: boolean): string {
  const status = access.authorization
  if (status?.phase === 'failed') return errors[status.code][zh ? 0 : 1]
  if (status?.phase === 'authorizing') return zh ? '正在授权页面并加入控制分组…' : 'Authorizing the page and adding it to the control group…'
  if (status?.phase === 'granted') return zh ? '上次工具栏授权已完成。导航或重载扩展后，页面可能需要重新授权。' : 'The last toolbar authorization completed. Navigation or extension reload may require authorizing the page again.'
  return zh ? '本窗口还没有工具栏授权记录。打开面板或连接 Host 不会自动授权网页。' : 'No toolbar authorization has been recorded in this window. Opening the panel or connecting to the Host does not authorize a page.'
}
export function PageAccessDiagnostics({ api, access, locale }: { api: Pick<PanelApi, 'refreshPageAccess'>; access: PageAccessStatus; locale: string }) {
  const zh = locale === 'zh', [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [expanded, setExpanded] = useState(false)
  const authorization = access.authorization
  useEffect(() => { if (authorization?.phase === 'failed') setExpanded(true) }, [authorization?.phase, authorization?.tabId, authorization?.phase === 'failed' ? authorization.code : undefined])
  return <details className="page-access-diagnostics" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{zh ? '页面连接诊断' : 'Page connection check'}</summary>
    <p role="status">{authorizationNotice(access, zh)}</p>
    <p>{access.authorizedPageCount === undefined ? (zh ? '正在确认面板所属窗口…' : 'Identifying this panel’s window…')
      : (zh ? `本窗口有 ${access.authorizedPageCount} 个已授权页面。` : `${access.authorizedPageCount} authorized pages in this window.`)}</p>
    <p>{zh ? '刷新只核对已有授权，不会接管新页面。未选为当前目标的已授权页仍可显示在列表中。' : 'Refresh checks existing grants without authorizing another page. Authorized pages can be listed before they are selected as the current target.'}</p>
    <button type="button" className="secondary" disabled={busy} onClick={() => {
      setBusy(true); setNotice('')
      void api.refreshPageAccess().then(() => setNotice(zh ? '页面列表已刷新。' : 'Page list refreshed.'),
        () => setNotice(zh ? '刷新未能确认，请检查扩展是否仍在运行。' : 'Refresh was not confirmed. Check that the extension is still running.')).finally(() => setBusy(false))
    }}>{busy ? (zh ? '正在刷新…' : 'Refreshing…') : (zh ? '刷新已授权页面' : 'Refresh authorized pages')}</button>
    {notice && <p role="status">{notice}</p>}
  </details>
}
