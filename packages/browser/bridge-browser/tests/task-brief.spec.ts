import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskBriefStore, taskBriefInputSchema, progressInputSchema } from '../src/task-brief.ts'
import { taskBriefMessage, registerTaskBrief } from '../src/task-brief-runtime.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stride-brief-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root }); await ctx.plugin(StorageDomain, { backend: 'json' })
  const open = async () => { const store = await TaskBriefStore.open(ctx.storageDomain, 'test'); cleanups.push(() => store.close()); return store }
  return { store: await open(), open }
}
const input = { goal: 'Implement the synthetic form', projectPath: '/synthetic/project',
  materials: [{ url: 'https://example.com/wiki?pageId=12', label: 'Requirements', role: 'requirement' as const }],
  criteria: [{ id: 'form', text: 'Save the chosen option exactly once' }] }
const report = { criterionId: 'form', implementation: 'implemented', observation: 'observed', evidence: ['Synthetic readback: saved option B'], nextStep: '' }
describe('session task notes and reports', () => {
  it('persists context and provenance across reopening without changing a task verdict or workspace', async () => {
    const { store, open } = await setup()
    const saved = await store.save('s', 0, input, 'model')
    const reported = await store.report('s', saved.version, report)
    expect(reported.progress[0]).toMatchObject({ userConfirmed: false, observation: 'observed' })
    const reviewed = await store.review('s', reported.version, 'form', true)
    await store.close()
    expect((await open()).get('s')).toEqual(reviewed)
    const message = taskBriefMessage(reviewed)
    expect(message.content[0]).toMatchObject({ text: expect.stringContaining('do not change the actual session workspace') })
    expect(message.source.kind).toBe('stride-task-notes')
    expect(reviewed).not.toHaveProperty('outcome')
  })
  it('preserves user corrections and admits only one concurrent version', async () => {
    const { store } = await setup()
    const settled = await Promise.allSettled([store.save('s', 0, input, 'user'), store.save('s', 0, { ...input, goal: 'stale' }, 'user')])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    await expect(store.save('s', 1, input, 'model')).rejects.toMatchObject({ code: 'user-edited' })
    expect(store.get('s').goal).toBe(input.goal)
  })
  it('allows model role suggestions for unknown materials while preserving a user-selected role', async () => {
    const { store } = await setup()
    const material = input.materials[0]!
    let value = await store.save('s', 0, { ...input, materials: [{ ...material, role: 'unknown' }] }, 'user')
    value = await store.classify('s', value.version, { url: material.url, role: 'design' })
    expect(value.materials[0]).toMatchObject({ role: 'unknown', inferredRole: 'design' })
    value = await store.save('s', value.version, input, 'user')
    await expect(store.classify('s', value.version, { url: material.url, role: 'design' })).rejects.toMatchObject({ code: 'user-edited' })
    expect(store.get('s').materials[0]?.role).toBe('requirement')
  })
  it('requires evidence, prevents model confirmation and clears review when a report changes', async () => {
    const { store } = await setup()
    const saved = await store.save('s', 0, input, 'user')
    await expect(store.report('s', saved.version, { ...report, evidence: [] })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.report('s', saved.version, { ...report, userConfirmed: true })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(store.report('s', saved.version, { ...report, criterionId: 'unknown' })).rejects.toMatchObject({ code: 'bad-request' })
    const observed = await store.report('s', saved.version, report)
    const reviewed = await store.review('s', observed.version, 'form', true)
    const changed = await store.report('s', reviewed.version, { ...report, observation: 'uncertain', nextStep: 'Check saved state before another write' })
    expect(changed.progress[0]?.userConfirmed).toBe(false)
    await expect(store.review('s', changed.version, 'form', true)).rejects.toMatchObject({ code: 'bad-request' })
  })
  it('invalidates affected evidence on changed criteria or materials and purges session notes', async () => {
    const { store } = await setup()
    let value = await store.save('s', 0, input, 'model')
    value = await store.report('s', value.version, report)
    value = await store.save('s', value.version, { ...input, criteria: [{ id: 'form', text: 'A different requirement' }] }, 'user')
    expect(value.progress).toEqual([])
    await store.purge('s')
    expect(store.get('s').version).toBe(0)
  })
  it('rejects credential URLs, malformed roles, uncertain reports without a next step and cancelled writes', async () => {
    const { store } = await setup()
    for (const url of ['javascript:alert(1)', 'https://user:pass@example.com/', 'https://example.com/?token=synthetic']) {
      expect(taskBriefInputSchema.safeParse({ ...input, materials: [{ url, label: '', role: 'unknown' }] }).success).toBe(false)
    }
    expect(progressInputSchema.safeParse({ ...report, observation: 'uncertain' }).success).toBe(false)
    await expect(store.save('s', 0, input, 'user', AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.get('s').version).toBe(0)
  })
  it('scopes the model tool to its Agent and injects a fresh context after history restoration without waking work', async () => {
    const { store } = await setup()
    await store.save('s', 0, input, 'user')
    await store.save('other', 0, { ...input, goal: 'Other private goal' }, 'user')
    const registered: Array<{ execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }> = []
    let beforeStep!: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const ctx = { effect: (effect: () => unknown) => effect(),
      on: (_name: string, listener: typeof beforeStep) => { beforeStep = listener },
      tools: { register: (tool: typeof registered[number]) => { registered.push(tool); return () => {} } },
    } as unknown as Context
    registerTaskBrief(ctx, store)
    const exec = { agent: { id: 's' }, signal: new AbortController().signal }
    const result = await registered[0]!.execute({ action: 'read', sessionId: 'other' }, exec)
    expect(JSON.parse(result.text).goal).toBe(input.goal)
    await expect(registered[0]!.execute({ action: 'record', version: 1, json: JSON.stringify({ ...input, goal: 'Overwrite user' }) }, exec)).rejects.toMatchObject({ code: 'user-edited' })
    const enter = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await beforeStep({ agent: exec.agent, messages: [] }, enter) as { messages: Array<{ source: { kind: string } }> }
    expect(decision.messages[0]?.source.kind).toBe('stride-task-notes')
    expect((await beforeStep({ agent: exec.agent, messages: [] }, enter) as { messages: unknown[] }).messages).toEqual([])
    expect((await beforeStep({ agent: { id: 's' }, messages: [] }, enter) as { messages: unknown[] }).messages).toHaveLength(1)
  })
})
