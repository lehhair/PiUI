import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import {
  TrashIcon,
  WifiIcon,
  WifiOffIcon,
  SpinnerIcon,
  KeyIcon,
  PencilIcon,
  RetryIcon,
  ShareIcon,
  CopyIcon,
  CheckIcon,
} from '../../../components/Icons'
import { useServerStore, useRouter } from '../../../hooks'
import { clearSessionRuntimeState } from '../../../utils/sessionLifecycle'
import { settingsFieldClass, SettingsSection } from './SettingsUI'
import type { ServerConfig, ServerHealth } from '../../../store/serverStore'
import { parseConnectLink } from '../../../store/serverStore'
import { fetchHostShare } from '../../../pi/transport'
import type { ShareInfo } from '@piui/protocol'

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
/** 显示名长度上限，避免列表项把右侧操作按钮挤穿 */
const SERVER_NAME_MAX_LENGTH = 40

function isHttpsIpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    return parsed.protocol === 'https:' && (IPV4_PATTERN.test(hostname) || hostname.includes(':'))
  } catch {
    return false
  }
}

/** 从分享链接的 URL 推导一个默认显示名。 */
function hostNameOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ============================================
// Server Item
// ============================================

function ServerItem({
  server,
  health,
  isActive,
  onSelect,
  onDelete,
  onEdit,
  onCheckHealth,
}: {
  server: ServerConfig
  health: ServerHealth | null
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onEdit: (updates: { name: string; url: string; token?: string }) => void
  onCheckHealth: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showShare, setShowShare] = useState(false)

  const statusIcon = () => {
    if (!health || health.status === 'checking') return <SpinnerIcon size={12} className="animate-spin text-text-400" />
    if (health.status === 'online') return <WifiIcon size={12} className="text-success-100" />
    if (health.status === 'unauthorized') return <KeyIcon size={12} className="text-warning-100" />
    return <WifiOffIcon size={12} className="text-danger-100" />
  }

  const statusTitle = () => {
    if (!health) return t('servers.checkHealth')
    switch (health.status) {
      case 'checking':
        return t('servers.checking')
      case 'online':
        return `${t('servers.onlineLatency', { latency: health.latency })}${health.version ? ` · Pi v${health.version}` : ''}`
      case 'unauthorized':
        return t('servers.invalidCredentials')
      case 'offline':
        return health.error || t('common:offline')
      case 'error':
        return health.error || t('common:error')
      default:
        return t('common:unknown')
    }
  }

  if (editing) {
    return (
      <EditServerForm
        server={server}
        onSave={updates => {
          onEdit(updates)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <div
        onClick={onSelect}
        className={`group flex items-center gap-1.5 p-2.5 rounded-lg border transition-colors min-w-0
          ${
            isActive ? 'border-accent-main-100/40 bg-accent-main-100/5' : 'border-border-200/40 hover:border-border-300'
          }`}
      >
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            onSelect()
          }}
          aria-current={isActive ? 'true' : undefined}
          className="min-w-0 flex-1 overflow-hidden bg-transparent border-none p-0 text-left"
        >
          <div className="min-w-0">
            <div
              className="text-[length:var(--fs-md)] font-medium text-text-100 truncate"
              title={server.name}
            >
              {server.name}
            </div>
            <div className="text-[length:var(--fs-xs)] text-text-400 truncate font-mono flex items-center gap-1 mt-0.5 min-w-0">
              <span className="truncate min-w-0" title={server.url}>
                {server.url}
              </span>
              {server.token && <KeyIcon size={10} className="shrink-0 text-text-400" />}
            </div>
          </div>
        </button>
        <div className="shrink-0 flex items-center gap-0.5">
          {(server.isDefault || server.token) && (
            <button
              type="button"
              className="p-1.5 rounded-md text-text-400 hover:text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
              onClick={e => {
                e.stopPropagation()
                setShowShare(v => !v)
              }}
              title={t('servers.share')}
              aria-label={t('servers.share')}
            >
              <ShareIcon size={13} />
            </button>
          )}
          <button
            type="button"
            className="p-1.5 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
            onClick={e => {
              e.stopPropagation()
              onCheckHealth()
            }}
            title={statusTitle()}
            aria-label={statusTitle()}
          >
            {statusIcon()}
          </button>
          {!server.isDefault && (
            <>
              <button
                type="button"
                className="p-1.5 rounded-md text-text-400 hover:text-accent-main-100 hover:bg-accent-main-100/10 transition-colors"
                onClick={e => {
                  e.stopPropagation()
                  setEditing(true)
                }}
                title={t('servers.editServer')}
                aria-label={t('servers.editServer')}
              >
                <PencilIcon size={13} />
              </button>
              <button
                type="button"
                className="p-1.5 rounded-md text-text-400 hover:text-danger-100 hover:bg-danger-100/10 transition-colors"
                onClick={e => {
                  e.stopPropagation()
                  setConfirmDelete(true)
                }}
                title={t('common:remove')}
                aria-label={t('common:remove')}
              >
                <TrashIcon size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {showShare && <SharePanel server={server} />}

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          onDelete()
        }}
        title={t('servers.deleteServer')}
        description={t('servers.deleteServerConfirm', { name: server.name })}
        confirmText={t('common:delete')}
        cancelText={t('common:cancel')}
        variant="danger"
      />
    </>
  )
}

// ============================================
// Share Panel (local server)
// ============================================

function SharePanel({ server }: { server: ServerConfig }) {
  const { t } = useTranslation(['settings', 'common'])
  const [share, setShare] = useState<ShareInfo | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  // 拉取分享信息：请求-响应模式，同步状态需与请求一起设置
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false
    if (server.isDefault) {
      // 本地服务器向服务端要分享信息，它能分辨 loopback 与 LAN 绑定
      fetchHostShare()
        .then(info => {
          if (!cancelled) setShare(info)
        })
        .catch(err => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
    } else if (server.token) {
      // 远程服务器的链接在客户端本地拼出来即可
      const url = server.url.replace(/\/+$/, '')
      setShare({
        url,
        token: server.token,
        link: `piui://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(server.token)}`,
        lan: true,
      })
    }
    return () => {
      cancelled = true
    }
  }, [server])

  const copyLink = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(share.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时用户还可以手动选中复制
    }
  }

  return (
    <div className="mt-1.5 p-3 rounded-lg border border-border-200 bg-bg-100 space-y-2">
      <div className="text-[length:var(--fs-xs)] font-medium text-text-300">{t('servers.shareTitle')}</div>
      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      {!share && !error && <p className="text-[length:var(--fs-xs)] text-text-400">{t('servers.checking')}</p>}
      {share && (
        <>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              readOnly
              value={share.link}
              onFocus={e => e.target.select()}
              className={`${settingsFieldClass} font-mono flex-1`}
            />
            <button
              type="button"
              onClick={() => void copyLink()}
              className="shrink-0 p-2 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
              title={copied ? t('servers.shareCopied') : t('servers.shareCopy')}
              aria-label={copied ? t('servers.shareCopied') : t('servers.shareCopy')}
            >
              {copied ? <CheckIcon size={13} className="text-success-100" /> : <CopyIcon size={13} />}
            </button>
          </div>
          <p className="text-[length:var(--fs-xs)] text-text-400 leading-relaxed">
            {share.lan ? t('servers.shareLanHint') : t('servers.shareLoopbackHint')}
          </p>
        </>
      )}
    </div>
  )
}

