// Disposable Host probe: real tool/attachment pipeline, optional bounded default-model check.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { guardMaterialProjectFile, materialProjectScope, PROJECT_FILE_TOOLS } from './material-project-scope.mjs'
async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export function matchesLayerReport(text, expected) {
  try {
    const report = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    const number = value => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value.trim()) ? Number.parseFloat(value) : NaN
    return report.background?.layer === expected.layer && report.background?.fill?.toLowerCase() === expected.color
      && ['width', 'height', 'radius'].every(key => number(report.background[key]) === expected[key])
      && report.text?.layer === expected.textLayer && report.text?.color?.toLowerCase() === expected.text.color
      && ['width', 'height', 'fontSize', 'lineHeight'].every(key => number(report.text[key]) === expected.text[key])
      && /^(?:\d+(?:\.\d+)?)$/.test(String(report.text.fontWeight)) && Number(report.text.fontWeight) === expected.text.fontWeight
  } catch { return false }
}
export function matchesLayoutReport(text) {
  try {
    const report = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    // In particular, never coerce null/false/empty string into a measured zero.
    return report.before?.verticalGap === 0 && report.before?.marginTop === '0px'
      && report.before?.oldSelectorMatched === false && report.after?.verticalGap === 50
      && report.after?.marginTop === '50px'
  } catch { return false }
}
export function reportedDesignZoom(text) {
  try {
    const report = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    const zoom = typeof report.viewZoom === 'string' && /^\d{3}%$/.test(report.viewZoom) ? Number.parseInt(report.viewZoom) : NaN
    return zoom >= 100 && zoom <= 200 ? zoom : null
  } catch { return null }
}
export function matchesWikiReport(text, expected) {
  try {
    const report = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '')
    return sameJson(report, expected)
  } catch { return false }
}
/** Exact case schema, including nested fields; object key order is immaterial. */
function sameJson(value, expected) {
  if (value === expected) return true
  if (Array.isArray(value) || Array.isArray(expected)) {
    return Array.isArray(value) && Array.isArray(expected) && value.length === expected.length
      && value.every((item, index) => sameJson(item, expected[index]))
  }
  if (value === null || expected === null || typeof value !== 'object' || typeof expected !== 'object') return false
  const keys = Object.keys(expected)
  return Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key) && sameJson(value[key], expected[key]))
}
export const name = 'stride-visual-probe'
export const inject = ['tools', 'agents', 'attachments']
export const MODEL_BROWSER_TOOLS = ['browser_screenshot','browser_snapshot','browser_click_at','browser_get_text','browser_read_design_styles','browser_wait','browser_scroll']
export const ZOOM_MODEL_TOOLS = [...MODEL_BROWSER_TOOLS, 'browser_set_design_zoom', 'browser_select']
export const WIKI_MODEL_TOOLS = [...ZOOM_MODEL_TOOLS, 'browser_measure_layout', 'browser_click', 'browser_press', 'browser_list_tabs', 'browser_follow_tab', 'browser_open_tab']
const LAYOUT_MODEL_TOOLS = ['browser_snapshot', 'browser_measure_layout', 'browser_navigate', 'browser_wait']
export const WIDGET_MODEL_TOOLS = ['browser_snapshot','browser_click','browser_type','browser_press','browser_navigate','browser_wait','browser_get_text']
const modelTools = model => model.reportKind === 'widgets' ? WIDGET_MODEL_TOOLS : model.reportKind === 'wiki' ? [...WIKI_MODEL_TOOLS, ...(model.projectFile ? PROJECT_FILE_TOOLS : [])] : model.reportKind === 'layout' ? LAYOUT_MODEL_TOOLS
  : model.autoZoom === true ? ZOOM_MODEL_TOOLS : MODEL_BROWSER_TOOLS
