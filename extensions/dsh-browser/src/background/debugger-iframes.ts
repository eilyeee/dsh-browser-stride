/** Direct, origin-scoped Chrome child documents on one owned debugger attachment. */
import { httpOrigin } from '@eilyeee/dsh-browser-stride/src/iframe-scopes.ts'
import type { PageDispatch } from './debugger-pages.ts'
import type { TabFrame } from './frames.ts'
import { readWithin } from './native-wait.ts'

interface Frame {
  id: string
  parentId?: string
  loaderId: string
  url: string
  urlFragment?: string
  securityOrigin?: string
  unreachableUrl?: string
}
interface FrameTree { frame: Frame; childFrames?: FrameTree[] }
interface Context { id: string; frameId: string }
interface Evaluation { exceptionDetails?: unknown; result?: { value?: unknown } }
interface Document {
  key: string
  frameId: number
  documentId: string
  sessionId?: string
  context?: Context
  preparing?: Promise<Context>
}
type Command = <T>(sessionId: string | undefined, method: string, params?: object, dispatch?: PageDispatch) => Promise<T>

const WORLD = 'DSH Stride iframe controller'
const PREPARE_TIMEOUT_MS = 8000
const MAX_FRAMES = 32
// These ids are distinct from Chrome's native frame ids and a previous worker's ids.
let nextFrameId = 2 ** 32 + crypto.getRandomValues(new Uint32Array(1))[0]! * 2 ** 19

function committedOrigin(frame: Frame): string | undefined {
  const origin = httpOrigin(frame.url)
  return origin !== undefined && frame.securityOrigin === origin && !frame.unreachableUrl ? origin : undefined
}

function address(frame: Frame): string {
  return frame.url + (frame.urlFragment ?? '')
}

function frameKey(frame: Frame): string {
  return JSON.stringify([frame.id, frame.loaderId, address(frame), frame.securityOrigin])
}

const changed = () => new Error('The authorized iframe changed. Call browser_snapshot again.')

export class DebuggerIframes {
  private enabled?: Promise<void>
  private rootId?: string
  private targets = new Map<string, string>()
  private documents = new Map<string, Document>()
  private worlds = new Map<string | undefined, Map<number, Context>>()

  constructor(private readonly command: Command, private readonly source: () => Promise<string>) {}

  event(sessionId: string | undefined, method: string, params?: Record<string, unknown>): void {
    if (method === 'Target.attachedToTarget' && sessionId === undefined) {
      const target = params?.targetInfo as { targetId?: unknown; type?: unknown } | undefined
      if (target?.type === 'iframe' && typeof target.targetId === 'string' && typeof params?.sessionId === 'string'
        && this.targets.size < MAX_FRAMES) this.targets.set(params.sessionId, target.targetId)
    } else if (method === 'Target.detachedFromTarget' && sessionId === undefined && typeof params?.sessionId === 'string') {
      const frameId = this.targets.get(params.sessionId)
      this.targets.delete(params.sessionId)
      this.worlds.delete(params.sessionId)
      if (frameId !== undefined && this.documents.get(frameId)?.sessionId === params.sessionId) this.documents.delete(frameId)
    } else if (['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached'].includes(method)) {
      const id = method === 'Page.frameNavigated' ? (params?.frame as Frame | undefined)?.id : params?.frameId
      if (id === this.rootId && sessionId === undefined) this.documents.clear()
      else if (typeof id === 'string' && this.documents.get(id)?.sessionId === sessionId) this.documents.delete(id)
    } else {
      this.contextEvent(sessionId, method, params)
    }
  }