// ============================================
// Edit Server Form (inline)
// ============================================

function EditServerForm({
  server,
  onSave,
  onCancel,
}: {
  server: ServerConfig
  onSave: (updates: { name: string; url: string; token?: string }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url)
  const [token, setToken] = useState(server.token || '')
  const [showAuth, setShowAuth] = useState(!!server.token)
  const [error, setError] = useState('')
  const showHttpsIpWarning = isHttpsIpUrl(url)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim().slice(0, SERVER_NAME_MAX_LENGTH)
    if (!trimmedName) {
      setError(t('servers.nameRequired'))
      return
    }
    if (!url.trim()) {
      setError(t('servers.urlRequired'))
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('servers.invalidUrl'))
      return
    }
    onSave({
      name: trimmedName,
      url: url.trim(),
      token: token.trim() || undefined,
    })
  }

  const inputCls = settingsFieldClass

  return (
    <form
      onSubmit={handleSubmit}
      className="p-3 rounded-lg border border-accent-main-100/30 bg-accent-main-100/[0.02] space-y-2.5"
    >
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.name')}</label>
        <input
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.namePlaceholder')}
          className={inputCls}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.url')}</label>
        <input
          type="text"
          value={url}
          onChange={e => {
            setUrl(e.target.value)
            setError('')
          }}
          placeholder={t('servers.urlPlaceholder')}
          className={`${inputCls} font-mono`}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAuth(!showAuth)}
        className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-accent-main-100 hover:text-accent-main-200 transition-colors"
      >
        <KeyIcon size={10} />
        {showAuth ? t('servers.hideAuth') : t('servers.addAuth')}
      </button>

      {showAuth && (
        <div>
          <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.token')}</label>
          <input
            type="password"
            value={token}
            onChange={e => {
              setToken(e.target.value)
              setError('')
            }}
            placeholder={t('servers.tokenPlaceholder')}
            className={`${inputCls} font-mono`}
          />
        </div>
      )}

      {showHttpsIpWarning && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button type="submit" size="sm">
          {t('common:save')}
        </Button>
      </div>
    </form>
  )
}

