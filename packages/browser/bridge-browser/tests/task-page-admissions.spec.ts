import { describe, expect, it } from 'vitest'
import { TaskPageAdmissions } from '../src/task-page-admissions.ts'
import { taskPageUrl } from '../src/protocol.ts'
import type { BrowserRunRecord } from '../src/run-store.ts'
import { asRunId, asSessionId } from '../src/contracts/ids.ts'
import { newBrowserTask } from '../src/task-contract.ts'

function fixture(capacity = 5000) {
  let run = { runId: asRunId('run_synthetic'), sessionId: asSessionId('synthetic-session'), state: 'queued',
    version: 0, controlRevision: 0, recoveryRequired: false, task: newBrowserTask('Synthetic goal') } as BrowserRunRecord
  let now = 1000, next = 0
  const owner = {}
  const admissions = new TaskPageAdmissions(() => run, () => now, () => `start_synthetic_${++next}`, capacity)
  const input = { expectedVersion: 0, controlRevision: 0, url: 'https://synthetic.test/settings' }
  const reserve = () => admissions.reserve(run, input, owner)
  const consume = (ticket: ReturnType<typeof reserve>, identity = owner) => admissions.consume(run, { ...input, ...ticket }, identity)
  return { admissions, owner, input, reserve, consume, run: () => run,
    advance: () => { now += 45000 }, change: (patch: Partial<BrowserRunRecord>) => { run = { ...run, ...patch } } }
}
describe('native task page admissions', () => {
  it('pins URL, owner and exact task revision and consumes only once', () => {
    const h = fixture(), ticket = h.reserve()
    expect(h.admissions.available(h.run())).toBe(false)
    expect(() => h.reserve()).toThrow()
    expect(() => h.consume(ticket, {})).toThrow()
    expect(() => h.admissions.consume(h.run(), { ...h.input, ...ticket, launchUrl: 'https://foreign.test/' }, h.owner)).toThrow()
    expect(() => h.admissions.consume(h.run(), { ...h.input, ...ticket, expectedVersion: 1 }, h.owner)).toThrow()
    h.consume(ticket)
    expect(() => h.consume(ticket)).toThrow(expect.objectContaining({ mayHaveStarted: true }))
    expect(h.admissions.cancel(h.run().runId, h.run().sessionId, ticket.startTicket, h.owner)).toBe(false)
    h.advance()
    expect(h.admissions.available(h.run())).toBe(false)
    expect(() => h.admissions.assertUnreserved(h.run())).toThrow()
  })
  it('expires only unconsumed reservations and cancels only the original admission', () => {
    const h = fixture(), ticket = h.reserve()
    expect(h.admissions.cancel(h.run().runId, h.run().sessionId, ticket.startTicket, {})).toBe(false)
    h.advance()
    expect(() => h.consume(ticket)).toThrow()
    expect(h.admissions.available(h.run())).toBe(true)
    const next = h.reserve()
    expect(h.admissions.cancel(h.run().runId, h.run().sessionId, ticket.startTicket, h.owner)).toBe(false)
    expect(h.admissions.cancel(h.run().runId, h.run().sessionId, next.startTicket, h.owner)).toBe(true)
    expect(h.admissions.available(h.run())).toBe(true)
  })
  it('rejects stale/recovered tasks and bounds reservations without evicting uncertainty', () => {
    const h = fixture(), ticket = h.reserve()
    h.change({ version: 1 })
    expect(() => h.consume(ticket)).toThrow()
    expect(() => h.reserve()).toThrow()
    h.change({ recoveryRequired: true })
    expect(h.admissions.available(h.run())).toBe(false)
    expect(() => fixture(0).reserve()).toThrow()
  })
  it.each(['javascript:alert(1)', 'file:///tmp/test', 'https://user:password@synthetic.test', '/relative', 'https://synthetic.test/\npage', 'http://', ''])('rejects unsupported launch URL %j', value => {
    expect(taskPageUrl(value)).toBeUndefined()
  })
  it('normalizes only complete credential-free HTTP URLs', () => {
    expect(taskPageUrl('  https://SYNTHETIC.test  ')).toBe('https://synthetic.test/')
    expect(taskPageUrl(4)).toBeUndefined()
    expect(taskPageUrl(`https://synthetic.test/${'a'.repeat(8192)}`)).toBeUndefined()
  })
})
