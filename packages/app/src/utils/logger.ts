/**
 * Dev-only logger utility.
 * - `logger.log` / `logger.debug` are silenced in production builds.
 * - `logger.warn` / `logger.error` always output (they indicate real issues).
 *
 * Vite will tree-shake the dev-only branches in production.
 */

const isDev = import.meta.env.DEV

const noop = (..._args: unknown[]) => {}

export const logger = {
  /** Dev-only informational log */
  log: isDev ? console.log.bind(console) : noop,
  /** Dev-only debug log */
  debug: isDev ? console.debug.bind(console) : noop,
  /** Always outputs — indicates a potential problem */
  warn: console.warn.bind(console),
  /** Always outputs — indicates a real error */
  error: console.error.bind(console),
}
