/** Session notes are context, never browser grants, working-directory changes or task verdicts. */
export const TASK_BRIEF_GET = 'bridge.taskBrief.get'
export const TASK_BRIEF_SAVE = 'bridge.taskBrief.save'
export const TASK_BRIEF_REVIEW = 'bridge.taskBrief.review'
export const MATERIAL_ROLES = ['unknown', 'requirement', 'design', 'api', 'reference'] as const
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
