/**
 * dsh-preview — eyes for a DeepSeek Harness agent. Registers headless-browser
 * verification tools (`browser_open`, `browser_screenshot`, `browser_console`,
 * `browser_read`, `browser_interact`, `browser_close`) so the agent can open
 * what it just built, see the result, and fix it without a human relaying
 * screenshots. Local files and directories are served over 127.0.0.1
 * automatically; remote hosts are opt-in via `allowedHosts`.
 * Named exports preserve loader injection metadata.
 * @module dsh-preview
 */

import { mkdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { BrowserManager, raceAbort, throwIfAborted } from './browser.js'
import { StaticServers } from './serve.js'

export const name = 'preview'
export const inject = ['tools']

/** Hosts reachable without any configuration; everything local stays allowed. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Computed-style properties reported by `browser_read` mode `styles`. */
const STYLE_PROPS = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'color',
  'background-color', 'font-size', 'font-family', 'overflow', 'z-index',
  'opacity', 'visibility', 'flex-direction', 'justify-content', 'align-items',
] as const

/** Deployment configuration; every tunable is a cordis.yml field. */
export interface Config {
  /** Run the browser without a visible window. */
  headless: boolean
  /** Browser channels tried in order until one launches. */
  browserChannels: string[]
  /** Viewport width in px for new pages. */
  viewportWidth: number
  /** Viewport height in px for new pages. */
  viewportHeight: number
  /** Navigation timeout for `browser_open`, in milliseconds. */
  navigationTimeoutMs: number
  /** Per-action timeout for `browser_interact`, in milliseconds. */
  actionTimeoutMs: number
  /** Directory screenshots are written to, resolved against the working directory. */
  screenshotDir: string
  /** Maximum characters returned by one `browser_read` call. */
  maxReadChars: number
  /** Maximum console messages retained per page. */
  maxConsoleMessages: number
  /** Extra hostnames `browser_open` may navigate to; local hosts are always allowed. */
  allowedHosts: string[]
  /** Register the bundled `frontend-verify` skill when the skill seam is composed. */
  registerSkill: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  headless: z.boolean().default(true),
  browserChannels: z.array(z.string()).default(['chrome', 'msedge', 'chromium']),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(800),
  navigationTimeoutMs: z.number().default(15000),
  actionTimeoutMs: z.number().default(5000),
  screenshotDir: z.string().default('.dsh-preview'),
  maxReadChars: z.number().default(20000),
  maxConsoleMessages: z.number().default(100),
  allowedHosts: z.array(z.string()).default([]),
  registerSkill: z.boolean().default(true),
})

/** Where a navigation target resolved to: a URL the browser can load. */
interface ResolvedTarget {
  /** Final http(s) URL. */
  url: string
  /** True when the target was a local path served by the plugin. */
  served: boolean
}

/**
 * Turn a model-supplied target (URL or local path) into a loadable URL,
 * enforcing the host policy for remote URLs and serving local paths.
 * @param target - http(s) URL, or a file/directory path.
 * @param allowedHosts - extra hostnames permitted beyond local hosts.
 * @param servers - static-server registry used for local paths.
 * @returns the resolved URL and whether it is plugin-served.
 */
async function resolveTarget(target: string, allowedHosts: string[], servers: StaticServers): Promise<ResolvedTarget> {
  if (/^https?:\/\//i.test(target)) {
    const url = new URL(target)
    const host = url.hostname
    if (!LOCAL_HOSTS.has(host) && !allowedHosts.includes(host)) {
      throw new Error(
        `host ${JSON.stringify(host)} is not allowed. Local hosts work out of the box; `
        + 'to open remote sites, ask the user to add the hostname to the dsh-preview '
        + '`allowedHosts` config.',
      )
    }
    return { url: url.href, served: false }
  }
  if (/^file:\/\//i.test(target)) {
    // file:// breaks CDN scripts and module imports; serve the directory instead.
    target = fileURLToPath(target)
  }
  const path = resolve(target)
  const info = await stat(path).catch(() => {
    throw new Error(`target ${JSON.stringify(target)} is neither a URL nor an existing file/directory`)
  })
  if (info.isDirectory()) {
    const base = await servers.serve(path)
    return { url: `${base}/`, served: true }
  }
  const base = await servers.serve(dirname(path))
  return { url: `${base}/${encodeURIComponent(basename(path))}`, served: true }
}