// ============================================
// Add Server Form
// ============================================

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, url: string, token?: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [showAuth, setShowAuth] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const connectLink = parseConnectLink(url)
    const trimmedName =
      name.trim().slice(0, SERVER_NAME_MAX_LENGTH) || (connectLink ? hostNameOf(connectLink.url) : '')
    if (!trimmedName) {
      setError(t('servers.nameRequired'))
      return
    }
    if (!url.trim()) {
      setError(t('servers.urlRequired'))
      return
    }
    if (connectLink) {
      onAdd(trimmedName, connectLink.url, connectLink.token)
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('servers.invalidUrl'))
      return
    }

    onAdd(trimmedName, url.trim(), token.trim() || undefined)
  }

  const showHttpsIpWarning = isHttpsIpUrl(url)

  const inputCls = settingsFieldClass

  return (
    <form onSubmit={handleSubmit} className="p-3 rounded-lg border border-border-200 bg-bg-100 space-y-2.5">
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.name')}</label>
        <input
          type="text"
          value={name}
          maxLength={SERVER_NAME_MAX_LENGTH}
          onChange={e => {
            setName(e.target.value.slice(0, SERVER_NAME_MAX_LENGTH))
            setError('')
          }}
          placeholder={t('servers.namePlaceholder')}
          className={inputCls}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.url')}</label>
        <input
          type="text"
          value={url}
          onChange={e => {
            setUrl(e.target.value)
            setError('')
          }}
          placeholder={t('servers.urlPlaceholder')}
          className={`${inputCls} font-mono`}
        />
        <p className="mt-1 text-[length:var(--fs-xxs)] text-text-400 leading-relaxed">{t('servers.urlShareHint')}</p>
      </div>

      <button
        type="button"
        onClick={() => setShowAuth(!showAuth)}
        className="flex items-center gap-1.5 text-[length:var(--fs-xs)] text-accent-main-100 hover:text-accent-main-200 transition-colors"
      >
        <KeyIcon size={10} />
        {showAuth ? t('servers.hideAuth') : t('servers.addAuth')}
      </button>

      {showAuth && (
        <>
          <div>
            <label className="block text-[length:var(--fs-xs)] font-medium text-text-300 mb-1">{t('servers.token')}</label>
            <input
              type="password"
              value={token}
              onChange={e => {
                setToken(e.target.value)
                setError('')
              }}
              placeholder={t('servers.tokenPlaceholder')}
              className={`${inputCls} font-mono`}
            />
          </div>

          <div className="text-[length:var(--fs-xs)] text-text-400 leading-relaxed">{t('servers.credentialsStorage')}</div>
        </>
      )}

      {showHttpsIpWarning && (
        <div className="text-[length:var(--fs-xs)] text-warning-100 bg-warning-bg border border-warning-100/20 rounded-md px-2.5 py-2 leading-relaxed">
          {t('servers.httpsIpWarning')}
        </div>
      )}

      {error && <p className="text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button type="submit" size="sm">
          {t('common:add')}
        </Button>
      </div>
    </form>
  )
}