export function apply(ctx, config) {
  let sequence = -1, pending = false, model, releaseModelTools, writes = Promise.resolve()
  const controller = new AbortController()
  const evidence = { modelRequests: 0, browserCalls: [], results: [], blocked: [], terminal: false }
  const belongs = agent => model !== undefined && String(agent?.id) === model.sessionId
  const save = () => {
    const value = structuredClone(evidence)
    return writes = writes.then(() => saveJson(`${config.result}.model`, value)).catch(() => {})
  }
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!belongs(exec.agent)) return
    if (exec.name !== 'run_code' && !modelTools(model).includes(exec.name)) {
      evidence.blocked.push(exec.name); void save(); return 'This check permits only the synthetic fixture and its browser tools.'
    }
    if (model.projectFile && PROJECT_FILE_TOOLS.includes(exec.name)) {
      const reason = guardMaterialProjectFile(model.projectScope, exec.arguments)
      if (reason) { evidence.blocked.push(exec.name); void save() }
      return reason
    }
    if (['layout', 'widgets'].includes(model.reportKind) && exec.name === 'browser_navigate' && !model.allowedUrls.includes(exec.arguments?.url)) {
      evidence.blocked.push(exec.name); void save(); return 'Navigation is limited to this check’s controlled fixture URLs.'
    }
    if (model.reportKind === 'wiki' && exec.name === 'browser_open_tab' && !model.allowedUrls?.includes(exec.arguments?.url)) {
      evidence.blocked.push(exec.name); void save(); return 'Opening is limited to this check’s synthetic document URL.'
    }
  }))
  ctx.on('agent/request', async (payload, next) => {
    if (belongs(payload.agent)) { if (++evidence.modelRequests > (model.reportKind === 'widgets' ? 20 : model.autoZoom === true || model.reportKind === 'wiki' ? 14 : 10)) throw new Error('synthetic-visual-model-budget'); await save() }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (belongs(exec.agent) && model.projectFile && PROJECT_FILE_TOOLS.includes(exec.name)) {
      evidence.projectFileCalls ??= []
      if (evidence.projectFileCalls.length >= 8) throw new Error('synthetic-project-file-budget')
      evidence.projectFileCalls.push(exec.name); await save()
    }
    if (belongs(exec.agent) && exec.name.startsWith('browser_')) {
      if (evidence.browserCalls.length >= (model.reportKind === 'widgets' ? 30 : 20)) throw new Error('synthetic-visual-browser-budget')
      evidence.browserCalls.push(exec.name); await save()
    }
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    if (!belongs(exec.agent)) return
    const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    if (model.projectFile && PROJECT_FILE_TOOLS.includes(exec.name) && result.isError) {
      evidence.projectFileErrors ??= []
      evidence.projectFileErrors.push({ name: exec.name, code: result.error?.info?.code, message: result.error?.message?.slice(0, 500) })
    }
    evidence.results.push({ name: exec.name, ok: !result.isError, imageBlocks: result.content?.filter(block => block.type === 'image').length ?? 0,
      // Optional private diagnostics for disposable synthetic fixtures, never real-site acceptance.
      ...(model.traceSynthetic === true ? { fixtureText: text.slice(0, 12000), tabId: exec.arguments?.tabId, requestedUrl: exec.arguments?.url } : {}),
      ...(['layout', 'wiki', 'widgets'].includes(model.reportKind) ? {} : { selectedLayerReported: text.includes(model.layer), exactColorReported: text.toLowerCase().includes(model.color.toLowerCase()) }) })
    void save()
  })
  ctx.on('session/event', (session, event) => {
    if (!belongs({ id: session.id })) return
    if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') {
      const message = event.data.message, text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      evidence.model = { provider: message.source.provider, model: message.source.model }
      if (model.reportKind === 'widgets') {
        evidence.finalWidgetReportCorrect = matchesWikiReport(text, model.expected)
      }
      else if (model.reportKind === 'wiki') {
        evidence.finalWikiReportCorrect = matchesWikiReport(text, model.expected)
        // All Wiki cases are synthetic; retain the actual report privately so
        // schema failures can be distinguished from material-role mistakes.
        writes = writes.then(() => writeFile(`${config.result}.final`, text.slice(0, 6000), { mode: 0o600 })).catch(() => {})
      }
      else if (model.reportKind === 'layout') evidence.finalLayoutReportCorrect = matchesLayoutReport(text)
      else {
        evidence.finalLayerReported = text.includes(model.layer); evidence.finalColorReported = text.toLowerCase().includes(model.color.toLowerCase())
        evidence.finalStyleReportCorrect = matchesLayerReport(text, model.expected)
        if (model.autoZoom === true) {
          evidence.finalZoom = reportedDesignZoom(text)
          evidence.finalManualZoomRequested = /放大|enlarge|zoom/i.test(text)
            && /请|手动|需要你|需要您|could you|please|manually|can you/i.test(text)
          // Synthetic-only diagnostic; retain privately if an assertion fails.
          writes = writes.then(() => writeFile(`${config.result}.final`, text.slice(0, 4000), { mode: 0o600 })).catch(() => {})
        }
      }
    }
    if (event.type === 'turn/end') { evidence.terminal = true; evidence.reason = event.data.reason.kind }
    void save()
  })
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void readFile(config.trigger, 'utf8').then(async text => {
        const command = JSON.parse(text)
        if (!Number.isSafeInteger(command.sequence) || command.sequence <= sequence) return
        sequence = command.sequence
        if (command.mode === 'model') {
          const agent = ctx.agents.get(command.sessionId)
          if (agent === undefined) throw new Error('Synthetic model probe agent unavailable')
          const projectScope = command.projectFile ? await materialProjectScope(command.projectFile) : undefined
          releaseModelTools?.()
          releaseModelTools = agent.ctx.tools.restrict({ allow: modelTools(command) })
          if (command.projectFile) {
            const visible = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
            if (!PROJECT_FILE_TOOLS.every(name => visible.has(name))) throw new Error('Synthetic project read/write/edit tools are unavailable')
            evidence.projectFileToolsAvailable = [...PROJECT_FILE_TOOLS]
          }
          model = { ...command, projectScope }; await save()
          await writeFile(config.result, JSON.stringify({ sequence, ok: true, modelReady: true }), { mode: 0o600 }); return
        }
        const agent = ctx.agents.get(command.sessionId)
        if (agent === undefined) throw new Error('Synthetic probe agent unavailable')
        if (!/^browser_[a-z_]+$/.test(command.name)) throw new Error('Synthetic probe requires a browser tool')
        if (agent.status === 'running' || belongs(agent)) throw new Error('Direct probe calls require a separate idle test Agent')
        // These are trusted preparatory calls outside an Agent turn. A PTC
        // transport would append nested-dispatch events without turn/step
        // boundaries and make the persisted test Session unreadable. Use a
        // local native presentation, keeping the real registry/guards and the
        // original Agent; restore its preset before any actual model turn.
        const restorePresentation = agent.ctx.tools.presentAs('native')
        let result
        try {
          result = await ctx.tools.execute({ callId: `visual-probe-${sequence}`, name: command.name,
            arguments: command.args ?? {}, agent, signal: controller.signal })
        } finally { restorePresentation() }
        const value = result.value
        const reply = { sequence, ok: !result.isError, code: result.error?.code,
          text: result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          screenshotRef: value?.screenshotRef, imageBlocks: result.content?.filter(block => block.type === 'image').length ?? 0 }
        if (!result.isError && value?.attachment !== undefined) {
          const image = await ctx.attachments.readImage(value.attachment)
          // Synthetic bytes stay only in the disposable test mailbox and are deleted afterwards.
          reply.image = { mediaType: image.ref.mediaType, width: image.ref.width, height: image.ref.height, data: Buffer.from(image.data).toString('base64') }
        }
        await writeFile(config.result, JSON.stringify(reply), { mode: 0o600 })
      }).catch(async () => {
        if (sequence >= 0) await writeFile(config.result, JSON.stringify({ sequence, ok: false, probeError: true }), { mode: 0o600 }).catch(() => {})
      }).finally(() => { pending = false })
    }, 50)
    return async () => { clearInterval(timer); controller.abort(); releaseModelTools?.(); await writes }
  })
}
