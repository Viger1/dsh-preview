/**
 * Minimal static file server so the agent can preview local files and
 * directories over http (file:// breaks CDN scripts, module imports, and
 * fetch on most pages). One server per served root, bound to 127.0.0.1 on an
 * ephemeral port; the owning plugin disposes all servers on unload. Request
 * handling never throws out of the handler: malformed URLs answer 400,
 * missing files 404, escapes 403, and mid-stream read errors destroy the
 * response instead of crashing the process.
 * @module dsh-preview/serve
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** One bound server. */
interface Entry {
  server: Server
  port: number
}

/** Registry of running static servers, keyed by served root directory. */
export class StaticServers {
  private entries = new Map<string, Promise<Entry>>()
  private disposed = false

  /**
   * Serve `rootDir` on 127.0.0.1. Concurrent and repeated calls for the same
   * root share one server (the bind promise is memoized before awaiting).
   * @param rootDir - absolute directory to serve.
   * @returns the server's base URL, e.g. `http://127.0.0.1:52341`.
   */
  async serve(rootDir: string): Promise<string> {
    if (this.disposed) throw new Error('static servers are disposed (plugin unloading)')
    const root = resolve(rootDir)
    let pending = this.entries.get(root)
    if (!pending) {
      pending = this.bind(root)
      this.entries.set(root, pending)
      pending.catch(() => this.entries.delete(root))
    }
    const entry = await pending
    if (this.disposed) {
      entry.server.close()
      throw new Error('static servers are disposed (plugin unloading)')
    }
    return `http://127.0.0.1:${entry.port}`
  }

  /** Stop every server, including ones still binding. Safe to call twice. */
  dispose(): void {
    this.disposed = true
    for (const pending of this.entries.values()) {
      void pending.then(entry => entry.server.close()).catch(() => { /* bind already failed; nothing is listening */ })
    }
    this.entries.clear()
  }

  private async bind(root: string): Promise<Entry> {
    const server = createServer((req, res) => {
      handle(root, req, res).catch(() => {
        // Last-resort containment: the handler answered what it could; a
        // failure after headers can only be ended, never re-headed.
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    const port = await new Promise<number>((resolvePort, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address && typeof address === 'object') resolvePort(address.port)
        else reject(new Error('static server failed to bind'))
      })
    })
    return { server, port }
  }
}

/**
 * Answer one request from the served root.
 * @param root - absolute directory being served.
 * @param req - incoming request.
 * @param res - response to write.
 */
async function handle(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = (req.url ?? '/').split('?')[0]
  let rawPath: string
  try {
    rawPath = decodeURIComponent(rawUrl)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  const filePath = normalize(join(root, rawPath))
  const prefix = root.endsWith(sep) ? root : root + sep
  if (filePath !== root && !filePath.startsWith(prefix)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    let target = filePath
    let info = await stat(target)
    if (info.isDirectory()) {
      // Relative sub-resources only resolve under a trailing-slash URL.
      if (!rawPath.endsWith('/')) {
        res.writeHead(301, { location: encodeURI(rawPath) + '/' }).end()
        return
      }
      target = join(target, 'index.html')
      info = await stat(target)
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    })
    const stream = createReadStream(target)
    stream.on('error', () => {
      // File changed or vanished mid-read; the 200 header is already gone,
      // so the only safe end is destroying the response.
      res.destroy()
    })
    stream.pipe(res)
  } catch {
    res.writeHead(404).end('not found')
  }
}
