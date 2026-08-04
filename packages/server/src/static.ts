import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, join, normalize, resolve, sep } from "node:path"
import type { IncomingMessage, ServerResponse } from "node:http"

/**
 * Static hosting for the web client — lets a browser (desktop or phone) hit
 * the server directly. API routes stay under /api; everything else falls back
 * to index.html so the SPA router keeps working on refresh.
 */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
}

function contentType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
}

/** Resolve a URL path inside root; returns undefined for traversal attempts. */
export function resolveStaticPath(root: string, urlPath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (decoded.includes("\0")) return undefined
  const absolute = resolve(root, `.${normalize(decoded)}`)
  const rootWithSep = resolve(root) + sep
  if (absolute !== resolve(root) && !absolute.startsWith(rootWithSep)) return undefined
  return absolute
}

export interface StaticServer {
  /** True when the request was handled (file or SPA fallback served). */
  serve(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean
}

export function createStaticServer(root: string): StaticServer | undefined {
  const indexHtml = join(root, "index.html")
  if (!existsSync(indexHtml)) return undefined

  const sendFile = (res: ServerResponse, path: string, headOnly: boolean, cache: boolean): boolean => {
    res.writeHead(200, {
      "content-type": contentType(path),
      "content-length": statSync(path).size,
      // 指纹资产随便缓存；index.html 必须每次重取，否则发新版用户看不到
      "cache-control": cache ? "public, max-age=31536000, immutable" : "no-cache",
    })
    if (headOnly) {
      res.end()
      return true
    }
    createReadStream(path).pipe(res)
    return true
  }

  return {
    serve(req, res, urlPath) {
      const headOnly = req.method === "HEAD"
      const resolved = resolveStaticPath(root, urlPath)
      if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
        const fingerprinted = /[.-][0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpg|svg|webp)$/.test(resolved)
        return sendFile(res, resolved, headOnly, fingerprinted)
      }
      // SPA fallback：客户端路由的路径都回 index.html
      if (!extname(urlPath)) {
        return sendFile(res, indexHtml, headOnly, false)
      }
      return false
    },
  }
}
