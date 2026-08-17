/**
 * Headless-browser session manager over playwright-core. One shared browser process,
 * lazily launched on first use; each opened page keeps its own console and
 * network-failure buffers so verification tools can report what happened since load.
 * @module dsh-preview/browser
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import { throwIfAborted, withCancellation, type CancellationScope } from './cancellation.js'

export { raceAbort, throwIfAborted, withCancellation } from './cancellation.js'

/** One captured console message. */
export interface ConsoleEntry {
  /** Monotonic capture id; survives buffer eviction, so diffs stay correct. */
  seq: number
  /** Console level as reported by the page (`log`, `warning`, `error`, ...). */
  level: string
  /** Message text. */
  text: string
}

/** One failed network request. */
export interface RequestFailure {
  /** Request URL. */
  url: string
  /** Failure reason reported by the browser (e.g. `net::ERR_CONNECTION_REFUSED`). */
  reason: string
}

/** A tracked page with its capture buffers. */
export interface TrackedPage {
  /** Stable id handed to the model (`page-1`, `page-2`, ...). */
  id: string
  /** The playwright page. */
  page: Page
  /** Console messages captured since navigation, newest last, capped by the manager. */
  console: ConsoleEntry[]
  /** Failed requests captured since navigation, capped by the manager. */
  failures: RequestFailure[]
  /** Seq of the most recently captured console entry; 0 before the first. */
  lastSeq: number
}

/** Launch/viewport options fixed per manager by plugin config. */
export interface BrowserManagerOptions {
  /** Preferred browser channels in order; each is tried until one launches. */
  channels: string[]
  /** Run without a visible window. */
  headless: boolean
  /** Default viewport width in px. */
  viewportWidth: number
  /** Default viewport height in px. */
  viewportHeight: number
  /** Maximum console messages retained per page. */
  maxConsoleMessages: number
}

/**
 * Owns the browser process and the page registry. Dispose closes everything;
 * the owning plugin registers that disposal as a Cordis effect so unload/HMR
 * never leaks a browser process.
 */
export class BrowserManager {
  private browser: Browser | undefined
  private contextPromise: Promise<BrowserContext> | undefined
  private pages = new Map<string, TrackedPage>()
  private counter = 0
  private lastId: string | undefined
  private disposed = false

  constructor(private options: BrowserManagerOptions) {}

  /**
   * Launch (or reuse) the browser and open a page at `url`. The page is
   * registered (and becomes the default page) only after navigation succeeds;
   * aborting `signal` closes the page, which interrupts the pending navigation.
   * @param url - absolute http(s) URL to navigate to.
   * @param timeoutMs - per-attempt navigation timeout in milliseconds.
   * @param signal - cooperative cancellation from the tool execution.
   * @returns the tracked page after `load` (or `domcontentloaded` fallback).
   */
  async open(url: string, timeoutMs: number, signal: AbortSignal): Promise<TrackedPage> {
    this.throwIfDisposed()
    throwIfAborted(signal)
    // Registered before the launch, not after the page exists: an abort fires
    // once, so a listener attached later never runs and the browser would keep
    // loading for the full navigation timeout. The handler closes whatever
    // page exists when the abort arrives.
    return withCancellation(signal, scope => this.openTracked(url, timeoutMs, signal, scope))
  }

