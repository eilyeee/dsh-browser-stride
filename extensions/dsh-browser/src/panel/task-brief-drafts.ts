import type { TaskBrief, TaskBriefInput } from '@eilyeee/dsh-browser-stride/src/task-brief-contract.ts'

export interface TaskBriefDraft { brief: TaskBrief; input: TaskBriefInput; criteriaText: string; token: object }
// Memory only, owned by this panel API lifetime. Separate Hosts and Sessions
// never reuse one another's edits, and no draft is automatically submitted.
const drafts = new WeakMap<object, Map<string, Map<string, TaskBriefDraft>>>()
export function readBriefDraft(api: object, host: string, sessionId: string): TaskBriefDraft | undefined {
  return drafts.get(api)?.get(host)?.get(sessionId)
}
export function writeBriefDraft(api: object, host: string, sessionId: string, draft: Omit<TaskBriefDraft, 'token'>): object {
  let hosts = drafts.get(api)
  if (!hosts) { hosts = new Map(); drafts.set(api, hosts) }
  let sessions = hosts.get(host)
  if (!sessions) { sessions = new Map(); hosts.set(host, sessions) }
  const token = {}
  sessions.set(sessionId, { ...structuredClone(draft), token })
  return token
}
export function clearBriefDraft(api: object, host: string, sessionId: string, token?: object): void {
  const sessions = drafts.get(api)?.get(host)
  if (token !== undefined && sessions?.get(sessionId)?.token !== token) return
  sessions?.delete(sessionId)
  if (sessions?.size === 0) drafts.get(api)?.delete(host)
}
export function clearBriefDrafts(api: object): void { drafts.delete(api) }
