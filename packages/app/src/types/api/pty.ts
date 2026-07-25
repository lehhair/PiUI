export interface PtySize { rows: number; cols: number }
export interface Pty {
  id: string
  title: string
  command: string
  args: string[]
  cwd: string
  status?: 'running' | 'exited'
  pid?: number
}
export interface PtyCreateParams { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }
export interface PtyUpdateParams { title?: string; size?: PtySize }
