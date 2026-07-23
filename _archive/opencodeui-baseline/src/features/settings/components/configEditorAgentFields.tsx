import { BoolField, KeyValueField, NumberField, PositiveIntegerField, Select, TextArea, TextField } from './configEditorControls'
import type { FieldDef } from './configEditorFields'
import { PermissionEditor, ToolToggleMap } from './configEditorPermissions'
import { enumChoices } from './configEditorSectionTypes'
import type { Choice, JsonRecord, Lang } from './configEditorTypes'
import { previewValue, tx } from './configEditorUtils'

export function buildAgentConfigFields({
  value,
  setField,
  lang,
  models,
}: {
  value: JsonRecord
  setField: (key: string, value: unknown) => void
  lang: Lang
  models: Choice[]
}): FieldDef[] {
  return [
    { key: 'description', label: 'description', desc: tx('Description of when to use the agent.', '何时使用该 agent 的说明。', lang), control: <TextField value={value.description} onChange={v => setField('description', v)} /> },
    { key: 'mode', label: 'mode', desc: tx("Agent mode: 'primary', 'subagent' or 'all'.", "agent 模式：primary、subagent 或 all。", lang), control: <Select value={value.mode} options={enumChoices(['primary', 'subagent', 'all'])} onChange={v => setField('mode', v)} /> },
    { key: 'model', label: 'model', desc: tx('Model used by this agent.', '该 agent 使用的模型。', lang), control: <Select editable value={value.model} options={models} onChange={v => setField('model', v)} /> },
    { key: 'variant', label: 'variant', desc: tx("Default model variant (only with the agent's configured model).", '默认模型 variant（仅对该 agent 配置的模型生效）。', lang), control: <TextField value={value.variant} onChange={v => setField('variant', v)} /> },
    { key: 'prompt', label: 'prompt', block: true, desc: tx('System prompt override for this agent.', '该 agent 的系统提示词覆盖。', lang), control: <TextArea value={value.prompt} onChange={v => setField('prompt', v)} /> },
    { key: 'temperature', label: 'temperature', desc: tx('Sampling temperature.', '采样温度。', lang), control: <NumberField value={value.temperature} onChange={v => setField('temperature', v)} /> },
    { key: 'top_p', label: 'top_p', desc: tx('Nucleus sampling top_p.', 'top_p 核采样。', lang), control: <NumberField value={value.top_p} onChange={v => setField('top_p', v)} /> },
    { key: 'steps', label: 'steps', desc: tx('Max agentic iterations before forcing a text-only response.', '强制结束前的最大迭代步数。', lang), control: <PositiveIntegerField value={value.steps} onChange={v => setField('steps', v)} /> },
    { key: 'maxSteps', label: 'maxSteps', badge: tx('deprecated', '已废弃', lang), desc: tx("Deprecated. Use 'steps' instead.", "已废弃，请改用 'steps'。", lang), control: <PositiveIntegerField value={value.maxSteps} onChange={v => setField('maxSteps', v)} /> },
    { key: 'color', label: 'color', desc: tx('Hex color (#RRGGBB) or a theme color name.', '十六进制颜色（#RRGGBB）或主题色名。', lang), control: <Select editable value={value.color} options={enumChoices(['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info'])} onChange={v => setField('color', v)} /> },
    { key: 'hidden', label: 'hidden', desc: tx('Hide this subagent from the @ autocomplete menu.', '在 @ 自动补全菜单中隐藏该子 agent。', lang), control: <BoolField value={value.hidden} onChange={v => setField('hidden', v)} /> },
    { key: 'disable', label: 'disable', desc: tx('Disable this agent entirely.', '完全禁用该 agent。', lang), control: <BoolField value={value.disable} onChange={v => setField('disable', v)} /> },
    { key: 'permission', label: 'permission', desc: tx('Per-agent tool permissions (overrides global).', '该 agent 的工具权限（覆盖全局）。', lang), drill: { title: 'permission', preview: previewValue(value.permission, lang), render: () => <PermissionEditor value={value.permission} onChange={v => setField('permission', v)} lang={lang} /> } },
    { key: 'tools', label: 'tools', badge: tx('deprecated', '已废弃', lang), desc: tx("Deprecated. Use 'permission' instead.", "已废弃，请改用 'permission'。", lang), drill: { title: 'tools', preview: previewValue(value.tools, lang), render: () => <ToolToggleMap value={value.tools} onChange={v => setField('tools', v)} /> } },
    { key: 'options', label: 'options', desc: tx('Provider-specific agent options.', '渠道相关的 agent 选项。', lang), drill: { title: 'options', preview: previewValue(value.options, lang), render: () => <KeyValueField value={value.options} onChange={v => setField('options', v)} /> } },
  ]
}
