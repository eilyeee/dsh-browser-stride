/** Bounded visual wire payloads. These values describe an observation, never authority. */
export const MAX_SCREENSHOT_BYTES = 4_000_000
export const MAX_SCREENSHOT_BASE64 = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3)
export interface VisualObservation {
  screenshotRef: string
  width: number
  height: number
  scrollX: number
  scrollY: number
  devicePixelRatio: number
}
export interface BrowserScreenshot extends VisualObservation {
  text: string
  mediaType: 'image/jpeg'
  data: string
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function isVisualObservation(value: unknown): value is VisualObservation {
  if (!record(value)) return false
  return typeof value.screenshotRef === 'string' && /^shot_[a-f0-9-]{36}$/.test(value.screenshotRef)
    && ['width', 'height'].every(key => typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 8192)
    && ['scrollX', 'scrollY'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
    && typeof value.devicePixelRatio === 'number' && Number.isFinite(value.devicePixelRatio) && value.devicePixelRatio > 0 && value.devicePixelRatio <= 8
}
export function isBrowserScreenshot(value: unknown): value is BrowserScreenshot {
  if (!isVisualObservation(value) || !record(value)) return false
  return typeof value.text === 'string' && value.text.length <= 2000 && value.mediaType === 'image/jpeg'
    && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= MAX_SCREENSHOT_BASE64
    && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(value.data) && value.data.length % 4 === 0
}
