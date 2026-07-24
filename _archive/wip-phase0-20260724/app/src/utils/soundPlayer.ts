// ============================================
// Sound Player - 统一声音播放服务
// ============================================
//
// 职责：
// 1. 内置音效生成（Web Audio API，零资源文件）
// 2. 自定义音频播放（用户上传的音频 Blob）
// 3. 音量控制（统一映射到 0-100 滑条语义）
// 4. 试听 & 真实播放共用一套逻辑
//
// 音量语义：0 = 静音，50 = 正常基准，100 = 安全最大

import type { NotificationType } from '../store/notificationStore'

// ============================================
// 内置音效 ID
// ============================================

export const BUILTIN_SOUNDS = {
  // completed
  'builtin:chime': 'Chime',
  'builtin:success': 'Success',
  'builtin:bell': 'Bell',
  // permission
  'builtin:knock': 'Knock',
  'builtin:alert': 'Alert',
  'builtin:tap': 'Tap',
  // question
  'builtin:ping': 'Ping',
  'builtin:bubble': 'Bubble',
  'builtin:pop': 'Pop',
  // error
  'builtin:error': 'Error',
  'builtin:buzz': 'Buzz',
  'builtin:warning': 'Warning',
} as const

export type BuiltinSoundId = keyof typeof BUILTIN_SOUNDS

// 每类事件推荐的默认音效
export const DEFAULT_SOUNDS: Record<NotificationType, BuiltinSoundId> = {
  completed: 'builtin:chime',
  permission: 'builtin:knock',
  question: 'builtin:ping',
  error: 'builtin:error',
}

// 每类事件的推荐内置音效列表
export const SOUND_OPTIONS: Record<NotificationType, BuiltinSoundId[]> = {
  completed: ['builtin:chime', 'builtin:success', 'builtin:bell'],
  permission: ['builtin:knock', 'builtin:alert', 'builtin:tap'],
  question: ['builtin:ping', 'builtin:bubble', 'builtin:pop'],
  error: ['builtin:error', 'builtin:buzz', 'builtin:warning'],
}

// ============================================
// AudioContext 单例
// ============================================

let _audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (_audioCtx && _audioCtx.state !== 'closed') return _audioCtx
  try {
    _audioCtx = new (
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )()
    return _audioCtx
  } catch {
    return null
  }
}

/** 检查当前环境是否支持声音播放 */
export function isSoundSupported(): boolean {
  return (
    typeof AudioContext !== 'undefined' ||
    typeof (window as unknown as Record<string, unknown>).webkitAudioContext !== 'undefined'
  )
}

// ============================================
// 音量映射：UI 0-100 → 实际增益
// 50 = 正常基准 (gain=0.35)
// 100 = 安全最大 (gain=0.7)
// 0 = 静音
// ============================================

function volumeToGain(volume: number): number {
  if (volume <= 0) return 0
  if (volume >= 100) return 0.7
  if (volume <= 50) {
    // 0-50 线性映射到 0-0.35
    return (volume / 50) * 0.35
  }
  // 50-100 线性映射到 0.35-0.7
  return 0.35 + ((volume - 50) / 50) * 0.35
}

// ============================================
// 内置音效生成器（Web Audio API 合成）
// ============================================

type SynthFn = (ctx: AudioContext, dest: AudioNode) => void

