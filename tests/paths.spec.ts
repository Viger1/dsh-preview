import { describe, expect, it } from 'vitest'
import { contentTypeFor, needsDirectoryRedirect, resolveRequest } from '../src/paths.js'

const ROOT = '/srv/site'

describe('resolveRequest', () => {
  it('resolves a normal file request under the root', () => {
    const result = resolveRequest(ROOT, '/css/style.css')
    expect(result).toEqual({ kind: 'file', path: '/srv/site/css/style.css', decodedPath: '/css/style.css' })
  })

  it('serves the root itself', () => {
    const result = resolveRequest(ROOT, '/')
    expect(result.kind).toBe('file')
    // A trailing separator is equivalent for stat(); only containment matters.
    expect(result.kind === 'file' && result.path.replace(/\/$/, '')).toBe(ROOT)
  })

  it('ignores the query string', () => {
    expect(resolveRequest(ROOT, '/app.js?v=123&x=1')).toMatchObject({ path: '/srv/site/app.js' })
  })

  it('refuses traversal out of the root', () => {
    for (const url of ['/../etc/passwd', '/a/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/./../secret']) {
      expect(resolveRequest(ROOT, url), url).toEqual({ kind: 'forbidden' })
    }
  })

  it('refuses a sibling directory sharing the root name as a prefix', () => {
    // /srv/site-backup must not pass a naive startsWith(root) check.
    expect(resolveRequest(ROOT, '/../site-backup/secret.txt')).toEqual({ kind: 'forbidden' })
  })

  it('answers bad-request for malformed percent-encoding instead of throwing', () => {
    for (const url of ['/%', '/%zz', '/a%E0%A4b']) {
      expect(resolveRequest(ROOT, url), url).toEqual({ kind: 'bad-request' })
    }
  })

  it('decodes percent-encoded names that stay inside the root', () => {
    expect(resolveRequest(ROOT, '/my%20file.html')).toMatchObject({ path: '/srv/site/my file.html' })
    expect(resolveRequest(ROOT, '/%E4%B8%AD%E6%96%87.html')).toMatchObject({ path: '/srv/site/中文.html' })
  })

  it('handles a root path that already ends with a separator', () => {
    expect(resolveRequest('/srv/site/', '/a.html')).toMatchObject({ kind: 'file', path: '/srv/site/a.html' })
    expect(resolveRequest('/srv/site/', '/../other/a.html')).toEqual({ kind: 'forbidden' })
  })
})

describe('contentTypeFor', () => {
  it('maps the types a preview page loads', () => {
    expect(contentTypeFor('/a/index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/a/app.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/a/style.CSS')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('/a/pic.PNG')).toBe('image/png')
  })

  it('falls back to a binary stream for unknown extensions', () => {
    expect(contentTypeFor('/a/data.bin')).toBe('application/octet-stream')
    expect(contentTypeFor('/a/LICENSE')).toBe('application/octet-stream')
  })
})

describe('needsDirectoryRedirect', () => {
  it('redirects a directory URL without a trailing slash', () => {
    expect(needsDirectoryRedirect('/docs')).toBe(true)
    expect(needsDirectoryRedirect('/docs/')).toBe(false)
    expect(needsDirectoryRedirect('/')).toBe(false)
  })
})
