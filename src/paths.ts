/**
 * Pure path and content-type decisions for the local static server, kept
 * separate so the rules that decide which files a page may read are
 * unit-testable without binding a socket.
 * @module dsh-preview/paths
 */

import { extname, join, normalize, sep } from 'node:path'

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

/** What the request line resolved to. */
export type Resolution =
  /** Serve this absolute path. */
  | { kind: 'file'; path: string; decodedPath: string }
  /** The URL could not be decoded; answer 400. */
  | { kind: 'bad-request' }
  /** The path escapes the served root; answer 403. */
  | { kind: 'forbidden' }

/**
 * Resolve one request URL against the served root, refusing anything that
 * escapes it. Percent-decoding happens here because a malformed sequence must
 * answer 400 rather than throw out of the request handler.
 * @param root - absolute directory being served.
 * @param requestUrl - the raw request target, query string included.
 * @returns the resolution to act on.
 */
export function resolveRequest(root: string, requestUrl: string): Resolution {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(requestUrl.split('?')[0])
  } catch {
    return { kind: 'bad-request' }
  }
  const path = normalize(join(root, decodedPath))
  const prefix = root.endsWith(sep) ? root : root + sep
  if (path !== root && !path.startsWith(prefix)) return { kind: 'forbidden' }
  return { kind: 'file', path, decodedPath }
}

/**
 * The content type to serve a file as.
 * @param path - the file path being served.
 * @returns a MIME type; unknown extensions fall back to a binary stream.
 */
export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Whether a directory request needs a trailing-slash redirect first. Without
 * one, the page's relative sub-resources resolve against the parent directory
 * and 404.
 * @param decodedPath - the decoded request path.
 * @returns true when the client should be redirected.
 */
export function needsDirectoryRedirect(decodedPath: string): boolean {
  return !decodedPath.endsWith('/')
}