/**
 * Register the browser verification tools and (optionally) the bundled
 * `frontend-verify` skill.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const manager = new BrowserManager({
    channels: config.browserChannels,
    headless: config.headless,
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
    maxConsoleMessages: config.maxConsoleMessages,
  })
  const servers = new StaticServers()
  ctx.effect(() => async () => {
    servers.dispose()
    await manager.dispose()
  })

  if (config.registerSkill) {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.skills.registerProvider(() => frontendVerifyProvider)
    })
  }

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description:
      'Open a page in a headless browser to verify web work. Accepts an http(s) URL '
      + '(localhost always allowed) or a local file/directory path, which is served '
      + 'automatically over 127.0.0.1. Returns a pageId for the other browser_* tools '
      + 'plus any console errors raised during load. Use after building or changing '
      + 'anything a browser renders.',
    // Budget covers the designed worst case: browser launch plus both
    // navigation attempts (load, then the domcontentloaded fallback).
    timeoutMs: 2 * config.navigationTimeoutMs + 15000,
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'http(s) URL, or a file/directory path relative to the working directory.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          errors: {
            type: 'array',
            required: true,
            description: 'Console errors raised during load.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Opened ${value.url} as ${value.pageId} (title: ${JSON.stringify(value.title)}). `
          + (value.errors.length === 0 ? 'No console errors during load.' : `Console errors during load:\n${value.errors.join('\n')}`),
      }],
    },
    async execute(args, exec) {
      const resolved = await resolveTarget(args.target, config.allowedHosts, servers)
      const tracked = await manager.open(resolved.url, config.navigationTimeoutMs, exec.signal)
      const title = await tracked.page.title()
      return {
        pageId: tracked.id,
        url: resolved.url,
        title,
        errors: tracked.console.filter(entry => entry.level === 'error').map(entry => entry.text).slice(0, 10),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Preview ${args.target}`, kind: 'read', rawInput: args.target }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description:
      'Capture a PNG screenshot of an open page (whole viewport, full page, or one '
      + 'element) and save it under the screenshot directory. Returns the saved path. '
      + 'The image is for the human reviewing the session; combine with browser_read '
      + 'and browser_console for machine-checkable verification.',
    timeoutMs: config.actionTimeoutMs + 10000,
    parameters: {
      pageId: { type: 'string', description: 'Page to capture; defaults to the last opened page.' },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport.' },
      selector: { type: 'string', description: 'CSS selector; when set, capture just that element.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Saved PNG path.' },
          pageId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Screenshot of ${value.pageId} saved to ${value.path}` }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = manager.get(args.pageId)
      const dir = resolve(config.screenshotDir)
      await mkdir(dir, { recursive: true })
      const path = resolve(dir, `${tracked.id}-${Date.now()}.png`)
      if (args.selector) {
        await raceAbort(exec.signal, tracked.page.locator(args.selector).first().screenshot({ path, timeout: config.actionTimeoutMs }))
      } else {
        await raceAbort(exec.signal, tracked.page.screenshot({ path, fullPage: args.fullPage === true, timeout: config.actionTimeoutMs }))
      }
      return { path, pageId: tracked.id }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.selector ? `Screenshot ${args.selector}` : 'Screenshot page',
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_console',
    description:
      'Report the console messages and failed network requests captured on an open '
      + 'page since it loaded. Check this after browser_open and after every '
      + 'browser_interact: a healthy page has no errors and no failed requests.',
    timeoutMs: config.actionTimeoutMs + 5000,
    parameters: {
      pageId: { type: 'string', description: 'Page to inspect; defaults to the last opened page.' },
      errorsOnly: { type: 'boolean', description: 'Return only error-level messages.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          failedRequests: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0 && value.failedRequests.length === 0
          ? 'Console clean: no messages, no failed requests.'
          : `${value.messages.length} console message(s), ${value.failedRequests.length} failed request(s):\n`
            + value.messages.map(m => `[${m.level}] ${m.text}`).join('\n')
            + (value.failedRequests.length ? '\n' + value.failedRequests.map(f => `[request-failed] ${f.url} (${f.reason})`).join('\n') : ''),
      }],
    },
    execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = manager.get(args.pageId)
      const messages = (args.errorsOnly === true
        ? tracked.console.filter(entry => entry.level === 'error')
        : tracked.console
      ).map(entry => ({ level: entry.level, text: entry.text }))
      return Promise.resolve({
        messages,
        failedRequests: tracked.failures.map(f => ({ url: f.url, reason: f.reason })),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Read console', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_read',
    description:
      'Read an open page without vision: `text` returns the rendered text content, '
      + '`html` the outer HTML, `styles` the bounding box and key computed styles of '
      + 'the selected element. This is the primary way to verify structure and layout '
      + 'deterministically.',
    timeoutMs: config.actionTimeoutMs + 5000,
    parameters: {
      pageId: { type: 'string', description: 'Page to read; defaults to the last opened page.' },
      mode: {
        type: 'string',
        required: true,
        enum: ['text', 'html', 'styles'],
        description: 'text (rendered text) | html (outer HTML) | styles (box + computed styles, selector required).',
      },
      selector: { type: 'string', description: 'CSS selector; defaults to body for text/html.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.content + (value.truncated ? '\n[truncated]' : ''),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = manager.get(args.pageId)
      const selector = args.selector ?? 'body'
      let raw: string
      if (args.mode === 'styles') {
        if (!args.selector) throw new Error('mode `styles` requires a selector')
        raw = await raceAbort(exec.signal, tracked.page.locator(selector).first().evaluate((el, props) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const styles: Record<string, string> = {}
          for (const prop of props) styles[prop] = style.getPropertyValue(prop)
          return JSON.stringify({
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            styles,
          }, null, 1)
        }, [...STYLE_PROPS], { timeout: config.actionTimeoutMs }))
      } else if (args.mode === 'html') {
        raw = await raceAbort(exec.signal, tracked.page.locator(selector).first().evaluate(el => el.outerHTML, undefined, { timeout: config.actionTimeoutMs }))
      } else {
        raw = await raceAbort(exec.signal, tracked.page.locator(selector).first().innerText({ timeout: config.actionTimeoutMs }))
      }
      const truncated = raw.length > config.maxReadChars
      return {
        mode: args.mode,
        content: truncated ? raw.slice(0, config.maxReadChars) : raw,
        truncated,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read ${args.mode}${args.selector ? ` of ${args.selector}` : ''}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_interact',
    description:
      'Interact with an open page: click, type into, press a key on, or scroll to an '
      + 'element. Returns console errors raised by the interaction so regressions '
      + 'surface immediately.',
    timeoutMs: config.actionTimeoutMs + 10000,
    parameters: {
      pageId: { type: 'string', description: 'Page to act on; defaults to the last opened page.' },
      action: {
        type: 'string',
        required: true,
        enum: ['click', 'type', 'press', 'scrollTo'],
        description: 'click | type (fills text) | press (one key, e.g. Enter) | scrollTo (scroll element into view).',
      },
      selector: { type: 'string', required: true, description: 'CSS selector of the element to act on.' },
      text: { type: 'string', description: 'Text for `type`.' },
      key: { type: 'string', description: 'Key for `press`, e.g. Enter, Escape, ArrowDown.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          newErrors: {
            type: 'array',
            required: true,
            description: 'Console errors raised by this interaction.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.action} done. `
          + (value.newErrors.length === 0 ? 'No new console errors.' : `New console errors:\n${value.newErrors.join('\n')}`),
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const tracked = manager.get(args.pageId)
      // Seq-based diff: eviction of old entries cannot hide new errors.
      const seqBefore = tracked.lastSeq
      const locator = tracked.page.locator(args.selector).first()
      const timeout = config.actionTimeoutMs
      if (args.action === 'click') {
        await raceAbort(exec.signal, locator.click({ timeout }))
      } else if (args.action === 'type') {
        if (args.text === undefined) throw new Error('action `type` requires `text`')
        await raceAbort(exec.signal, locator.fill(args.text, { timeout }))
      } else if (args.action === 'press') {
        if (args.key === undefined) throw new Error('action `press` requires `key`')
        await raceAbort(exec.signal, locator.press(args.key, { timeout }))
      } else {
        await raceAbort(exec.signal, locator.scrollIntoViewIfNeeded({ timeout }))
      }
      // Give handlers a tick to run so their console errors are captured.
      await tracked.page.waitForTimeout(100)
      return {
        action: args.action,
        newErrors: tracked.console
          .filter(entry => entry.seq > seqBefore && entry.level === 'error')
          .map(entry => entry.text),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `${args.action} ${args.selector}`,
      kind: 'execute',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close an open page. Close pages when verification is finished to free resources.',
    timeoutMs: config.actionTimeoutMs + 5000,
    parameters: {
      pageId: { type: 'string', description: 'Page to close; defaults to the last opened page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'string', required: true, description: 'The closed pageId.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Closed ${value.closed}.` }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      const closed = await manager.close(args.pageId)
      return { closed }
    },
    presentCall: args => ({ card: 'generic', title: 'Close page', kind: 'other', rawInput: args }),
  }))
}

const SKILL_BODY_URL = new URL('../skills/frontend-verify/SKILL.md', import.meta.url)
const SKILL_RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/frontend-verify/', import.meta.url)),
} as const
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const
const SKILL_DESCRIPTION =
  'Verify web work with the browser_* tools after building or changing anything a '
  + 'browser renders: open the page, check the console, read the DOM, screenshot for '
  + 'the human, fix findings, and re-verify. Use before claiming frontend work is done.'

const SKILL_CANDIDATE: SkillCandidate = {
  name: 'frontend-verify',
  description: SKILL_DESCRIPTION,
  invocation: SKILL_INVOCATION,
  provider: 'dsh-preview',
  source: 'bundled',
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** Bundled skill provider serving the frontend-verify workflow. */
const frontendVerifyProvider: SkillProvider = {
  name: 'dsh-preview',
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(_candidate): Promise<SkillDefinition> {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}
