/** Conservative parsing of readable inspector labels; no design-file metadata API. */
export const DESIGN_STYLE_KEYS = [
  'width', 'height', 'fill', 'color', 'borderRadius', 'borderWidth', 'borderColor',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'opacity',
] as const
export type DesignStyleKey = typeof DESIGN_STYLE_KEYS[number]
type Field = DesignStyleKey | 'layer'
export interface InspectorValue { value: string; evidence: string[] }
export interface DesignInspectorReport {
  source: 'untrusted-page-inspector-text'
  status: 'parsed' | 'partial' | 'unrecognized' | 'content-truncated'
  layer: InspectorValue | null
  properties: Partial<Record<DesignStyleKey, InspectorValue>>
  conflicts: Partial<Record<Field, InspectorValue[]>>
  unsupported: Field[]
  missing: DesignStyleKey[]
  warnings: string[]
}

const LABELS: Record<Field, readonly string[]> = {
  layer: ['layer', 'layer name', '图层', '图层名称'],
  width: ['width', '宽度'], height: ['height', '高度'],
  fill: ['fill', 'fill color', 'background-color', '填充', '填充色', '填充颜色', '背景色', '背景颜色'],
  color: ['color', 'text color', '颜色', '文字颜色', '文本颜色'],
  borderRadius: ['border-radius', 'border radius', 'radius', '圆角', '圆角半径'],
  borderWidth: ['border-width', 'border width', '边框宽度', '描边宽度'],
  borderColor: ['border-color', 'border color', '边框颜色', '描边颜色'],
  fontFamily: ['font-family', 'font family', '字体', '字体家族'],
  fontSize: ['font-size', 'font size', '字号'],
  fontWeight: ['font-weight', 'font weight', '字重'],
  lineHeight: ['line-height', 'line height', '行高'],
  letterSpacing: ['letter-spacing', 'letter spacing', '字间距'],
  opacity: ['opacity', '不透明度'],
}
const aliases = new Map(Object.entries(LABELS).flatMap(([key, labels]) => labels.map(label => [label, key as Field] as const)))
const cleanLabel = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')
const dimension = /^(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(px|pt|rem|em|rpx|dp|%)?$/i

function color(value: string): string | undefined {
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return value.toLowerCase()
  const match = /^(rgb|rgba)\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i.exec(value)
  if (match === null || (match[1]!.toLowerCase() === 'rgba') !== (match[5] !== undefined)
    || match.slice(2, 5).some(component => Number(component) > 255)) return
  return `${match[1]!.toLowerCase()}(${match.slice(2).filter(component => component !== undefined).map(Number).join(', ')})`
}

function normalize(field: Field, input: string): string | undefined {
  const value = field === 'layer' ? input.trim() : input.trim().replace(/;$/, '').trim()
  if (value.length === 0 || value.length > 160) return
  if (field === 'layer') return /[\u0000-\u001f<>]/.test(value) ? undefined : value
  if (field === 'fontFamily') return /^[\p{L}\p{M}\p{N} _.,'"-]+$/u.test(value) ? value : undefined
  if (field === 'fill' || field === 'color' || field === 'borderColor') return color(value)
  if (field === 'fontWeight') {
    if (/^(normal|bold)$/i.test(value)) return value.toLowerCase()
    return /^\d+(?:\.\d+)?$/.test(value) && Number(value) >= 1 && Number(value) <= 1000 ? String(Number(value)) : undefined
  }
  if ((field === 'lineHeight' || field === 'letterSpacing') && value.toLowerCase() === 'normal') return 'normal'
  const match = dimension.exec(value)
  if (match === null || !Number.isFinite(Number(match[1]))) return
  const number = Number(match[1]), unit = match[2]?.toLowerCase() ?? ''
  if (field === 'opacity') {
    if ((unit !== '' && unit !== '%') || number < 0 || number > (unit === '%' ? 100 : 1)) return
  } else if (field !== 'letterSpacing' && number < 0) return
  return `${number}${unit}`
}

/** Only whole, explicitly labelled lines or adjacent label/value lines count. */
export function parseDesignInspector(text: string): DesignInspectorReport {
  const report: DesignInspectorReport = {
    source: 'untrusted-page-inspector-text', status: 'unrecognized', layer: null,
    properties: {}, conflicts: {}, unsupported: [], missing: [...DESIGN_STYLE_KEYS],
    warnings: ['Only explicitly labelled values from page text are reported. These are page observations, not verified design metadata or task completion.',
      'Background and text must be selected and read separately. Missing units are not assumed to be pixels.'],
  }
  // A clipped suffix may hide another layer or a conflicting value. Fail closed
  // instead of presenting a seemingly complete report from a prefix.
  if (text.length > 16_000 || /\(Truncated \d+ characters\.\)|page content truncated to the secure boundary budget/i.test(text)) {
    report.status = 'content-truncated'
    report.warnings.push('Inspector text was truncated. Read a smaller inspector region before using its values.')
    return report
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const candidates = new Map<Field, InspectorValue[]>()
  const unsupported = new Set<Field>()
  const add = (field: Field, input: string, evidence: string) => {
    const value = normalize(field, input)
    if (value === undefined) { unsupported.add(field); return }
    const list = candidates.get(field) ?? []
    const previous = list.find(item => item.value === value)
    if (previous !== undefined) {
      if (previous.evidence.length < 3 && !previous.evidence.includes(evidence)) previous.evidence.push(evidence)
    } else if (list.length < 8) list.push({ value, evidence: [evidence] })
    candidates.set(field, list)
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const pair = /^([^:：]+)[:：]\s*(.+)$/.exec(line)
    const field = pair === null ? undefined : aliases.get(cleanLabel(pair[1]!))
    if (field !== undefined) {
      add(field, pair![2]!, line)
      continue
    }
    const label = aliases.get(cleanLabel(line.replace(/[:：]$/, '')))
    const next = lines[index + 1]
    if (label !== undefined) {
      if (next === undefined || aliases.has(cleanLabel(next.replace(/[:：].*$/, '')))) unsupported.add(label)
      else add(label, next, `${line}\n${next}`)
    }
  }
  report.unsupported = [...unsupported]
  for (const [field, values] of candidates) {
    if (values.length > 1) report.conflicts[field] = values
    else if (unsupported.has(field)) continue
    else if (field === 'layer') report.layer = values[0]!
    else report.properties[field] = values[0]!
  }
  const layerConflict = report.conflicts.layer !== undefined || (unsupported.has('layer') && candidates.has('layer'))
  if (layerConflict) {
    // Multiple layer identities cannot safely share one set of dimensions.
    report.properties = {}
    report.warnings.push('Multiple layer identities were found. Select one layer and read only its inspector.')
  }
  report.missing = DESIGN_STYLE_KEYS.filter(key => report.properties[key] === undefined)
  const found = Object.keys(report.properties).length > 0
  report.status = !found ? 'unrecognized' : report.layer === null || unsupported.size > 0 || Object.keys(report.conflicts).length > 0 ? 'partial' : 'parsed'
  if (report.layer === null && found) report.warnings.push('No unique layer name was read. Check the current selection before attributing these values to a layer.')
  if (Object.keys(report.conflicts).length > 0) report.warnings.push('Conflicting fields are withheld; do not choose one value by guesswork.')
  if (unsupported.size > 0) report.warnings.push('Unsupported labelled values are withheld, including fields with both a supported and unsupported value. Read a narrower region or inspect the snapshot.')
  return report
}
