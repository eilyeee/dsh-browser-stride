import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { BrowserRunStore } from '../../src/run-store.ts'

/** Real storage services, always inside a disposable home. */
export async function createRunStorage() {
  const root = await mkdtemp(join(tmpdir(), 'stride-dispatch-test-'))
  const storageRoot = join(root, 'storage')
  const ctx = new Context()
  const stores: BrowserRunStore[] = []
  const open = async () => {
    const store = await BrowserRunStore.open(ctx.storageDomain, 'test')
    stores.push(store)
    return store
  }
  const close = async () => {
    try { for (const store of stores) await store.close() }
    finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  }
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const store = await open()
    return { root, storageRoot, ctx, store, open, close,
      dispatchFile: join(storageRoot, `browser_dispatches_${Buffer.from('test').toString('hex')}.json`) }
  } catch (error) { await close(); throw error }
}
