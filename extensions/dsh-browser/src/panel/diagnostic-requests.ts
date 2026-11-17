/** UI reply ordering only. Tickets grant no capture or browser authority. */
export interface DiagnosticReplyTicket { current(): boolean }
export interface DiagnosticActionTicket extends DiagnosticReplyTicket { finish(): boolean }

export class DiagnosticRequests {
  private revision = 0
  private action: number | undefined

  read(): DiagnosticReplyTicket | undefined {
    if (this.action !== undefined) return
    const revision = ++this.revision
    return Object.freeze({ current: () => this.revision === revision })
  }

  mutate(): DiagnosticActionTicket | undefined {
    if (this.action !== undefined) return
    const revision = ++this.revision
    this.action = revision
    const current = () => this.revision === revision
    return Object.freeze({ current, finish: () => {
      if (!current() || this.action !== revision) return false
      this.action = undefined
      return true
    } })
  }

  /** Scope/effect cleanup permanently retires all tickets already issued. */
  invalidate(): void { this.revision++; this.action = undefined }
}
