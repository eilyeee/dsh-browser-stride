/** Host-owned pairs of exact origins for direct iframe access. */
export interface IframeScope {
  parentOrigin: string
  childOrigin: string
}

export const MAX_IFRAME_SCOPES = 16

export function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch { /* Invalid URLs have no matching origin. */ }
}

export function isExactHttpOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && origin.length <= 253 && !origin.includes('*') && httpOrigin(origin) === origin
}

export function isIframeScopes(value: unknown): value is IframeScope[] {
  return Array.isArray(value) && value.length <= MAX_IFRAME_SCOPES && value.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false
    const { parentOrigin, childOrigin } = entry as Partial<IframeScope>
    return isExactHttpOrigin(parentOrigin) && isExactHttpOrigin(childOrigin) && parentOrigin !== childOrigin
  })
}

export function allowsIframeOrigin(scopes: readonly IframeScope[] | undefined, parentUrl: string, childOrigin: string): boolean {
  const parentOrigin = httpOrigin(parentUrl)
  return scopes?.some(scope => scope.parentOrigin === parentOrigin && scope.childOrigin === childOrigin) === true
}
