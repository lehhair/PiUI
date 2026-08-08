import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { themeStore, type ToolCardStyle } from '../../../store/themeStore'
import { Toggle, SegmentedControl, SettingRow, SettingField, SettingsSection } from './SettingsUI'

export function AgentSettings() {
  const { t } = useTranslation(['settings'])
  const [queueFollowupMessages, setQueueFollowupMessages] = useState(themeStore.queueFollowupMessages)
  const [descriptiveToolSteps, setDescriptiveToolSteps] = useState(themeStore.descriptiveToolSteps)
  const [toolCardStyle, setToolCardStyle] = useState(themeStore.toolCardStyle)
  const [immersiveMode, setImmersiveMode] = useState(themeStore.immersiveMode)
  const [processCollapseEnabled, setProcessCollapseEnabled] = useState(themeStore.processCollapseEnabled)

  const handleImmersiveModeToggle = () => {
    const next = !immersiveMode
    setImmersiveMode(next)
    themeStore.setImmersiveMode(next)
    setDescriptiveToolSteps(next)
    setToolCardStyle(next ? 'compact' : 'classic')
  }

  const toggleQueueFollowup = () => {
    const next = !queueFollowupMessages
    setQueueFollowupMessages(next)
    themeStore.setQueueFollowupMessages(next)
  }

  const toggleDescriptiveToolSteps = () => {
    const next = !descriptiveToolSteps
    setDescriptiveToolSteps(next)
    themeStore.setDescriptiveToolSteps(next)
  }

  const toggleProcessCollapse = () => {
    const next = !processCollapseEnabled
    setProcessCollapseEnabled(next)
    themeStore.setProcessCollapseEnabled(next)
  }

  return (
    <div>
      <SettingsSection title={t('agent.behavior')} description={t('agent.behaviorDesc')}>
        <SettingRow
          label={t('chat.queueFollowupMessages')}
          description={t('chat.queueFollowupMessagesDesc')}
          onClick={toggleQueueFollowup}
        >
          <Toggle enabled={queueFollowupMessages} onChange={toggleQueueFollowup} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('agent.toolInteraction')} description={t('agent.toolInteractionDesc')}>
        <SettingRow
          label={t('chat.immersiveMode')}
          description={t('chat.immersiveModeDesc')}
          onClick={handleImmersiveModeToggle}
        >
          <Toggle enabled={immersiveMode} onChange={handleImmersiveModeToggle} />
        </SettingRow>

        <SettingRow
          label={t('chat.descriptiveToolSteps')}
          description={t('chat.descriptiveToolStepsDesc')}
          onClick={toggleDescriptiveToolSteps}
        >
          <Toggle enabled={descriptiveToolSteps} onChange={toggleDescriptiveToolSteps} />
        </SettingRow>

        <SettingRow
          label={t('chat.processCollapse')}
          description={t('chat.processCollapseDesc')}
          onClick={toggleProcessCollapse}
        >
          <Toggle enabled={processCollapseEnabled} onChange={toggleProcessCollapse} />
        </SettingRow>

        <SettingField label={t('chat.toolCardStyle')} description={t('chat.toolCardStyleDesc')}>
          <div className="w-full max-w-[280px]">
            <SegmentedControl
              value={toolCardStyle}
              options={[
                { value: 'classic', label: t('chat.toolCardClassic') },
                { value: 'compact', label: t('chat.toolCardCompact') },
              ]}
              onChange={v => {
                setToolCardStyle(v as ToolCardStyle)
                themeStore.setToolCardStyle(v as ToolCardStyle)
              }}
            />
          </div>
        </SettingField>
      </SettingsSection>
    </div>
  )
}
