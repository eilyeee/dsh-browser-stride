// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

it('renders the bridge settings row with the extension React version', async () => {
  type RowProps = { t: (key: string) => string }
  type ClientModule = { apply: (ctx: unknown) => void }
  type Factory = (require: (name: string) => typeof React) => ClientModule
  let client: ClientModule | undefined
  let row: React.ComponentType<RowProps> | undefined
  const cleanups: Array<() => void> = []
  const fetchBridge = vi.fn(async () => ({
    ok: true,
    json: async () => ({ wsUrl: 'ws://127.0.0.1:1234/ext/bridge' }),
  }))
  const fakeWindow = {
    __ModuleLoader__: {
      load({ factory }: { factory: Factory }) {
        client = factory((name) => {
          if (name !== 'react') throw new Error(`Unexpected client dependency: ${name}`)
          return React
        })
      },
    },
    location: window.location,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  }
  const source = readFileSync(resolve(process.cwd(), '../../packages/browser/bridge-browser/src/client.js'), 'utf8')
  const execute = new Function('window', 'document', 'fetch', 'navigator', 'HTMLElement', source)
  execute(fakeWindow, document, fetchBridge, navigator, HTMLElement)
  expect(client).toBeDefined()

  client!.apply({
    effect(fn: () => unknown) {
      const result = fn()
      if (typeof result === 'function') cleanups.push(result as () => void)
    },
    locale: { register: () => () => {} },
    slots: {
      inject(_name: string, fn: () => unknown) { return fn() },
      register(_options: unknown, component: React.ComponentType<RowProps>) { row = component },
    },
  })
  expect(row).toBeDefined()

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    await React.act(async () => {
      root.render(React.createElement(row!, { t: (key: string) => key }))
    })
    expect(container.querySelector('code')?.textContent).toBe('ws://127.0.0.1:1234/ext/bridge')
    expect(fetchBridge).toHaveBeenCalledOnce()
  } finally {
    await React.act(async () => { root.unmount() })
    for (const cleanup of cleanups) cleanup()
    container.remove()
    vi.unstubAllGlobals()
  }
})