  /**
   * Open and navigate one page, publishing it only after navigation succeeds.
   * @param url - absolute http(s) URL to navigate to.
   * @param timeoutMs - per-attempt navigation timeout in milliseconds.
   * @param signal - cooperative cancellation from the tool execution.
   * @param scope - cancellation scope; the page is registered with it as soon
   *   as it exists so an abort closes it.
   * @returns the tracked page.
   */
  private async openTracked(
    url: string,
    timeoutMs: number,
    signal: AbortSignal,
    scope: CancellationScope,
  ): Promise<TrackedPage> {
    const context = await this.ensureContext()
    this.throwIfDisposed()
    scope.throwIfCancelled()
    const page = await context.newPage()
    scope.closeOnAbort(page)
    scope.throwIfCancelled()
    this.throwIfDisposed()
    const id = `page-${++this.counter}`
    const tracked: TrackedPage = { id, page, console: [], failures: [], lastSeq: 0 }
    page.on('console', (msg) => this.capture(tracked, msg.type(), msg.text()))
    page.on('pageerror', (err) => this.capture(tracked, 'error', String(err)))
    page.on('requestfailed', (req) => {
      if (tracked.failures.length >= this.options.maxConsoleMessages) tracked.failures.shift()
      tracked.failures.push({ url: req.url(), reason: req.failure()?.errorText ?? 'unknown' })
    })
    // The caller's abort handler already owns closing this page, so navigation
    // needs no listener of its own.
    try {
      try {
        await page.goto(url, { timeout: timeoutMs, waitUntil: 'load' })
      } catch (err) {
        if (signal.aborted) throw err
        // `load` may hang on pages with long-polling resources; the DOM is still
        // usable after domcontentloaded, so retry once with the weaker milestone.
        // The failed attempt's captures are stale for the page we return.
        tracked.console.length = 0
        tracked.failures.length = 0
        await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' })
      }
    } catch (err) {
      await page.close().catch(() => { /* already closed by abort or crash; nothing left to release */ })
      throw signal.aborted ? new Error('cancelled while loading the page') : err
    }
    this.throwIfDisposed()
    this.pages.set(id, tracked)
    this.lastId = id
    return tracked
  }

  /**
   * Resolve a page by id, defaulting to the most recently opened one.
   * @param pageId - explicit id, or undefined for the last opened page.
   * @returns the tracked page.
   */
  get(pageId?: string): TrackedPage {
    const id = pageId ?? this.lastId
    if (!id) throw new Error('no page is open; call browser_open first')
    const tracked = this.pages.get(id)
    if (!tracked) {
      throw new Error(`unknown pageId ${JSON.stringify(id)}; open pages: ${[...this.pages.keys()].join(', ') || 'none'}`)
    }
    return tracked
  }

  /**
   * Close one page and forget it.
   * @param pageId - explicit id, or undefined for the last opened page.
   * @returns the id that was closed.
   */
  async close(pageId?: string): Promise<string> {
    const tracked = this.get(pageId)
    this.pages.delete(tracked.id)
    if (this.lastId === tracked.id) this.lastId = [...this.pages.keys()].pop()
    await tracked.page.close().catch(() => { /* already closed by the browser; state is what we wanted */ })
    return tracked.id
  }

  /**
   * Close every page and the browser process; safe to call twice and safe to
   * race an in-flight `open` (the launch is settled, then closed).
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.pages.clear()
    this.lastId = undefined
    const pending = this.contextPromise
    this.contextPromise = undefined
    if (pending) await pending.catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    if (browser) await browser.close().catch(() => { /* process already exited; disposal is complete either way */ })
  }

  private capture(tracked: TrackedPage, level: string, text: string): void {
    if (tracked.console.length >= this.options.maxConsoleMessages) tracked.console.shift()
    tracked.lastSeq += 1
    tracked.console.push({ seq: tracked.lastSeq, level, text })
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new Error('browser manager is disposed (plugin unloading)')
  }

  private ensureContext(): Promise<BrowserContext> {
    this.contextPromise ??= this.launchContext().catch((err: unknown) => {
      this.contextPromise = undefined
      throw err
    })
    return this.contextPromise
  }

  private async launchContext(): Promise<BrowserContext> {
    const errors: string[] = []
    let browser: Browser | undefined
    for (const channel of this.options.channels) {
      try {
        browser = await chromium.launch(
          channel === 'chromium' ? { headless: this.options.headless } : { headless: this.options.headless, channel },
        )
        break
      } catch (err) {
        errors.push(`${channel}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
      }
    }
    if (!browser) {
      throw new Error(
        'no launchable browser found. Tried channels: '
        + errors.join('; ')
        + '. Install Google Chrome or Microsoft Edge, or run `npx playwright install chromium` and set browserChannels to chromium.',
      )
    }
    if (this.disposed) {
      await browser.close().catch(() => { /* dispose raced the launch; close is best-effort */ })
      throw new Error('browser manager is disposed (plugin unloading)')
    }
    this.browser = browser
    return browser.newContext({
      viewport: { width: this.options.viewportWidth, height: this.options.viewportHeight },
    })
  }
}
