/** Private content/background handoff, never forwarded to the Host or page world. */
export interface DesignZoomStep { ticket: string; before: number; percent: number }
export function isDesignZoomStep(value: unknown): value is DesignZoomStep {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.ticket === 'string' && /^zoom_[0-9a-f-]{36}$/u.test(v.ticket)
    && typeof v.before === 'number' && Number.isFinite(v.before) && v.before >= 0 && v.before <= 1_000_000
    && typeof v.percent === 'number' && Number.isFinite(v.percent) && v.percent >= 100 && v.percent <= 200
}
