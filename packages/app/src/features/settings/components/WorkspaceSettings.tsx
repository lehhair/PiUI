import { useTranslation } from 'react-i18next'
import { useTheme } from '../../../hooks'
import { layoutStore, useLayoutStore } from '../../../store'
import { Toggle, SegmentedControl, SettingRow, SettingField, SettingsSection } from './SettingsUI'

export function WorkspaceSettings() {
  const { t } = useTranslation(['settings'])
  const {
    isWideMode,
    toggleWideMode,
    diffStyle,
    setDiffStyle,
    codeWordWrap,
    setCodeWordWrap,
  } = useTheme()
  const {
    sidebarFolderRecents,
    sidebarShowChildSessions,
    wakeLock,
  } = useLayoutStore()

  return (
    <div>
      <SettingsSection title={t('workspace.layout')} description={t('workspace.layoutDesc')}>
        <SettingRow label={t('appearance.wideMode')} description={t('appearance.wideModeDesc')} onClick={toggleWideMode}>
          <Toggle enabled={isWideMode} onChange={toggleWideMode} />
        </SettingRow>

        <SettingRow
          label={t('appearance.wakeLock')}
          description={t('appearance.wakeLockDesc')}
          onClick={() => layoutStore.setWakeLock(!wakeLock)}
        >
          <Toggle enabled={wakeLock} onChange={() => layoutStore.setWakeLock(!wakeLock)} />
        </SettingRow>

        <SettingRow
          label={t('appearance.codeWordWrap')}
          description={t('appearance.codeWordWrapDesc')}
          onClick={() => setCodeWordWrap(!codeWordWrap)}
        >
          <Toggle enabled={codeWordWrap} onChange={() => setCodeWordWrap(!codeWordWrap)} />
        </SettingRow>

        <SettingField label={t('appearance.diffStyle')} description={t('appearance.diffStyleDesc')}>
          <div className="w-full max-w-[300px]">
            <SegmentedControl
              value={diffStyle}
              options={[
                { value: 'markers', label: t('appearance.diffStyleMarkers') },
                { value: 'changeBars', label: t('appearance.diffStyleChangeBars') },
              ]}
              onChange={v => setDiffStyle(v as 'markers' | 'changeBars')}
            />
          </div>
        </SettingField>
      </SettingsSection>

      <SettingsSection title={t('workspace.sidebar')} description={t('workspace.sidebarDesc')}>
        <SettingRow
          label={t('appearance.folderStyleRecents')}
          description={t('appearance.folderStyleRecentsDesc')}
          onClick={() => layoutStore.setSidebarFolderRecents(!sidebarFolderRecents)}
        >
          <Toggle
            enabled={sidebarFolderRecents}
            onChange={() => layoutStore.setSidebarFolderRecents(!sidebarFolderRecents)}
          />
        </SettingRow>

        <SettingRow
          label={t('appearance.showChildSessions')}
          description={t('appearance.showChildSessionsDesc')}
          onClick={() => layoutStore.setSidebarShowChildSessions(!sidebarShowChildSessions)}
        >
          <Toggle
            enabled={sidebarShowChildSessions}
            onChange={() => layoutStore.setSidebarShowChildSessions(!sidebarShowChildSessions)}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  )
}
