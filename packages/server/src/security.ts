import type { IncomingMessage } from "node:http"

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i

export const MAX_JSON_BODY_BYTES = 1024 * 1024
export const MAX_PROMPT_BODY_BYTES = 24 * 1024 * 1024

/** Browser clients must originate from a local PiUI/Vite page. */
export function isAllowedLocalOrigin(origin: string | undefined): boolean {
  return origin === undefined || LOCAL_ORIGIN.test(origin)
}

export function requestHasAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return typeof origin !== "string" || isAllowedLocalOrigin(origin)
}

/** Optional for local development; mandatory whenever PIUI_AUTH_TOKEN is set. */
export function requestHasValidToken(req: IncomingMessage, token?: string): boolean {
  if (!token) return true
  const authorization = req.headers.authorization
  return authorization === `Bearer ${token}`
}
