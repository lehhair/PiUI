// ============================================
// PTY API - 终端管理
// ============================================

import { UnsupportedPiCapabilityError } from './errors'
import type { Pty, PtyCreateParams, PtyUpdateParams } from '../types/api/pty'

export interface ShellInfo {
  path: string
  name: string
  acceptable: boolean
}

interface PtyConnectUrlOptions {
  /**
   * false = 不在 URL 里放认证（Tauri bridge 通过 header 传）
   * true  = 在 URL 里放认证（浏览器原生 WebSocket 无法设 header）
   */
  includeAuthInUrl?: boolean
  cursor?: number
}

/**
 * 获取所有 PTY 会话列表
 */
export async function listPtySessions(_directory?: string): Promise<Pty[]> {
  return []
}

export async function listAvailableShells(_directory?: string): Promise<ShellInfo[]> {
  return []
}

/**
 * 创建新的 PTY 会话
 */
export async function createPtySession(_params: PtyCreateParams, _directory?: string): Promise<Pty> {
  throw new UnsupportedPiCapabilityError('PTY sessions')
}

/**
 * 获取单个 PTY 会话信息
 */
export async function getPtySession(_ptyId: string, _directory?: string): Promise<Pty> {
  throw new UnsupportedPiCapabilityError('PTY sessions')
}

/**
 * 更新 PTY 会话
 */
export async function updatePtySession(_ptyId: string, _params: PtyUpdateParams, _directory?: string): Promise<Pty> {
  throw new UnsupportedPiCapabilityError('PTY sessions')
}

/**
 * 删除 PTY 会话
 */
export async function removePtySession(_ptyId: string, _directory?: string): Promise<boolean> {
  throw new UnsupportedPiCapabilityError('PTY sessions')
}

export function getPtyConnectUrl(
  _ptyId: string,
  _directory?: string,
  _options?: PtyConnectUrlOptions,
): string {
  throw new UnsupportedPiCapabilityError('PTY sessions')
}
