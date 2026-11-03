import { z } from 'zod'

export { TASK_LIMITS } from './task-budget.ts'
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const taskSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4096),
  activeMs: count, modelRequests: count, toolCalls: count,
  outcome: z.enum(['pending', 'verified', 'needs-review', 'not-completed', 'budget-exhausted']),
})
export type BrowserTask = z.infer<typeof taskSchema>
export function newBrowserTask(goal: string): BrowserTask {
  return taskSchema.parse({ goal, activeMs: 0, modelRequests: 0, toolCalls: 0, outcome: 'pending' })
}
