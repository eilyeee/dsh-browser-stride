import { useEffect, useRef, useState } from 'react'
import type { UiLocale } from '../i18n.ts'
import type { PanelApi } from './api.ts'
import { clearBriefDraft, readBriefDraft, writeBriefDraft } from './task-brief-drafts.ts'
import type { AffinityTab } from '../background/tab-affinity.ts'
import { availableMaterialPages, materialFromPage, matchingMaterialPages } from './task-materials.ts'
import { TASK_BRIEF_GET, TASK_BRIEF_SAVE, TASK_BRIEF_REVIEW, MATERIAL_ROLES,
  type TaskBrief, type TaskBriefInput } from '@eilyeee/dsh-browser-stride/src/task-brief-contract.ts'

const COPY = {
  zh: { title: '任务资料与验收', goal: '本轮目标', project: '项目目录', projectHint: '记录目录不会切换当前对话的工作目录。可从已保存的项目另建对话。',
    newChat: '从此项目新建对话', materials: '参考材料', label: '材料名称', url: '材料链接', add: '添加材料', remove: '移除', criteria: '验收条件（每行一条，最多 16 条）',
    save: '保存资料', reload: '重新载入', discard: '重新载入（放弃未保存修改）', saved: '已保存', loading: '正在读取…',
    error: '资料读取或保存失败。请重新载入后核对；过期版本不会覆盖现有资料。', empty: '还没有验收条件。可填写，或让模型根据本轮需求整理。',
    badInput: '请检查资料格式：材料需为不含凭据的 HTTP(S) 链接，最多 8 个；验收条件最多 16 条。', stale: '资料已被更新，请先重新载入核对。当前修改没有覆盖新记录。',
    restored: '已保留未保存草稿。连接恢复后可继续编辑；保存时仍会检查资料版本。',
    unavailable: '任务资料暂不可用，聊天可以继续。这不代表资料已清空；请检查 Host 存储，恢复后再读回核对。',
    sessionUnavailable: '当前对话未能保留，资料尚未确认保存。草稿已保留，请重新连接后核对。',
    fromGroup: '从控制分组添加材料', addPage: '添加页面', addedPage: '已加入草稿，保存后模型才能读取。材料用途由模型结合内容判断。',
    noPages: '没有可添加的页面。请先在目标页面点击 DSH Stride 图标授权；已添加的页面不会重复列出。',
    limit: '最多添加 8 份材料。请先移除不再使用的材料。', usePage: '使用已有页面', currentPage: '当前使用',
    selectedPage: '已选用此页，下一条消息可使用它。尚未发送消息。', selectionFailed: '未能选用材料页面。页面可能已关闭、导航或撤销授权，请在控制分组中重新核对。',
    external: '在新标签页打开；控制前需点击扩展图标授权',
    provenance: '以下是模型报告的进度和观察依据。核对后可确认；它不会改变托管任务的完成状态。',
    pending: '待实现', implemented: '模型报告已实现', blocked: '缺少条件', unverified: '尚未核验', observed: '模型已观察到', uncertain: '结果不明',
    confirmed: '用户已核验', confirm: '确认核验通过', undo: '撤销核验确认', next: '下一步', noEvidence: '尚无观察依据', export: '下载验收记录', inferred: '模型建议',
    roles: { unknown: '待模型判断', requirement: '需求说明', design: '设计参考', api: '接口文档', reference: '其他参考' } },
  en: { title: 'Task materials and acceptance', goal: 'Goal', project: 'Project directory', projectHint: 'Recording a directory does not move this conversation. Start a new chat from the saved project if needed.',
    newChat: 'New chat in this project', materials: 'Materials', label: 'Material name', url: 'Material URL', add: 'Add material', remove: 'Remove', criteria: 'Acceptance criteria (one per line, up to 16)',
    save: 'Save notes', reload: 'Reload', discard: 'Reload (discard unsaved edits)', saved: 'Saved', loading: 'Loading…',
    error: 'Could not read or save notes. Reload and check them; stale versions cannot overwrite existing notes.', empty: 'No acceptance criteria yet. Add them or ask the model to organize this task.',
    badInput: 'Check the input: up to 8 HTTP(S) links without credentials and 16 acceptance criteria.', stale: 'The notes changed. Reload and check them; your edits did not overwrite the newer record.',
    restored: 'Unsaved draft retained. Continue editing after reconnecting; saving still checks the record version.',
    unavailable: 'Task notes are unavailable; chat can continue. This does not mean notes were cleared. Check Host storage, then read back after recovery.',
    sessionUnavailable: 'The conversation could not be retained, so saving notes was not confirmed. Your draft is retained; reconnect and check it.',
    fromGroup: 'Add materials from the control group', addPage: 'Add page', addedPage: 'Added to the draft. Save before the model can read it. The model determines its role from the content.',
    noPages: 'No pages to add. Authorize the intended page using the DSH Stride toolbar icon first; materials already added are excluded.',
    limit: 'Up to 8 materials. Remove an unused material first.', usePage: 'Use existing page', currentPage: 'Currently selected',
    selectedPage: 'Page selected for your next message. No message was sent.', selectionFailed: 'Could not select the material page. It may have closed, navigated or lost authorization. Check the control group again.',
    external: 'Opens a new tab; authorize it using the extension icon before controlling it',
    provenance: 'Progress and evidence below are model reports. Confirm after reviewing; this does not change a managed task verdict.',
    pending: 'Pending', implemented: 'Model reports implemented', blocked: 'Missing conditions', unverified: 'Not checked', observed: 'Model observed', uncertain: 'Uncertain result',
    confirmed: 'User reviewed', confirm: 'Confirm review passed', undo: 'Undo review confirmation', next: 'Next step', noEvidence: 'No observation evidence yet', export: 'Download acceptance record', inferred: 'Model suggests',
    roles: { unknown: 'Model to determine', requirement: 'Requirements', design: 'Design reference', api: 'API docs', reference: 'Other reference' } },
} as const
function errorMessage(error: unknown, locale: UiLocale): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'storage-unavailable') return COPY[locale].unavailable
  if (code === 'session-unavailable') return COPY[locale].sessionUnavailable
  return code === 'bad-request' ? COPY[locale].badInput : code === 'stale-version' ? COPY[locale].stale : COPY[locale].error
}
function inputFrom(brief: TaskBrief): TaskBriefInput {
  return { goal: brief.goal, projectPath: brief.projectPath, materials: brief.materials, criteria: brief.criteria }
}
export function criteriaFromLines(value: string, previous: TaskBriefInput['criteria']): TaskBriefInput['criteria'] {
  const used = new Set<string>()
  return value.split('\n').map(text => text.trim()).filter(Boolean).map(text => {
    const old = previous.find(item => item.text === text && !used.has(item.id))
    const id = old?.id ?? `criterion-${crypto.randomUUID()}`
    used.add(id)
    return { id, text }
  })
}
export function acceptanceMarkdown(brief: TaskBrief, locale: UiLocale): string {
  const c = COPY[locale]
  const md = (value: string) => value.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&')
  return [`# ${md(brief.goal || c.title)}`, '', `${c.project}: ${md(brief.projectPath)}`, '', c.provenance, '',
    ...brief.materials.map(item => `- ${c.roles[item.role]}${item.role === 'unknown' && item.inferredRole ? ` (${c.inferred}: ${c.roles[item.inferredRole]})` : ''}: [${md(item.label || item.url)}](<${item.url.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`), '',
    ...brief.criteria.flatMap(criterion => {
      const progress = brief.progress.find(item => item.criterionId === criterion.id)
      return [`## ${md(criterion.text)}`, '', progress ? `${c[progress.implementation]} · ${progress.userConfirmed ? c.confirmed : c[progress.observation]}` : `${c.pending} · ${c.unverified}`,
        ...(progress?.evidence.length ? progress.evidence.map(item => `- ${md(item)}`) : [c.noEvidence]),
        ...(progress?.nextStep ? [`${c.next}: ${md(progress.nextStep)}`] : []), '']
    }),
  ].join('\n')
}
export function TaskBriefPanel({ api, sessionId, supported, connected, locale, onProjectChat, canStartProject = true, hostIdentity = 'panel', unavailable = false,
  pages = [], selectedTabId, onSelectPage, canSelectPage = true }: {
  api: Pick<PanelApi, 'rpc'>; sessionId: string | null; supported: boolean; connected: boolean; locale: UiLocale;
  onProjectChat: (brief: TaskBrief) => void
  canStartProject?: boolean
  hostIdentity?: string
  unavailable?: boolean
  pages?: AffinityTab[]
  selectedTabId?: number
  onSelectPage?: (page: AffinityTab) => Promise<void>
  canSelectPage?: boolean
}) {
  const c = COPY[locale]
  const [brief, setBrief] = useState<TaskBrief | null>(null)
  const [draft, setDraft] = useState<TaskBriefInput | null>(null)
  const [criteriaText, setCriteriaText] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const openRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [notice, setNotice] = useState('')
  const epoch = useRef(0)
  const versionRef = useRef(0)
  const readRef = useRef<() => Promise<void>>(async () => {})
  const draftToken = useRef<object | undefined>(undefined)
  function apply(next: TaskBrief) {
    if (sessionId !== null) clearBriefDraft(api, hostIdentity, sessionId, draftToken.current)
    draftToken.current = undefined
    versionRef.current = next.version
    setBrief(next); setDraft(inputFrom(next)); setCriteriaText(next.criteria.map(item => item.text).join('\n'))
    dirtyRef.current = false; setDirty(false)
  }
  useEffect(() => {
    const cached = sessionId === null ? undefined : readBriefDraft(api, hostIdentity, sessionId)
    setBrief(cached?.brief ?? null); setDraft(cached?.input ?? null); setCriteriaText(cached?.criteriaText ?? '')
    dirtyRef.current = cached !== undefined; setDirty(cached !== undefined)
    draftToken.current = cached?.token; versionRef.current = cached?.brief.version ?? 0
    setNotice(cached === undefined ? '' : c.restored)
  }, [api, hostIdentity, sessionId, c.restored])
  useEffect(() => {
    const generation = ++epoch.current
    setBusy(false); busyRef.current = false
    if (!supported || !connected || sessionId === null) return
    let loading = false
    async function read() {
      if (loading || dirtyRef.current || busyRef.current) return
      loading = true
      try {
        const next = await api.rpc<TaskBrief>(TASK_BRIEF_GET, { sessionId })
        if (epoch.current === generation && !dirtyRef.current && !busyRef.current && next.version >= versionRef.current) apply(next)
      } catch (error) { if (epoch.current === generation) setNotice(errorMessage(error, locale)) }
      finally { loading = false }
    }
    readRef.current = read
    void read()
    const timer = setInterval(() => { if (openRef.current) void read() }, 3000)
    return () => { epoch.current++; readRef.current = async () => {}; clearInterval(timer) }
  }, [api, hostIdentity, sessionId, supported, connected, c.error])
  function edit(next: TaskBriefInput, text = criteriaText) {
    setDraft(next); dirtyRef.current = true; setDirty(true); setNotice('')
    if (sessionId !== null && brief !== null) draftToken.current = writeBriefDraft(api, hostIdentity, sessionId, { brief, input: next, criteriaText: text })
  }
  async function mutate(method: string, payload: object) {
    const generation = epoch.current
    const submittedToken = draftToken.current
    setBusy(true); busyRef.current = true; setNotice('')
    try {
      const next = await api.rpc<TaskBrief>(method, payload)
      if (method === TASK_BRIEF_SAVE && sessionId !== null) clearBriefDraft(api, hostIdentity, sessionId, submittedToken)
      if (epoch.current === generation) { apply(next); setNotice(c.saved) }
    } catch (error) { if (epoch.current === generation) setNotice(errorMessage(error, locale)) }
    finally { if (epoch.current === generation) { setBusy(false); busyRef.current = false } }
  }
  async function exportRecord() {
    const generation = epoch.current
    busyRef.current = true; setBusy(true); setNotice('')
    try {
      const latest = await api.rpc<TaskBrief>(TASK_BRIEF_GET, { sessionId })
      if (epoch.current !== generation || dirtyRef.current) return
      apply(latest)
      const url = URL.createObjectURL(new Blob([acceptanceMarkdown(latest, locale)], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = 'stride-acceptance.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { if (epoch.current === generation) setNotice(errorMessage(error, locale)) }
    finally { if (epoch.current === generation) { setBusy(false); busyRef.current = false } }
  }
  async function selectPage(page: AffinityTab) {
    if (onSelectPage === undefined || busyRef.current || !canSelectPage || !connected) return
    const generation = epoch.current
    busyRef.current = true; setBusy(true); setNotice('')
    try {
      await onSelectPage(page)
      if (epoch.current === generation) setNotice(c.selectedPage)
    } catch { if (epoch.current === generation) setNotice(c.selectionFailed) }
    finally { if (epoch.current === generation) { busyRef.current = false; setBusy(false) } }
  }
  if ((!supported && !unavailable) || sessionId === null) return null
  const editable = connected && supported
  const addablePages = draft === null ? [] : availableMaterialPages(pages, draft.materials)
  return <details className="task-brief-panel" onToggle={event => { openRef.current = event.currentTarget.open; if (openRef.current) void readRef.current() }}>
    <summary>{c.title}</summary>
    {unavailable && <p role="status">{c.unavailable}</p>}
    {brief === null || draft === null ? (!unavailable && <p role="status">{notice || c.loading}</p>) : <>
      <label>{c.goal}<textarea aria-label={c.goal} value={draft.goal} maxLength={2000} disabled={busy || !editable}
        onChange={event => { edit({ ...draft, goal: event.target.value }) }} /></label>
      <label>{c.project}<input aria-label={c.project} value={draft.projectPath} maxLength={1000} disabled={busy || !editable}
        onChange={event => { edit({ ...draft, projectPath: event.target.value }) }} /></label>
      <p className="settings-note">{c.projectHint}</p>
      {brief.projectPath && <button type="button" disabled={dirty || busy || !editable || !canStartProject} onClick={event => {
        if (event.nativeEvent.isTrusted) onProjectChat(brief)
      }}>{c.newChat}</button>}
      <fieldset disabled={busy || !editable}><legend>{c.materials}</legend>
        <details className="task-material-picker"><summary>{c.fromGroup}</summary>
          {draft.materials.length >= 8 ? <p>{c.limit}</p> : <div role="group" aria-label={c.fromGroup}>
            {addablePages.length === 0 && <p>{c.noPages}</p>}
            {addablePages.map(page => <button key={page.tabId} type="button" title={page.url}
              onClick={() => {
                const material = materialFromPage(page)
                if (material === undefined || draft.materials.length >= 8) return
                edit({ ...draft, materials: [...draft.materials, material] }); setNotice(c.addedPage)
              }}>{c.addPage}: {materialFromPage(page)!.label || page.url}</button>)}
          </div>}
        </details>
        {draft.materials.map((item, index) => <div className="task-material" key={index}>
          <input aria-label={`${c.label} ${index + 1}`} value={item.label} placeholder={c.label} maxLength={120}
            onChange={event => { edit({ ...draft, materials: draft.materials.map((item, at) => at === index ? { ...item, label: event.target.value } : item) }) }} />
          <input aria-label={`${c.url} ${index + 1}`} value={item.url} placeholder="https://…" maxLength={2000}
            onChange={event => { edit({ ...draft, materials: draft.materials.map((item, at) => at === index ? { url: event.target.value, label: item.label, role: item.role } : item) }) }} />
          <select aria-label={`${c.materials} ${index + 1}`} value={item.role}
            onChange={event => { edit({ ...draft, materials: draft.materials.map((item, at) => at === index ? { url: item.url, label: item.label, role: event.target.value as typeof item.role } : item) }) }}>
            {MATERIAL_ROLES.map(role => <option key={role} value={role}>{c.roles[role]}</option>)}
          </select>
          {item.role === 'unknown' && item.inferredRole && <small>{c.inferred}: {c.roles[item.inferredRole]}</small>}
          <button type="button" onClick={() => { edit({ ...draft, materials: draft.materials.filter((_, at) => at !== index) }) }}>{c.remove}</button>
        </div>)}
        <button type="button" disabled={draft.materials.length >= 8} onClick={() => { edit({ ...draft, materials: [...draft.materials, { url: '', label: '', role: 'unknown' }] }) }}>{c.add}</button>
      </fieldset>
      {brief.materials.length > 0 && <ul className="task-material-links">{brief.materials.map(item => {
        const matches = matchingMaterialPages(item.url, pages)
        return <li key={item.url}>
          {matches.length > 0 && onSelectPage !== undefined ? <>
            <span>{item.label || item.url}</span>
            {matches.map(page => <button key={page.tabId} type="button" title={page.url} data-material-tab-id={page.tabId}
              aria-pressed={selectedTabId === page.tabId} disabled={busy || !connected || !canSelectPage || selectedTabId === page.tabId}
              onClick={event => { if (event.nativeEvent.isTrusted) void selectPage(page) }}>
              {selectedTabId === page.tabId ? c.currentPage : c.usePage}{matches.length > 1 ? `: ${page.title || page.url} (${page.tabId})` : ''}
            </button>)}
          </> : <a href={item.url} target="_blank" rel="noopener noreferrer" title={c.external}>{item.label || item.url}</a>}
          {' · '}{c.roles[item.role]}
        </li>
      })}</ul>}
      <label>{c.criteria}<textarea aria-label={c.criteria} value={criteriaText} maxLength={6415} disabled={busy || !editable}
        onChange={event => { setCriteriaText(event.target.value); edit({ ...draft, criteria: criteriaFromLines(event.target.value, draft.criteria) }, event.target.value) }} /></label>
      <div className="task-brief-actions">
        <button type="button" disabled={!dirty || busy || !editable || draft.criteria.length > 16} onClick={() => {
          void mutate(TASK_BRIEF_SAVE, { sessionId, version: brief.version, input: draft })
        }}>{c.save}</button>
        <button type="button" disabled={busy || !editable} onClick={() => { void mutate(TASK_BRIEF_GET, { sessionId }) }}>{dirty ? c.discard : c.reload}</button>
        <button type="button" disabled={busy || dirty || !editable} onClick={() => { void exportRecord() }}>{c.export}</button>
      </div>
      <p className="settings-note">{c.provenance}</p>
      {brief.criteria.length === 0 && <p>{c.empty}</p>}
      <ul className="task-criteria">{brief.criteria.map(item => {
        const progress = brief.progress.find(entry => entry.criterionId === item.id)
        return <li key={item.id}><strong>{item.text}</strong>
          <p>{progress ? `${c[progress.implementation]} · ${progress.userConfirmed ? c.confirmed : c[progress.observation]}` : `${c.pending} · ${c.unverified}`}</p>
          {progress?.evidence.length ? <ul>{progress.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p>{c.noEvidence}</p>}
          {progress?.nextStep && <p>{c.next}: {progress.nextStep}</p>}
          {progress?.implementation === 'implemented' && progress.observation === 'observed' && <button type="button" disabled={busy || dirty || !editable}
            onClick={event => { if (event.nativeEvent.isTrusted) void mutate(TASK_BRIEF_REVIEW, { sessionId, version: brief.version, criterionId: item.id, confirmed: !progress.userConfirmed }) }}>
            {progress.userConfirmed ? c.undo : c.confirm}</button>}
        </li>
      })}</ul>
    </>}
    {notice && brief !== null && <p role="status">{notice}</p>}
  </details>
}
