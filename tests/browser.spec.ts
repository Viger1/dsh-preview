import { describe, expect, it, vi } from 'vitest'
import { raceAbort, throwIfAborted } from '../src/browser.js'

describe('throwIfAborted', () => {
  it('passes a live signal through', () => {
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()
  })

  it('throws on an already-aborted signal', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => throwIfAborted(controller.signal)).toThrow(/cancelled before/)
  })
})

describe('raceAbort', () => {
  it('resolves with the work value', async () => {
    await expect(raceAbort(new AbortController().signal, Promise.resolve('done'))).resolves.toBe('done')
  })

  it('propagates the work failure', async () => {
    const failure = new Error('playwright timeout')
    await expect(raceAbort(new AbortController().signal, Promise.reject(failure))).rejects.toBe(failure)
  })

  it('normalizes a non-Error rejection', async () => {
    await expect(raceAbort(new AbortController().signal, Promise.reject('string reason')))
      .rejects.toThrow('string reason')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // Never settles: only the pre-check can end this call.
    await expect(raceAbort(controller.signal, new Promise(() => {}))).rejects.toThrow(/cancelled before/)
  })

  it('rejects as soon as the signal aborts, without waiting for the work', async () => {
    const controller = new AbortController()
    const raced = raceAbort(controller.signal, new Promise(() => {}))
    controller.abort()
    await expect(raced).rejects.toThrow(/cancelled by tool signal/)
  })

  it('keeps the first settlement when the signal aborts afterwards', async () => {
    const controller = new AbortController()
    const raced = raceAbort(controller.signal, Promise.resolve('first'))
    await expect(raced).resolves.toBe('first')
    // A late abort must not turn a delivered result into a rejection, nor
    // reject an already-settled promise.
    expect(() => controller.abort()).not.toThrow()
  })

  it('removes its abort listener once settled, so a long-lived signal does not accumulate them', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await raceAbort(controller.signal, Promise.resolve(1))
    await raceAbort(controller.signal, Promise.reject(new Error('x'))).catch(() => undefined)
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('does not leave an unhandled rejection when the work fails after an abort', async () => {
    const controller = new AbortController()
    let failWork: (err: Error) => void = () => {}
    const work = new Promise<never>((_resolve, reject) => { failWork = reject })
    const raced = raceAbort(controller.signal, work)
    controller.abort()
    await expect(raced).rejects.toThrow(/cancelled by tool signal/)
    failWork(new Error('page closed by the abort'))
    // The late failure is already attached to a handler inside raceAbort; give
    // the microtask queue a turn so an unhandled rejection would surface here.
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})
