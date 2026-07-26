import { timingSafeEqual } from "node:crypto"
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

/**
 * `token` is null only when a caller deliberately runs without authentication,
 * which is limited to tests. Callers that pass a token always require it: an
 * absent token used to mean "allow everyone", so simply not configuring one
 * left the API open to every local process.
 */
export function requestHasValidToken(req: IncomingMessage, token: string | null): boolean {
  if (token === null) return true
  const authorization = req.headers.authorization
  return typeof authorization === "string" && timingSafeTokenEquals(authorization, `Bearer ${token}`)
}

/** Compares without leaking length or position through timing. */
export function timingSafeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
