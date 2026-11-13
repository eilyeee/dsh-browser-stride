/** Session notes are context, never browser grants, working-directory changes or task verdicts. */
export const TASK_BRIEF_GET = 'bridge.taskBrief.get'
export const TASK_BRIEF_SAVE = 'bridge.taskBrief.save'
export const TASK_BRIEF_REVIEW = 'bridge.taskBrief.review'
export const TASK_BRIEF_OPEN = 'bridge.taskBrief.open'
export const MATERIAL_ROLES = ['unknown', 'requirement', 'design', 'api', 'reference'] as const
/** Shared with the panel so imported page metadata follows the storage URL rules. */
export function safeMaterialUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return value === value.trim() && !/[\u0000-\u0020\u007f]/.test(value)
      && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ![...url.searchParams.keys()].some(key => /^(?:token|access_token|api[_-]?key|password|authorization)$/i.test(key))
      && !/[?&#](?:token|access_token|api[_-]?key|password|authorization)=/i.test(url.hash)
  } catch { return false }
}
export interface TaskMaterial { url: string; label: string; role: typeof MATERIAL_ROLES[number]; inferredRole?: Exclude<typeof MATERIAL_ROLES[number], 'unknown'> | undefined }
export interface TaskCriterion { id: string; text: string }
export interface TaskBriefInput { goal: string; projectPath: string; materials: TaskMaterial[]; criteria: TaskCriterion[] }
export interface TaskProgress {
  criterionId: string
  implementation: 'pending' | 'implemented' | 'blocked'
  observation: 'unverified' | 'observed' | 'uncertain'
  evidence: string[]
  nextStep: string
  userConfirmed: boolean
}
export interface TaskBrief extends TaskBriefInput {
  sessionId: string; version: number; updatedAt: number; userEdited: boolean; progress: TaskProgress[]
}