// ============================================
// Tab: Servers
// ============================================

export function ServersSettings() {
  const { t } = useTranslation(['settings', 'common'])
  const [addingServer, setAddingServer] = useState(false)
  const {
    servers,
    activeServer,
    addServer,
    removeServer,
    updateServer,
    setActiveServer,
    checkHealth,
    checkAllHealth,
    getHealth,
  } = useServerStore()
  const { navigateHome, sessionId: routeSessionId } = useRouter()
  const orderedServers = useMemo(() => {
    if (!activeServer) return servers
    const active = servers.find(s => s.id === activeServer.id)
    if (!active) return servers
    return [active, ...servers.filter(s => s.id !== active.id)]
  }, [servers, activeServer])

  useEffect(() => {
    checkAllHealth()
  }, [checkAllHealth])

  // 切换服务器：设置 active + 清理当前 session + 导航回首页
  const handleSelectServer = useCallback(
    (id: string) => {
      if (activeServer?.id === id) return // 没变，不做事

      // 清理当前 session 的 store 状态
      if (routeSessionId) {
        clearSessionRuntimeState(routeSessionId)
      }

      setActiveServer(id) // 内部触发 serverChangeListeners → reconnectSSE()
      navigateHome()
      void checkHealth(id)
    },
    [activeServer?.id, checkHealth, routeSessionId, setActiveServer, navigateHome],
  )

  return (
    <SettingsSection
      title={t('servers.connections')}
      description={t('servers.connectionsDesc')}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={checkAllHealth}
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/70 transition-colors"
            title={t('common:refresh')}
            aria-label={t('common:refresh')}
          >
            <RetryIcon size={14} />
          </button>
          <button
            onClick={() => setAddingServer(true)}
            disabled={addingServer}
            className="h-7 px-2.5 rounded-md text-[length:var(--fs-sm)] font-medium text-accent-main-100 hover:bg-accent-main-100/10 transition-colors disabled:opacity-40"
          >
            {t('common:add')}
          </button>
        </div>
      }
    >
      <div className="space-y-1.5">
        {orderedServers.map(s => (
          <ServerItem
            key={s.id}
            server={s}
            health={getHealth(s.id)}
            isActive={activeServer?.id === s.id}
            onSelect={() => handleSelectServer(s.id)}
            onDelete={() => removeServer(s.id)}
            onEdit={updates => {
              updateServer(s.id, { name: updates.name, url: updates.url, token: updates.token })
              void checkHealth(s.id)
            }}
            onCheckHealth={() => void checkHealth(s.id)}
          />
        ))}

        {addingServer && (
          <AddServerForm
            onAdd={(n, u, token) => {
              const s = addServer({ name: n, url: u, token })
              setAddingServer(false)
              void checkHealth(s.id)
            }}
            onCancel={() => setAddingServer(false)}
          />
        )}

        {servers.length === 0 && !addingServer && (
          <div className="text-[length:var(--fs-md)] text-text-400 text-center py-8">{t('servers.noServersConfigured')}</div>
        )}
      </div>
    </SettingsSection>
  )
}
