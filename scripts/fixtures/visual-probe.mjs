// Disposable Host probe: real tool/attachment pipeline, optional bounded default-model check.
import { readFile, writeFile, rename } from 'node:fs/promises'
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
export const name = 'stride-visual-probe'
export const inject = ['tools', 'agents', 'attachments']
export const MODEL_BROWSER_TOOLS = ['browser_screenshot','browser_snapshot','browser_click_at','browser_get_text','browser_read_design_styles','browser_wait','browser_scroll']
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
    if (exec.name !== 'run_code' && !MODEL_BROWSER_TOOLS.includes(exec.name)) {
      evidence.blocked.push(exec.name); void save(); return 'This check permits only the synthetic canvas and browser tools.'
    }
  }))
  ctx.on('agent/request', async (payload, next) => {
    if (belongs(payload.agent)) { if (++evidence.modelRequests > 10) throw new Error('synthetic-visual-model-budget'); await save() }
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (belongs(exec.agent) && exec.name.startsWith('browser_')) {
      if (evidence.browserCalls.length >= 20) throw new Error('synthetic-visual-browser-budget')
      evidence.browserCalls.push(exec.name); await save()
    }
    return next()
  })
  ctx.on('tools/result', (exec, result) => {
    if (!belongs(exec.agent)) return
    const text = result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    evidence.results.push({ name: exec.name, ok: !result.isError, imageBlocks: result.content?.filter(block => block.type === 'image').length ?? 0,
      selectedLayerReported: text.includes(model.layer), exactColorReported: text.toLowerCase().includes(model.color.toLowerCase()) })
    void save()
  })
  ctx.on('session/event', (session, event) => {
    if (!belongs({ id: session.id })) return
    if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') {
      const message = event.data.message, text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      evidence.model = { provider: message.source.provider, model: message.source.model }
      evidence.finalLayerReported = text.includes(model.layer); evidence.finalColorReported = text.toLowerCase().includes(model.color.toLowerCase())
      evidence.finalStyleReportCorrect = matchesLayerReport(text, model.expected)
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
          releaseModelTools?.()
          releaseModelTools = agent.ctx.tools.restrict({ allow: MODEL_BROWSER_TOOLS })
          model = command; await save()
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