const synthMap: Record<BuiltinSoundId, SynthFn> = {
  // ---- completed ----
  'builtin:chime': (ctx, dest) => {
    // 柔和的双音和弦
    const now = ctx.currentTime
    ;[523.25, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now)
      gain.gain.setValueAtTime(0, now + i * 0.05)
      gain.gain.linearRampToValueAtTime(1, now + i * 0.05 + 0.04)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5 + i * 0.05)
      osc.connect(gain).connect(dest)
      osc.start(now + i * 0.05)
      osc.stop(now + 0.6)
    })
  },

  'builtin:success': (ctx, dest) => {
    // 上升三音
    const now = ctx.currentTime
    ;[440, 554.37, 659.25].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + i * 0.1)
      gain.gain.setValueAtTime(0, now + i * 0.1)
      gain.gain.linearRampToValueAtTime(0.8, now + i * 0.1 + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.35)
      osc.connect(gain).connect(dest)
      osc.start(now + i * 0.1)
      osc.stop(now + i * 0.1 + 0.4)
    })
  },

  'builtin:bell': (ctx, dest) => {
    // 清脆铃声
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.02)
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08)
    gain.gain.setValueAtTime(0.9, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.65)
  },

  // ---- permission ----
  'builtin:knock': (ctx, dest) => {
    // 两下敲击
    const now = ctx.currentTime
    ;[0, 0.15].forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(200, now + offset)
      osc.frequency.exponentialRampToValueAtTime(80, now + offset + 0.1)
      gain.gain.setValueAtTime(0.8, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.15)
      osc.connect(gain).connect(dest)
      osc.start(now + offset)
      osc.stop(now + offset + 0.2)
    })
  },

  'builtin:alert': (ctx, dest) => {
    // 紧促双音提醒
    const now = ctx.currentTime
    ;[0, 0.12].forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.setValueAtTime(600, now + offset)
      gain.gain.setValueAtTime(0.3, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.1)
      osc.connect(gain).connect(dest)
      osc.start(now + offset)
      osc.stop(now + offset + 0.15)
    })
  },

  'builtin:tap': (ctx, dest) => {
    // 轻拍
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(350, now)
    osc.frequency.exponentialRampToValueAtTime(150, now + 0.06)
    gain.gain.setValueAtTime(0.7, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.15)
  },

  // ---- question ----
  'builtin:ping': (ctx, dest) => {
    // 清脆 ping
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1046.5, now)
    gain.gain.setValueAtTime(0.6, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.35)
  },

  'builtin:bubble': (ctx, dest) => {
    // 气泡上升音
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(400, now)
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.15)
    gain.gain.setValueAtTime(0.5, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.3)
  },

  'builtin:pop': (ctx, dest) => {
    // 短促 pop
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(800, now)
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.06)
    gain.gain.setValueAtTime(0.7, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.12)
  },

  // ---- error ----
  'builtin:error': (ctx, dest) => {
    // 下降双音错误
    const now = ctx.currentTime
    ;[0, 0.15].forEach((offset, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sawtooth'
      const freq = i === 0 ? 400 : 300
      osc.frequency.setValueAtTime(freq, now + offset)
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, now + offset + 0.15)
      gain.gain.setValueAtTime(0.25, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.2)
      osc.connect(gain).connect(dest)
      osc.start(now + offset)
      osc.stop(now + offset + 0.25)
    })
  },

  'builtin:buzz': (ctx, dest) => {
    // 嗡嗡震动
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(150, now)
    gain.gain.setValueAtTime(0.3, now)
    gain.gain.setValueAtTime(0.1, now + 0.05)
    gain.gain.setValueAtTime(0.3, now + 0.1)
    gain.gain.setValueAtTime(0.1, now + 0.15)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.35)
  },

  'builtin:warning': (ctx, dest) => {
    // 警告音（上下交替）
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(500, now)
    osc.frequency.setValueAtTime(400, now + 0.1)
    osc.frequency.setValueAtTime(500, now + 0.2)
    gain.gain.setValueAtTime(0.2, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
    osc.connect(gain).connect(dest)
    osc.start(now)
    osc.stop(now + 0.4)
  },
}

// ============================================
// 播放内置音效
// ============================================

function playBuiltinSound(soundId: BuiltinSoundId, volume: number): void {
  const ctx = getAudioContext()
  if (!ctx) return

  // 恢复挂起的 AudioContext（浏览器 autoplay 策略）
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }

  const masterGain = ctx.createGain()
  masterGain.gain.setValueAtTime(volumeToGain(volume), ctx.currentTime)
  masterGain.connect(ctx.destination)

  const synth = synthMap[soundId]
  if (synth) {
    synth(ctx, masterGain)
  }
}

// ============================================
// 播放自定义音频（Blob/URL）
// ============================================

async function playCustomSound(audioData: Blob | string, volume: number): Promise<void> {
  const ctx = getAudioContext()
  if (!ctx) return

  if (ctx.state === 'suspended') {
    await ctx.resume()
  }

  let arrayBuffer: ArrayBuffer

  if (typeof audioData === 'string') {
    // data URL 或 object URL
    const response = await fetch(audioData)
    arrayBuffer = await response.arrayBuffer()
  } else {
    arrayBuffer = await audioData.arrayBuffer()
  }

  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
  const source = ctx.createBufferSource()
  const gainNode = ctx.createGain()

  source.buffer = audioBuffer
  gainNode.gain.setValueAtTime(volumeToGain(volume), ctx.currentTime)
  source.connect(gainNode).connect(ctx.destination)
  source.start(0)
}

// ============================================
// 公共 API
// ============================================

export interface PlaySoundOptions {
  soundId: string // 'builtin:xxx' 或 'custom'
  customAudioData?: Blob | null
  volume: number // 0-100
}

/**
 * 播放提示音（内置或自定义）
 * 统一入口，试听和真实播放都走这里
 */
export function playSound(options: PlaySoundOptions): void {
  const { soundId, customAudioData, volume } = options

  if (volume <= 0) return
  if (!isSoundSupported()) return

  if (soundId === 'custom' && customAudioData) {
    playCustomSound(customAudioData, volume).catch(err => {
      if (import.meta.env.DEV) {
        console.warn('[SoundPlayer] Failed to play custom sound:', err)
      }
    })
  } else if (soundId.startsWith('builtin:')) {
    playBuiltinSound(soundId as BuiltinSoundId, volume)
  }
}
