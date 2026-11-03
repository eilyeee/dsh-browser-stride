/** Shared admission limits; pausing or selecting another page does not reset them. */
export const TASK_LIMITS = Object.freeze({ activeMs: 300_000, modelRequests: 10, toolCalls: 20 })

export function taskBudgetExhausted(task: { activeMs: number; modelRequests: number; toolCalls: number }): boolean {
  return task.activeMs >= TASK_LIMITS.activeMs || task.modelRequests >= TASK_LIMITS.modelRequests || task.toolCalls >= TASK_LIMITS.toolCalls
}
