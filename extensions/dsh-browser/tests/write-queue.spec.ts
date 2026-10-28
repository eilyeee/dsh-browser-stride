// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { needsWriteTurn, WriteQueue } from '../src/background/write-queue.ts'

describe('single-browser write queue', () => {
  it('serializes writes and cancels a waiting action without releasing an in-flight write', async () => {
    const queue = new WriteQueue()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const thirdController = new AbortController()
    const calls: string[] = []
    let finish!: () => void
    const first = queue.run(firstController.signal, async () => {
      calls.push('first')
      await new Promise<void>(resolve => { finish = resolve })
      return 'done'
    })
    const secondWork = vi.fn(async () => { calls.push('second') })
    const second = queue.run(secondController.signal, secondWork)
    const third = queue.run(thirdController.signal, async () => { calls.push('third') })
    await vi.waitFor(() => { expect(calls).toEqual(['first']) })
    secondController.abort()
    await expect(second).rejects.toThrow('cancelled')
    expect(calls).toEqual(['first'])
    finish()
    await expect(first).resolves.toBe('done')
    await third
    expect(secondWork).not.toHaveBeenCalled()
    expect(calls).toEqual(['first', 'third'])
  })

  it('does not leave the queue blocked after a failure', async () => {
    const queue = new WriteQueue()
    const signal = new AbortController().signal
    const failed = queue.run(signal, async () => { throw new Error('failed') })
    const next = queue.run(signal, async () => 'next')
    await expect(failed).rejects.toThrow('failed')
    await expect(next).resolves.toBe('next')
    expect(needsWriteTurn('browser_snapshot')).toBe(false)
    expect(needsWriteTurn('browser_select')).toBe(true)
    expect(needsWriteTurn('unknown_future_tool')).toBe(true)
  })

  it('waits for started work to unwind after cancellation', async () => {
    const queue = new WriteQueue()
    const controller = new AbortController()
    let finish!: () => void
    const settled = vi.fn()
    const work = queue.run(controller.signal, async () => {
      await new Promise<void>(resolve => { finish = resolve })
    }).then(settled)
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    controller.abort()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    finish()
    await work
    expect(settled).toHaveBeenCalledOnce()
  })

  it('rejects new writes at capacity without starting them', async () => {
    const queue = new WriteQueue(2)
    const signal = new AbortController().signal
    let finish!: () => void
    const first = queue.run(signal, async () => { await new Promise<void>(resolve => { finish = resolve }) })
    const second = queue.run(signal, async () => {})
    const third = vi.fn(async () => {})
    await expect(queue.run(signal, third)).rejects.toThrow('queue is full')
    await vi.waitFor(() => { expect(finish).toBeTypeOf('function') })
    finish()
    await Promise.all([first, second])
    expect(third).not.toHaveBeenCalled()
    await queue.run(signal, third)
    expect(third).toHaveBeenCalledOnce()
  })
})
