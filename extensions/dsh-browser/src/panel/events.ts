/**
 * Pure conversation-rendering logic: maps session events (live and history)
 * to display rows. Kept framework-free so the wire shapes are unit-tested
 * against the REAL SessionEvent contract: `{ type, seq, time, data }` — the
 * payload always lives in `data`, never on the event root.
 *
 * @module
 */

import { getUiLocale, type UiLocale } from '../i18n.ts'
import { imageRefsFromBlocks, type ImageAttachmentRef } from './attachments.ts'
import { PANEL_COPY } from './strings.ts'

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info' | 'failure'
  text: string
  images?: ImageAttachmentRef[]
  status?: 'running' | 'complete' | 'unconfirmed'
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  seq?: number
  surfaceOp?: unknown
  data?: {
    content?: unknown
    source?: { kind?: string }
    message?: { content?: unknown; source?: { kind?: string } }
    turn?: number
    step?: number
    name?: string
    arguments?: string
    callId?: string
    title?: unknown
    reason?: unknown
  }
}

/** One user-selectable answer exposed by ask_user_question. */
export interface QuestionOption {
  label: string
  description?: string
}

/** One item in a question batch. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** Pending interaction belonging to one dsh session. */
export interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: QuestionItem[]
}

/** Identity carried by question/resolved; both fields must match before clearing UI. */
export interface ResolvedQuestion {
  rpcId: string
  sessionId: string
}

/** The gateway mux envelope shape carried inside a bridge event frame. */
export interface EventFrameView {
  rpcId: string
  method: string
  payload: unknown
}

export function pendingQuestionFromFrame(frame: EventFrameView): PendingQuestion | null {
  if (typeof frame.rpcId !== 'string' || frame.method !== 'question/requested' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rawQuestions = frame.payload.questions
  if (typeof sessionId !== 'string' || !Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: QuestionItem[] = []
  for (const value of rawQuestions) {
    const question = parseQuestionItem(value)
    if (question === null) return null
    questions.push(question)
  }
  return { rpcId: frame.rpcId, sessionId, questions }
}

export function resolvedQuestionFromFrame(frame: EventFrameView): ResolvedQuestion | null {
  if (frame.method !== 'question/resolved' || !isRecord(frame.payload)) return null
  const sessionId = frame.payload.sessionId
  const rpcId = frame.payload.questionRpcId
  return typeof sessionId === 'string' && typeof rpcId === 'string' ? { sessionId, rpcId } : null
}

function parseQuestionItem(value: unknown): QuestionItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') return null
  if (value.header !== undefined && typeof value.header !== 'string') return null
  if (value.detail !== undefined && typeof value.detail !== 'string') return null
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') return null
  let options: QuestionOption[] | undefined
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) return null
    options = []
    for (const rawOption of value.options) {
      if (!isRecord(rawOption) || typeof rawOption.label !== 'string') return null
      if (rawOption.description !== undefined && typeof rawOption.description !== 'string') return null
      options.push({
        label: rawOption.label,
        ...(rawOption.description === undefined ? {} : { description: rawOption.description }),
      })
    }
  }
  return {
    id: value.id,
    question: value.question,
    ...(value.header === undefined ? {} : { header: value.header }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(options === undefined ? {} : { options }),
    ...(value.multiSelect === undefined ? {} : { multiSelect: value.multiSelect }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract model-visible text from content blocks (defensive: unknown block shapes degrade to markers). */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map durable messages and failed turns to rows; tools are handled separately. */
export function rowFromEvent(event: SessionEventView, locale: UiLocale = getUiLocale()): Row | null {
  switch (event.type) {
    case 'user/message': {
      // dsh 每轮把运行时常量上下文作为 source.kind='plugin' 的 user/message
      // 记入日志（如 <system-reminder> 注入内容）——它们不是用户消息，
      // 渲染会污染对话流，必须跳过。
      const message = event.data?.message ?? event.data
      const source = message?.source
      if (source?.kind !== 'user') return null
      const blocks = message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'user', text, ...(images.length === 0 ? {} : { images }) }
    }
    case 'assistant/message': {
      // 工具调用也会产生 assistant/message，但其 content 可能只有 tool_use
      // 等非文本块。不要为这种中间事件渲染一个空的 AI 气泡。
      const blocks = event.data?.message?.content
      const text = textFromBlocks(blocks)
      const images = imageRefsFromBlocks(blocks)
      return text.trim() === '' && images.length === 0
        ? null
        : { seq: 0, kind: 'assistant', text, ...(images.length === 0 ? {} : { images }) }
    }
    case 'turn/end': {
      const reason = event.data?.reason
      if (!isRecord(reason) || reason.kind !== 'error') return null
      // Only use a structured status to choose fixed copy. Provider messages,
      // request IDs and other arbitrary diagnostics may contain private data.
      const rateLimited = isRecord(reason.error) && reason.error.status === 429
      return { seq: 0, kind: 'failure', text: PANEL_COPY[locale].turnFailure[rateLimited ? 'rateLimited' : 'generic'] }
    }
    default:
      return null
  }
}

/** 工具调用的友好展示名：从引用提取编号（如「点击元素 #7」）。 */
export function toolSummary(name: string, argsJson: unknown, locale: UiLocale = getUiLocale()): string {
  let summary = PANEL_COPY[locale].tool.labels[name] ?? name
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args === 'object' && args !== null) {
      const ref = (args as { elementRef?: unknown }).elementRef
      const match = typeof ref === 'string' ? /^obs_[a-f0-9-]+:(\d+)$/i.exec(ref) : null
      if (match !== null) summary += ` #${match[1]}`
      else if ('index' in args && typeof (args as { index?: unknown }).index === 'number') {
        summary += ` #${String((args as { index: number }).index)}`
      }
    }
  } catch {
    // 模型参数不可解析：只显示工具名。
  }
  return summary
}

