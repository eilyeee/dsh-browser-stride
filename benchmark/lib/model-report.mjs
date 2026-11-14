const MAX_REPORT_CHARS = 131_072
const MAX_CANDIDATES = 256

/** Read one marked top-level JSON object from prose; the result is untrusted data. */
export function parseMarkedModelReport(text, marker) {
  if (typeof text !== 'string' || text.length > MAX_REPORT_CHARS) throw new Error('Invalid or oversized model report')
  if (typeof marker !== 'string' || marker.length === 0 || marker.length > 128) throw new Error('Invalid report marker')
  const reports = []
  let candidates = 0
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue
    if (++candidates > MAX_CANDIDATES) throw new Error('Too many model report candidates')
    let depth = 0, quoted = false, escaped = false, end
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{' || char === '[') {
        if (++depth > 64) break
      } else if ((char === '}' || char === ']') && --depth === 0) { end = index + 1; break }
    }
    if (end === undefined) continue
    let value
    try { value = JSON.parse(text.slice(start, end)) } catch { continue }
    start = end - 1
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.hasOwn(value, 'marker') && value.marker === marker) reports.push(value)
  }
  if (reports.length !== 1) throw new Error(`Expected one marked model report, found ${reports.length}`)
  return reports[0]
}
