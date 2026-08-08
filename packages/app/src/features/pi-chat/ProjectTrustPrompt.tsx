import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { getProjectTrust, setProjectTrust } from '../../pi/transport/index.js'
import type { PiProjectTrust } from '../../pi/domain'

/**
 * 首次打开项目时的信任确认：Pi 判定该工作区需要信任且用户尚未决定时，
 * 弹出对话框让用户选择允许 / 拒绝 / 暂不决定（结果写回 trust.set）。
 * 复用项目现有 Dialog/Button 与 i18n 双语键，风格与设置页一致。
 */
export function useProjectTrustPrompt(cwd: string | undefined) {
  const [pending, setPending] = useState(false)
  const [trust, setTrust] = useState<PiProjectTrust | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPending(false)
    setTrust(null)
    if (!cwd) return
    getProjectTrust(cwd)
      .then(next => {
        if (cancelled) return
        setTrust(next)
        // 需要信任、尚未决定、且默认不是 always → 询问
        if (next.required && next.decision === null && !next.trusted) {
          setPending(true)
        }
      })
      .catch(() => {
        // trust 查询失败不阻塞打开项目；用户仍可在设置页手动管理
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const decide = async (decision: boolean | null) => {
    if (!cwd) return
    setBusy(true)
    setError(null)
    try {
      const next = await setProjectTrust(cwd, decision)
      setTrust(next)
      setPending(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return { pending, busy, error, trust, decide }
}

export function ProjectTrustPrompt({ cwd }: { cwd: string | undefined }) {
  const { t } = useTranslation(['settings', 'common'])
  const { pending, busy, error, decide } = useProjectTrustPrompt(cwd)

  return (
    <Dialog isOpen={pending} onClose={() => void decide(null)} title={t('pi.trustPromptTitle')} width={440}>
      <div className="flex flex-col gap-4">
        <div className="text-[length:var(--fs-sm)] text-text-300 leading-relaxed">
          <p className="mb-2">{t('pi.trustPromptDesc', { directory: cwd ?? '' })}</p>
          <p className="text-text-500">{t('pi.trustPromptHint')}</p>
        </div>

        {error && <div className="text-[length:var(--fs-sm)] text-danger-100">{error}</div>}

        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(null)}>
            {t('pi.trustPromptLater')}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(false)}>
            {t('pi.denyAction')}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
            {t('pi.trustAction')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