/** live 合并：若最后一行是工具行则并入（连续工具调用不刷屏），否则新增一行。 */
export function appendLiveRow(
  rows: Row[],
  kind: Row['kind'],
  text: string,
  seq: number,
  images?: ImageAttachmentRef[],
): Row[] {
  if (kind === 'tool') {
    const last = rows[rows.length - 1]
    if (last?.kind === 'tool') {
      return [...rows.slice(0, -1), { seq, kind: 'tool', text: `${last.text} → ${text}`, status: 'running' }]
    }
    return [...rows, { seq, kind, text, status: 'running' }]
  }
  return [...rows, { seq, kind, text, ...(images === undefined || images.length === 0 ? {} : { images }) }]
}

/** 标记最后一行工具调用已完成（并入，不新增行）。 */
export function completeLastTool(rows: Row[], seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, status: 'complete' }]
  }
  return rows
}

/** A terminal turn stops presentation waits; it does not prove a tool result. */
export function settleToolRows(rows: Row[]): Row[] {
  return rows.map(row => row.kind === 'tool' && row.status === 'running'
    ? { ...row, status: 'unconfirmed' } : row)
}

/** 历史渲染：连续工具调用归并成一行（tool/call..result 不逐条刷屏；超 3 个折叠计数）。 */
export function mergeHistoryRows(
  events: SessionEventView[],
  nextSeq: () => number,
  locale: UiLocale = getUiLocale(),
): Row[] {
  // Results can arrive after metadata/messages have flushed a tool group.
  // Match native call identities across the entire authoritative history cut.
  const settledCalls = new Set(events.filter(event => event.type === 'tool/result')
    .map(event => event.data?.callId).filter((id): id is string => typeof id === 'string'))
  let rows: Row[] = []
  let pendingTool: { items: string[]; total: number; outstanding: number; anonymous: number } | null = null
  const flushTool = (): void => {
    if (pendingTool === null) return
    const shown = pendingTool.items.slice(0, 3)
    const label = pendingTool.total > shown.length
      ? PANEL_COPY[locale].tool.overflow(shown, pendingTool.total)
      : shown.join(' → ')
    rows.push({ seq: nextSeq(), kind: 'tool', text: label, status: pendingTool.outstanding > 0 ? 'running' : 'complete' })
    pendingTool = null
  }
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const summary = toolSummary(ev.data?.name ?? 'tool', ev.data?.arguments, locale)
      const callId = ev.data?.callId
      const anonymous = typeof callId !== 'string' ? 1 : 0
      const outstanding = typeof callId === 'string' && settledCalls.has(callId) ? 0 : 1
      if (pendingTool === null) pendingTool = { items: [summary], total: 1, outstanding, anonymous }
      else {
        pendingTool.items.push(summary)
        pendingTool.total += 1
        pendingTool.outstanding += outstanding
        pendingTool.anonymous += anonymous
      }
      continue
    }
    if (ev.type === 'tool/result') {
      // Legacy/test event views can omit callId. Such results can settle only
      // anonymous calls in their own group, never an identified pending call.
      if (typeof ev.data?.callId !== 'string' && pendingTool !== null && pendingTool.anonymous > 0) {
        pendingTool.anonymous -= 1
        pendingTool.outstanding -= 1
      }
      continue
    }
    flushTool()
    if (ev.type === 'turn/end') rows = settleToolRows(rows)
    const row = rowFromEvent(ev, locale)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  flushTool()
  return rows
}