  private contextEvent(sessionId: string | undefined, method: string, params?: Record<string, unknown>): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = params?.context as { id?: number; uniqueId?: string; name?: string; auxData?: { frameId?: string; isDefault?: boolean } } | undefined
      const frameId = context?.auxData?.frameId
      if (context?.name !== WORLD || context.auxData?.isDefault !== false || typeof frameId !== 'string'
        || !Number.isSafeInteger(context.id) || typeof context.uniqueId !== 'string' || context.uniqueId === ''
        || (sessionId !== undefined && this.targets.get(sessionId) !== frameId)) return
      // Chrome can recreate a known isolated world as soon as a child commits,
      // before the next discovery registers that document. These are only
      // context identifiers. Dispatch still verifies the live document.
      const worlds = this.worlds.get(sessionId) ?? new Map<number, Context>()
      if (worlds.size >= MAX_FRAMES) worlds.clear()
      worlds.set(context.id!, { id: context.uniqueId, frameId })
      this.worlds.set(sessionId, worlds)
    } else if (method === 'Runtime.executionContextDestroyed') {
      if (typeof params?.executionContextId !== 'number') return
      const worlds = this.worlds.get(sessionId)
      const context = worlds?.get(params.executionContextId)
      if (context !== undefined && (params.executionContextUniqueId === undefined || params.executionContextUniqueId === context.id)) {
        worlds!.delete(params.executionContextId)
        const document = this.documents.get(context.frameId)
        if (document?.context?.id === context.id) this.documents.delete(context.frameId)
      }
    } else if (method === 'Runtime.executionContextsCleared') {
      this.worlds.delete(sessionId)
      for (const [id, document] of this.documents) if (document.sessionId === sessionId && document.context !== undefined) this.documents.delete(id)
    }
  }

  private async tree(sessionId?: string): Promise<FrameTree> {
    return (await this.command<{ frameTree: FrameTree }>(sessionId, 'Page.getFrameTree')).frameTree
  }

  async frames(parentUrl: string, childOrigins: ReadonlySet<string>, current: () => boolean, signal?: AbortSignal): Promise<TabFrame[]> {
    return readWithin(PREPARE_TIMEOUT_MS, async bounded => {
      const root = await this.tree()
      bounded.throwIfAborted()
      const parentOrigin = committedOrigin(root.frame)
      if (!current() || parentOrigin === undefined || address(root.frame) !== parentUrl) return []
      this.rootId = root.frame.id
      // Auto-attach covers out-of-process children. Same-process children
      // appear in the root tree. Keep the filter off workers and other tabs.
      this.enabled ??= (async () => {
        await this.command(undefined, 'Page.enable')
        await this.command(undefined, 'Target.setAutoAttach', {
          autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }],
        })
      })().catch(error => { this.enabled = undefined; throw error })
      await this.enabled
      bounded.throwIfAborted()
      if (!current()) return []
      const remote = await Promise.all([...this.targets].map(async ([sessionId, id]) => {
        const tree = await this.tree(sessionId).catch(() => undefined)
        return tree?.frame.id === id && this.targets.get(sessionId) === id ? { frame: tree.frame, sessionId } : undefined
      }))
      const live = await this.tree()
      bounded.throwIfAborted()
      if (!current() || frameKey(live.frame) !== frameKey(root.frame)) return []
      const candidates = [
        ...remote.filter(value => value !== undefined),
        ...(live.childFrames ?? []).slice(0, MAX_FRAMES).map(({ frame }) => ({ frame, sessionId: undefined })),
      ]
      const oldDocuments = this.documents
      this.documents = new Map()
      const frames: TabFrame[] = []
      for (const { frame, sessionId } of candidates) {
        const origin = committedOrigin(frame)
        if (frame.parentId !== root.frame.id || origin === undefined || !childOrigins.has(origin)
          || this.documents.has(frame.id) || frames.length >= MAX_FRAMES) continue
        const key = JSON.stringify([frameKey(root.frame), frameKey(frame), sessionId])
        const old = oldDocuments.get(frame.id)
        const document: Document = old?.key === key ? old : {
          key, sessionId, frameId: nextFrameId++, documentId: crypto.randomUUID(),
        }
        this.documents.set(frame.id, document)
        frames.push({
          frameId: document.frameId, parentFrameId: 0, documentId: document.documentId, url: origin,
          send: (message, dispatch) => this.send(root.frame, frame, document, parentOrigin, origin, message, {
            current: () => current() && dispatch?.current?.() !== false,
            commit: dispatch?.commit,
          }),
        })
      }
      return frames
    }, signal)
  }

  private async check(root: Frame, frame: Frame, document: Document, current: () => boolean): Promise<void> {
    const liveRoot = await this.tree()
    const liveFrame = document.sessionId === undefined
      ? liveRoot.childFrames?.find(child => child.frame.id === frame.id)?.frame
      : (await this.tree(document.sessionId)).frame
    if (!current() || this.documents.get(frame.id) !== document || frameKey(liveRoot.frame) !== frameKey(root)
      || liveFrame?.parentId !== root.id || frameKey(liveFrame) !== frameKey(frame)) throw changed()
  }

  private prepare(frame: Frame, document: Document, guard: string, current: () => boolean): Promise<Context> {
    if (document.context !== undefined) return Promise.resolve(document.context)
    document.preparing ??= (async () => {
      const source = await this.source()
      const session = document.sessionId
      if (!current()) throw changed()
      if (session !== undefined) await this.command(session, 'Page.enable')
      await this.command(session, 'Runtime.enable')
      if (!current()) throw changed()
      const world = await this.command<{ executionContextId: number }>(session, 'Page.createIsolatedWorld', {
        frameId: frame.id, worldName: WORLD, grantUniveralAccess: false,
      })
      // Chrome can reuse numeric context ids after a renderer changes.
      // Only the browser-issued unique id may receive the packaged controller.
      const deadline = Date.now() + 1000
      let context = this.worlds.get(session)?.get(world.executionContextId)
      while (context === undefined && current() && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
        context = this.worlds.get(session)?.get(world.executionContextId)
      }
      if (!current() || context?.frameId !== frame.id) throw changed()
      const installed = await this.command<Evaluation>(session, 'Runtime.evaluate', {
        uniqueContextId: context.id, returnByValue: true,
        expression: `(() => { if (!(${guard})) return false;\n${source}\nreturn true; })()`,
      }, { current })
      if (!current() || installed.exceptionDetails !== undefined || installed.result?.value !== true) throw changed()
      document.context = context
      return context
    })().finally(() => { document.preparing = undefined })
    return document.preparing
  }

  private async send(root: Frame, frame: Frame, document: Document, parentOrigin: string, origin: string, message: unknown, dispatch?: PageDispatch): Promise<unknown> {
    // Evaluate only in the verified document's isolated world. Repeat against
    // browser-owned state at delivery so a navigation cannot retarget input.
    const guard = `globalThis.origin === ${JSON.stringify(origin)} && location.href === ${JSON.stringify(address(frame))}
      && location.ancestorOrigins.length === 1 && location.ancestorOrigins[0] === ${JSON.stringify(parentOrigin)}`
    const current = () => this.documents.get(frame.id) === document && dispatch?.current?.() !== false
    const context = await readWithin(PREPARE_TIMEOUT_MS, async bounded => {
      const preparing = () => !bounded.aborted && current()
      await this.check(root, frame, document, preparing)
      const context = await this.prepare(frame, document, guard, preparing)
      await this.check(root, frame, document, preparing)
      return context
    })
    const response = await this.command<Evaluation>(document.sessionId, 'Runtime.evaluate', {
      uniqueContextId: context.id, awaitPromise: true, returnByValue: true,
      expression: `(${guard}) ? globalThis.__strideDebuggerAction(JSON.parse(${JSON.stringify(JSON.stringify(message))}), true) : null`,
    }, { current, commit: dispatch?.commit })
    if (response.exceptionDetails !== undefined || response.result?.value == null) throw changed()
    const answer = response.result.value as { result?: { navigationPending?: boolean } }
    if (answer.result?.navigationPending !== true) await readWithin(PREPARE_TIMEOUT_MS,
      bounded => this.check(root, frame, document, () => !bounded.aborted && current()))
    return answer
  }
}
