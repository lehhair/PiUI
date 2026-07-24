import { useState } from 'react'
import { ChevronRightIcon, PlusIcon, TrashIcon } from '../../../components/Icons'
import { buildAgentConfigFields } from './configEditorAgentFields'
import { AgentsSection } from './configEditorAgents'
import { DrillChild, DrillRow } from './configEditorDrill'
import { useDrillContainer, useDrillState } from './configEditorDrillState'
import { BoolField, fieldClass, IntegerField, JsonStructuredEditor, KeyValueField, NumberField, PortField, PositiveIntegerField, Select, StringListField, TextArea, TextField } from './configEditorControls'
import { DrillFields, DuplicateIdField, EmptyHint, FieldRow, GroupHeader, NamedDrillList, SectionShell, type FieldDef } from './configEditorFields'
import { FormatterSection, LspSection, McpSection } from './configEditorIntegrations'
import { KNOWN_ROOT_KEYS } from './configEditorMeta'
import { PermissionsSection, ToolToggleMap } from './configEditorPermissions'
import { ProvidersSection } from './configEditorProviders'
import { enumChoices, type SectionProps } from './configEditorSectionTypes'
import type { Choice, JsonRecord, Lang, SectionID } from './configEditorTypes'
import { clone, getObject, hasNested, hasOwn, hasRoot, isRecord, previewValue, setNested, setRoot, tx } from './configEditorUtils'

function GeneralSection({ config, setConfig, lang, shells, models, agents }: SectionProps) {
  const root = config as JsonRecord
  const set = (key: string, value: unknown) => setConfig(setRoot(config, key, value))
  const fields: FieldDef[] = [
    {
      key: 'model',
      label: 'model',
      desc: tx('Default model, in provider/model format (e.g. anthropic/claude-sonnet-4).', '默认模型，格式 provider/model（如 anthropic/claude-sonnet-4）。', lang),
      control: <Select editable value={root.model} options={models} onChange={v => set('model', v)} placeholder="provider/model" />,
    },
    {
      key: 'small_model',
      label: 'small_model',
      desc: tx('Small model for light tasks like title generation.', '用于标题生成等轻量任务的小模型。', lang),
      control: <Select editable value={root.small_model} options={models} onChange={v => set('small_model', v)} placeholder="provider/model" />,
    },
    {
      key: 'default_agent',
      label: 'default_agent',
      desc: tx("Primary agent used when none is specified. Falls back to 'build'.", "未指定时使用的主 agent，默认回退到 'build'。", lang),
      control: <Select editable value={root.default_agent} options={agents} onChange={v => set('default_agent', v)} />,
    },
    {
      key: 'subagent_depth',
      label: 'subagent_depth',
      desc: tx('Maximum subagent nesting depth (default: 1).', '子 agent 最大嵌套深度（默认 1）。', lang),
      control: <IntegerField value={root.subagent_depth} min={0} onChange={v => set('subagent_depth', v)} />,
    },
    {
      key: 'shell',
      label: 'shell',
      desc: tx('Default shell for the terminal and bash tool.', '终端和 bash 工具默认使用的 shell。', lang),
      control: <Select editable value={root.shell} options={shells} onChange={v => set('shell', v)} />,
    },
    {
      key: 'username',
      label: 'username',
      desc: tx('Custom username shown in conversations instead of the system username.', '对话中显示的自定义用户名，替代系统用户名。', lang),
      control: <TextField value={root.username} onChange={v => set('username', v)} />,
    },
    {
      key: 'logLevel',
      label: 'logLevel',
      desc: tx('Logging verbosity.', '日志详细程度。', lang),
      control: <Select value={root.logLevel} options={enumChoices(['DEBUG', 'INFO', 'WARN', 'ERROR'])} onChange={v => set('logLevel', v)} />,
    },
    {
      key: 'share',
      label: 'share',
      desc: tx("Sharing behavior: 'manual', 'auto', or 'disabled'.", "分享行为：手动 manual、自动 auto 或禁用 disabled。", lang),
      control: <Select value={root.share} options={enumChoices(['manual', 'auto', 'disabled'])} onChange={v => set('share', v)} />,
    },
    {
      key: 'autoupdate',
      label: 'autoupdate',
      desc: tx("Auto-update: true to update, false to disable, 'notify' to only notify.", "自动更新：true 自动更新，false 关闭，'notify' 仅提示。", lang),
      control: (
        <Select
          value={typeof root.autoupdate === 'boolean' ? String(root.autoupdate) : root.autoupdate}
          options={[
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
            { value: 'notify', label: 'notify' },
          ]}
          onChange={v => set('autoupdate', v === 'true' ? true : v === 'false' ? false : v)}
        />
      ),
    },
    {
      key: 'snapshot',
      label: 'snapshot',
      desc: tx('Record filesystem snapshots so changes can be undone/reverted (default: true).', '记录文件系统快照以支持撤销/回退（默认 true）。', lang),
      control: <BoolField value={root.snapshot !== false} onChange={v => set('snapshot', v)} />,
    },
    {
      key: 'instructions',
      label: 'instructions',
      block: true,
      desc: tx('Extra instruction files or glob patterns to include.', '额外要加载的 instruction 文件或通配符。', lang),
      control: <StringListField value={root.instructions} onChange={v => set('instructions', v)} mono placeholder="AGENTS.md" />,
    },
    {
      key: 'disabled_providers',
      label: 'disabled_providers',
      block: true,
      desc: tx('Providers that are loaded automatically but should be disabled.', '禁用那些会被自动加载的渠道。', lang),
      control: <StringListField value={root.disabled_providers} onChange={v => set('disabled_providers', v)} mono />,
    },
    {
      key: 'enabled_providers',
      label: 'enabled_providers',
      block: true,
      desc: tx('When set, ONLY these providers are enabled; all others are ignored.', '设置后只有这些渠道启用，其余全部忽略。', lang),
      control: <StringListField value={root.enabled_providers} onChange={v => set('enabled_providers', v)} mono />,
    },
  ]
  return (
    <SectionShell id="general" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => hasRoot(config, key)} lang={lang} />
    </SectionShell>
  )
}

function ServerSection({ config, setConfig, lang }: SectionProps) {
  const server = getObject(config, 'server')
  const set = (key: string, value: unknown) => setConfig(setNested(config, ['server', key], value))
  const fields: FieldDef[] = [
    { key: 'port', label: 'port', desc: tx('Port to listen on.', '监听端口。', lang), control: <PortField value={server.port} onChange={v => set('port', v)} /> },
    { key: 'hostname', label: 'hostname', desc: tx('Hostname to listen on.', '监听主机名。', lang), control: <TextField value={server.hostname} onChange={v => set('hostname', v)} placeholder="127.0.0.1" /> },
    { key: 'mdns', label: 'mdns', desc: tx('Enable mDNS service discovery.', '启用 mDNS 服务发现。', lang), control: <BoolField value={server.mdns} onChange={v => set('mdns', v)} /> },
    { key: 'mdnsDomain', label: 'mdnsDomain', desc: tx('Custom mDNS domain (default: opencode.local).', '自定义 mDNS 域名（默认 opencode.local）。', lang), control: <TextField value={server.mdnsDomain} onChange={v => set('mdnsDomain', v)} /> },
    { key: 'cors', label: 'cors', desc: tx('Additional domains allowed for CORS.', '额外允许跨域（CORS）的域名。', lang), control: <StringListField value={server.cors} onChange={v => set('cors', v)} mono /> },
  ]
  return (
    <SectionShell id="server" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => hasNested(config, ['server', key])} lang={lang} />
    </SectionShell>
  )
}

function CommandsSection(props: SectionProps) {
  return (
    <SectionShell id="commands" lang={props.lang}>
      <CommandHome {...props} />
    </SectionShell>
  )
}

function CommandHome({ config, setConfig, lang, models, agents }: SectionProps) {
  const { activeChildId, enter, depth } = useDrillContainer()
  const drill = useDrillState()
  const map = getObject(config, 'command')
  const names = Object.keys(map).sort()
  const selected = activeChildId?.startsWith('command:') ? activeChildId.slice('command:'.length) : ''
  const value = getObject(config, 'command')[selected]
  const item = isRecord(value) ? value : {}
  const setItem = (next: JsonRecord) => setConfig(setNested(config, ['command', selected], next))
  const fields: FieldDef[] = selected
    ? [
        { key: 'template', label: 'template', badge: tx('required', '必填', lang), block: true, desc: tx('Prompt template sent when the command runs. Use $ARGUMENTS for input.', '命令运行时发送的 prompt 模板，可用 $ARGUMENTS 接收输入。', lang), control: <TextArea value={item.template} onChange={v => setItem({ ...item, template: v })} /> },
        { key: 'description', label: 'description', desc: tx('Short description shown in the command menu.', '命令菜单中显示的简短描述。', lang), control: <TextField value={item.description} onChange={v => setItem({ ...item, description: v })} /> },
        { key: 'agent', label: 'agent', desc: tx('Agent to run this command with.', '运行此命令使用的 agent。', lang), control: <Select editable value={item.agent} options={agents} onChange={v => setItem({ ...item, agent: v })} /> },
        { key: 'model', label: 'model', desc: tx('Model override for this command.', '此命令使用的模型覆盖。', lang), control: <Select editable value={item.model} options={models} onChange={v => setItem({ ...item, model: v })} /> },
        { key: 'variant', label: 'variant', desc: tx('Model variant for this command.', '此命令使用的模型 variant。', lang), control: <TextField value={item.variant} onChange={v => setItem({ ...item, variant: v })} /> },
        { key: 'subtask', label: 'subtask', desc: tx('Run the command as a subtask.', '以子任务方式运行命令。', lang), control: <BoolField value={item.subtask} onChange={v => setItem({ ...item, subtask: v })} /> },
      ]
    : []
  if (selected) {
    return (
      <DrillChild depth={depth}>
        <div className="space-y-6">
          <DuplicateIdField
            sourceId={selected}
            existing={map}
            lang={lang}
            onCopy={targetId => {
              setConfig(setNested(config, ['command', targetId], clone(item)))
              drill.replace(0, { id: `command:${targetId}`, title: targetId })
            }}
          />
          <DrillFields fields={fields} isConfigured={key => key in item} lang={lang} />
        </div>
      </DrillChild>
    )
  }

  return (
    <NamedDrillList
      lang={lang}
      items={names}
      addPlaceholder={tx('command name', '命令名', lang)}
      onOpen={name => enter({ id: `command:${name}`, title: name })}
      onAdd={name => setConfig(setNested(config, ['command', name], { template: '' }))}
      renderPreview={name => (isRecord(map[name]) ? String((map[name] as JsonRecord).description ?? '') : '')}
      emptyText={tx('Add a command, then configure its template.', '先添加命令，再配置它的 template。', lang)}
    />
  )
}

function SkillsSection({ config, setConfig, lang }: SectionProps) {
  return (
    <SectionShell id="skills" lang={lang}>
      <SkillsContent config={config} setConfig={setConfig} lang={lang} />
    </SectionShell>
  )
}

function SkillsContent({ config, setConfig, lang }: Pick<SectionProps, 'config' | 'setConfig' | 'lang'>) {
  const { activeChildId } = useDrillContainer()
  const skills = getObject(config, 'skills')
  const references = getObject(config, 'references')
  const legacyReferences = getObject(config, 'reference')
  const editingCurrent = activeChildId?.startsWith('reference:')
  const editingLegacy = activeChildId?.startsWith('legacy-reference:')
  const skillFields: FieldDef[] = [
    { key: 'skills.paths', label: 'skills.paths', desc: tx('Additional paths to skill folders.', '额外的技能文件夹路径。', lang), control: <StringListField value={skills.paths} onChange={v => setConfig(setNested(config, ['skills', 'paths'], v))} mono /> },
    { key: 'skills.urls', label: 'skills.urls', desc: tx('URLs to fetch skills from (e.g. /.well-known/skills/).', '从这些 URL 获取技能（如 /.well-known/skills/）。', lang), control: <StringListField value={skills.urls} onChange={v => setConfig(setNested(config, ['skills', 'urls'], v))} mono /> },
  ]
  return (
      <div className="space-y-6">
        {!editingCurrent && !editingLegacy && <DrillFields fields={skillFields} isConfigured={key => hasNested(config, key.split('.'))} lang={lang} />}
        {!editingLegacy && <div>
          <GroupHeader text={tx('References (@alias)', '引用（@alias）', lang)} count={Object.keys(references).length} />
          <p className="mb-2 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
            {tx('Named git or local directory references mentioned as @alias or @alias/path.', '命名的 git 或本地目录引用，可用 @alias 或 @alias/path 提及。', lang)}
          </p>
          <ReferenceEditor value={references} onChange={v => setConfig(setRoot(config, 'references', v))} lang={lang} drillPrefix="reference" />
        </div>}
        {hasRoot(config, 'reference') && !editingCurrent && <div>
          <GroupHeader text={tx('Legacy references (@alias)', '旧版引用（@alias）', lang)} count={Object.keys(legacyReferences).length} />
          <p className="mb-2 text-[length:var(--fs-xs)] leading-relaxed text-text-400">
            {tx("Deprecated 'reference' entries. New aliases should be added above.", "已废弃的 'reference' 条目，新 alias 请添加到上方。", lang)}
          </p>
          <ReferenceEditor value={legacyReferences} onChange={v => setConfig(setRoot(config, 'reference', v))} lang={lang} drillPrefix="legacy-reference" />
        </div>}
      </div>
  )
}

function ReferenceEditor({ value, onChange, lang, drillPrefix }: { value: JsonRecord; onChange: (value: JsonRecord) => void; lang: Lang; drillPrefix: 'reference' | 'legacy-reference' }) {
  const { activeChildId, enter, depth } = useDrillContainer()
  const drill = useDrillState()
  const [newAlias, setNewAlias] = useState('')
  const entries = Object.entries(value)
  const setEntry = (alias: string, entry: unknown) => onChange({ ...value, [alias]: entry })
  const typeOf = (entry: unknown): 'string' | 'git' | 'local' => {
    if (typeof entry === 'string') return 'string'
    if (isRecord(entry) && 'path' in entry) return 'local'
    return 'git'
  }

  if (activeChildId?.startsWith(`${drillPrefix}:`)) {
    const alias = activeChildId.slice(`${drillPrefix}:`.length)
    if (hasOwn(value, alias)) {
      return (
        <DrillChild depth={depth}>
          <div className="space-y-6">
            <DuplicateIdField
              sourceId={alias}
              existing={value}
              lang={lang}
              onCopy={targetId => {
                onChange({ ...value, [targetId]: clone(value[alias]) })
                drill.replace(depth, { id: `${drillPrefix}:${targetId}`, title: `@${targetId}` })
              }}
            />
            <ReferenceEntry alias={alias} entry={value[alias]} setEntry={setEntry} lang={lang} />
          </div>
        </DrillChild>
      )
    }
  }

  return (
    <div className="space-y-3">
      {entries.length === 0 && <EmptyHint text={tx('No references configured.', '还没有配置引用。', lang)} />}
      <div className="space-y-0.5">
      {entries.map(([alias, entry]) => {
        const type = typeOf(entry)
        return (
          <div key={alias} className="group flex items-center gap-2 rounded-lg px-2.5 transition-colors hover:bg-bg-100/50">
            <button type="button" onClick={() => enter({ id: `${drillPrefix}:${alias}`, title: `@${alias}` })} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[length:var(--fs-sm)] font-medium text-text-100">@{alias}</div>
                <div className="truncate text-[length:var(--fs-xs)] text-text-400">{type} · {previewValue(entry, lang)}</div>
              </div>
              <ChevronRightIcon size={14} className="shrink-0 text-text-300" />
            </button>
          </div>
        )
      })}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={newAlias} onChange={event => setNewAlias(event.target.value)} placeholder={tx('alias', '别名', lang)} className={`${fieldClass} min-w-0 flex-1 font-mono`} />
        <button
          type="button"
          disabled={!newAlias.trim() || hasOwn(value, newAlias.trim())}
          onClick={() => {
            setEntry(newAlias.trim(), '')
            setNewAlias('')
          }}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-2 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-100 disabled:opacity-40"
        >
          <PlusIcon size={13} />
          {tx('Add reference', '添加引用', lang)}
        </button>
      </div>
      <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-500">
        {tx('Deleting saved reference keys is not supported by the official merge API. Edit the value instead, or Reset before saving newly added references.', '官方 merge API 不支持可靠删除已保存的 reference key。请改值，刚新增的引用可在保存前 Reset。', lang)}
      </div>
    </div>
  )
}

function ReferenceEntry({ alias, entry, setEntry, lang }: { alias: string; entry: unknown; setEntry: (alias: string, entry: unknown) => void; lang: Lang }) {
  const type = typeof entry === 'string' ? 'string' : isRecord(entry) && 'path' in entry ? 'local' : 'git'
  const rec = isRecord(entry) ? entry : {}
  const fields: FieldDef[] = [
    {
      key: 'type',
      label: 'type',
      desc: tx('Reference source type.', '引用来源类型。', lang),
      control: (
        <Select
          value={type}
          options={[
            { value: 'string', label: tx('string (path/url)', 'string（路径/URL）', lang) },
            { value: 'git', label: tx('git repository', 'git 仓库', lang) },
            { value: 'local', label: tx('local path', '本地路径', lang) },
          ]}
          onChange={next => {
            if (next === 'string') setEntry(alias, '')
            else if (next === 'git') setEntry(alias, { repository: '' })
            else setEntry(alias, { path: '' })
          }}
        />
      ),
    },
    ...(type === 'string'
      ? [{ key: 'value', label: 'value', desc: tx('Path, URL, or owner/repo shorthand.', '路径、URL 或 owner/repo 简写。', lang), control: <TextField value={typeof entry === 'string' ? entry : ''} onChange={v => setEntry(alias, v)} mono placeholder="owner/repo or path" /> }]
      : type === 'git'
        ? [
            { key: 'repository', label: 'repository', desc: tx('Repository URL or owner/repo shorthand.', '仓库 URL 或 owner/repo 简写。', lang), control: <TextField value={rec.repository} onChange={v => setEntry(alias, { ...rec, repository: v })} mono placeholder={tx('repository URL or owner/repo', '仓库 URL 或 owner/repo', lang)} /> },
            { key: 'branch', label: 'branch', desc: tx('Branch to use (optional).', '使用的分支（可选）。', lang), control: <TextField value={rec.branch} onChange={v => setEntry(alias, { ...rec, branch: v })} /> },
            { key: 'description', label: 'description', desc: tx('Description of this reference.', '该引用的说明。', lang), control: <TextField value={rec.description} onChange={v => setEntry(alias, { ...rec, description: v })} /> },
            { key: 'hidden', label: 'hidden', desc: tx('Hide this reference from suggestions.', '在建议列表中隐藏该引用。', lang), control: <BoolField value={rec.hidden} onChange={v => setEntry(alias, { ...rec, hidden: v })} /> },
          ]
        : [
            { key: 'path', label: 'path', desc: tx('Local path to reference.', '本地引用路径。', lang), control: <TextField value={rec.path} onChange={v => setEntry(alias, { ...rec, path: v })} mono placeholder={tx('absolute, ~/ or workspace-relative path', '绝对路径、~/ 或相对工作区路径', lang)} /> },
            { key: 'description', label: 'description', desc: tx('Description of this reference.', '该引用的说明。', lang), control: <TextField value={rec.description} onChange={v => setEntry(alias, { ...rec, description: v })} /> },
            { key: 'hidden', label: 'hidden', desc: tx('Hide this reference from suggestions.', '在建议列表中隐藏该引用。', lang), control: <BoolField value={rec.hidden} onChange={v => setEntry(alias, { ...rec, hidden: v })} /> },
          ]),
  ]
  return <DrillFields fields={fields} isConfigured={key => key === 'type' || (isRecord(entry) ? key in entry : key === 'value')} lang={lang} />
}

function PluginsSection(props: SectionProps) {
  return (
    <SectionShell id="plugins" lang={props.lang}>
      <PluginsHome {...props} />
    </SectionShell>
  )
}

function PluginsHome({ config, setConfig, lang }: SectionProps) {
  const { activeChildId, enter, depth } = useDrillContainer()
  const list = Array.isArray((config as JsonRecord).plugin) ? ((config as JsonRecord).plugin as unknown[]) : []
  const set = (next: unknown[]) => setConfig(setRoot(config, 'plugin', next))

  if (activeChildId?.startsWith('plugin:')) {
    const index = Number(activeChildId.slice('plugin:'.length))
    if (Number.isInteger(index) && index >= 0 && index < list.length) {
      return (
        <DrillChild depth={depth}>
          <PluginEntry list={list} set={set} index={index} lang={lang} />
        </DrillChild>
      )
    }
  }

  return (
    <div className="space-y-3">
      {list.length === 0 ? (
        <EmptyHint text={tx('No plugins configured.', '还没有配置插件。', lang)} />
      ) : (
        <div className="space-y-0.5">
          {list.map((entry, index) => {
            const isTuple = Array.isArray(entry)
            const name = isTuple ? String(entry[0] ?? '') : String(entry ?? '')
            const options = isTuple && isRecord(entry[1]) ? (entry[1] as JsonRecord) : {}
            return (
              <div key={index} className="group flex items-center gap-2 rounded-lg px-2.5 transition-colors hover:bg-bg-100/50">
                <button type="button" onClick={() => enter({ id: `plugin:${index}`, title: name || tx('plugin', '插件', lang) })} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[length:var(--fs-sm)] font-medium text-text-100">{name || tx('(empty)', '（空）', lang)}</div>
                    <div className="truncate text-[length:var(--fs-xs)] text-text-400">{isTuple ? previewValue(options, lang) : tx('no options', '无配置项', lang)}</div>
                  </div>
                  <ChevronRightIcon size={14} className="shrink-0 text-text-300" />
                </button>
                <button type="button" onClick={() => set(list.filter((_, i) => i !== index))} className="shrink-0 rounded-md p-1.5 text-text-400 opacity-0 transition-opacity hover:text-error-100 group-hover:opacity-100">
                  <TrashIcon size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button type="button" onClick={() => set([...list, ''])} className="inline-flex items-center gap-1.5 rounded-lg border border-border-200/60 px-3 py-1.5 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-100">
        <PlusIcon size={13} />
        {tx('Add plugin', '添加插件', lang)}
      </button>
    </div>
  )
}

function PluginEntry({ list, set, index, lang }: { list: unknown[]; set: (next: unknown[]) => void; index: number; lang: Lang }) {
  const entry = list[index]
  const isTuple = Array.isArray(entry)
  const name = isTuple ? String(entry[0] ?? '') : String(entry ?? '')
  const options = isTuple && isRecord(entry[1]) ? (entry[1] as JsonRecord) : {}
  const fields: FieldDef[] = [
    {
      key: 'name',
      label: 'name',
      desc: tx('Plugin package spec or local plugin file.', '插件包名或本地插件文件。', lang),
      control: <TextField value={name} onChange={value => { const next = [...list]; next[index] = isTuple ? [value, options] : value; set(next) }} mono placeholder={tx('package name or ./local-plugin.js', '包名或 ./local-plugin.js', lang)} />,
    },
    {
      key: 'options',
      label: 'options',
      desc: tx('Optional plugin options object.', '可选的插件配置对象。', lang),
      drill: {
        title: 'options',
        preview: isTuple ? previewValue(options, lang) : tx('disabled', '未启用', lang),
        render: () => (
          <KeyValueField
            value={options}
            onChange={value => { const next = [...list]; next[index] = [name, value]; set(next) }}
          />
        ),
      },
    },
  ]
  return <DrillFields fields={fields} isConfigured={key => key === 'name' || (key === 'options' && isTuple)} lang={lang} />
}

function AttachmentsSection({ config, setConfig, lang }: SectionProps) {
  const image = getObject(getObject(config, 'attachment'), 'image')
  const set = (key: string, v: unknown) => setConfig(setNested(config, ['attachment', 'image', key], v))
  const fields: FieldDef[] = [
    { key: 'auto_resize', label: 'image.auto_resize', desc: tx('Resize oversized images before sending (default: true).', '发送前缩放超限图片（默认 true）。', lang), control: <BoolField value={image.auto_resize !== false} onChange={v => set('auto_resize', v)} /> },
    { key: 'max_width', label: 'image.max_width', desc: tx('Max image width before resize/reject (default: 2000).', '缩放/拒绝前的最大宽度（默认 2000）。', lang), control: <PositiveIntegerField value={image.max_width} onChange={v => set('max_width', v)} /> },
    { key: 'max_height', label: 'image.max_height', desc: tx('Max image height before resize/reject (default: 2000).', '缩放/拒绝前的最大高度（默认 2000）。', lang), control: <PositiveIntegerField value={image.max_height} onChange={v => set('max_height', v)} /> },
    { key: 'max_base64_bytes', label: 'image.max_base64_bytes', desc: tx('Max base64 payload bytes (default: 5242880).', 'base64 最大字节数（默认 5242880）。', lang), control: <PositiveIntegerField value={image.max_base64_bytes} onChange={v => set('max_base64_bytes', v)} /> },
  ]
  return (
    <SectionShell id="attachments" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => hasNested(config, ['attachment', 'image', key])} lang={lang} />
    </SectionShell>
  )
}

function RuntimeSection({ config, setConfig, lang }: SectionProps) {
  const toolOutput = getObject(config, 'tool_output')
  const compaction = getObject(config, 'compaction')
  const watcher = getObject(config, 'watcher')
  const enterprise = getObject(config, 'enterprise')
  const fields: FieldDef[] = [
    { key: 'tool_output.max_lines', label: 'tool_output.max_lines', desc: tx('Max lines of tool output before truncation (default: 2000).', '工具输出截断前的最大行数（默认 2000）。', lang), control: <PositiveIntegerField value={toolOutput.max_lines} onChange={v => setConfig(setNested(config, ['tool_output', 'max_lines'], v))} /> },
    { key: 'tool_output.max_bytes', label: 'tool_output.max_bytes', desc: tx('Max bytes of tool output before truncation (default: 51200).', '工具输出截断前的最大字节（默认 51200）。', lang), control: <PositiveIntegerField value={toolOutput.max_bytes} onChange={v => setConfig(setNested(config, ['tool_output', 'max_bytes'], v))} /> },
    { key: 'compaction.auto', label: 'compaction.auto', desc: tx('Auto-compact context when full (default: true).', '上下文满时自动压缩（默认 true）。', lang), control: <BoolField value={compaction.auto !== false} onChange={v => setConfig(setNested(config, ['compaction', 'auto'], v))} /> },
    { key: 'compaction.prune', label: 'compaction.prune', desc: tx('Prune old tool outputs (default: false).', '修剪旧的工具输出（默认 false）。', lang), control: <BoolField value={compaction.prune} onChange={v => setConfig(setNested(config, ['compaction', 'prune'], v))} /> },
    { key: 'compaction.tail_turns', label: 'compaction.tail_turns', desc: tx('Recent user turns kept verbatim during compaction (default: 2).', '压缩时原样保留的最近用户轮次数（默认 2）。', lang), control: <IntegerField value={compaction.tail_turns} min={0} onChange={v => setConfig(setNested(config, ['compaction', 'tail_turns'], v))} /> },
    { key: 'compaction.preserve_recent_tokens', label: 'compaction.preserve_recent_tokens', desc: tx('Max tokens from recent turns to preserve verbatim.', '原样保留的最近轮次最大 token 数。', lang), control: <IntegerField value={compaction.preserve_recent_tokens} min={0} onChange={v => setConfig(setNested(config, ['compaction', 'preserve_recent_tokens'], v))} /> },
    { key: 'compaction.reserved', label: 'compaction.reserved', desc: tx('Token buffer reserved to avoid overflow during compaction.', '压缩时预留的 token 缓冲，避免溢出。', lang), control: <IntegerField value={compaction.reserved} min={0} onChange={v => setConfig(setNested(config, ['compaction', 'reserved'], v))} /> },
    { key: 'watcher.ignore', label: 'watcher.ignore', block: true, desc: tx('Glob patterns the file watcher should ignore.', '文件监听忽略的通配符。', lang), control: <StringListField value={watcher.ignore} onChange={v => setConfig(setNested(config, ['watcher', 'ignore'], v))} mono /> },
    { key: 'enterprise.url', label: 'enterprise.url', desc: tx('Enterprise server URL.', '企业服务器 URL。', lang), control: <TextField value={enterprise.url} onChange={v => setConfig(setNested(config, ['enterprise', 'url'], v))} mono /> },
    { key: 'tools', label: 'tools', desc: tx('Globally enable/disable individual tools.', '全局启用/禁用单个工具。', lang), drill: { title: 'tools', preview: previewValue((config as JsonRecord).tools, lang), render: () => <ToolToggleMap value={(config as JsonRecord).tools} onChange={v => setConfig(setRoot(config, 'tools', v))} /> } },
  ]
  return (
    <SectionShell id="runtime" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => (key === 'tools' ? hasRoot(config, 'tools') : hasNested(config, key.split('.')))} lang={lang} />
    </SectionShell>
  )
}

function ExperimentalSection({ config, setConfig, lang }: SectionProps) {
  const exp = getObject(config, 'experimental')
  const set = (key: string, v: unknown) => setConfig(setNested(config, ['experimental', key], v))
  const fields: FieldDef[] = [
    { key: 'batch_tool', label: 'batch_tool', desc: tx('Enable the batch tool.', '启用批处理工具。', lang), control: <BoolField value={exp.batch_tool} onChange={v => set('batch_tool', v)} /> },
    { key: 'openTelemetry', label: 'openTelemetry', desc: tx('Emit OpenTelemetry spans for AI SDK calls.', '为 AI SDK 调用发送 OpenTelemetry 链路。', lang), control: <BoolField value={exp.openTelemetry} onChange={v => set('openTelemetry', v)} /> },
    { key: 'disable_paste_summary', label: 'disable_paste_summary', desc: tx('Disable the pasted-content summary.', '关闭粘贴内容摘要。', lang), control: <BoolField value={exp.disable_paste_summary} onChange={v => set('disable_paste_summary', v)} /> },
    { key: 'continue_loop_on_deny', label: 'continue_loop_on_deny', desc: tx('Continue the agent loop when a tool call is denied.', '工具调用被拒绝时继续 agent 循环。', lang), control: <BoolField value={exp.continue_loop_on_deny} onChange={v => set('continue_loop_on_deny', v)} /> },
    { key: 'mcp_timeout', label: 'mcp_timeout', desc: tx('Timeout in ms for MCP requests.', 'MCP 请求超时（毫秒）。', lang), control: <PositiveIntegerField value={exp.mcp_timeout} onChange={v => set('mcp_timeout', v)} /> },
    { key: 'primary_tools', label: 'primary_tools', block: true, desc: tx('Tools available only to primary agents.', '仅对主 agent 可用的工具。', lang), control: <StringListField value={exp.primary_tools} onChange={v => set('primary_tools', v)} mono /> },
    {
      key: 'policies',
      label: 'policies',
      desc: tx('Policy statements applied to resources like provider access.', '应用于资源（如 provider 访问）的策略声明。', lang),
      drill: { title: 'policies', preview: previewValue(exp.policies, lang), render: () => <PolicyEditor value={exp.policies} onChange={v => set('policies', v)} lang={lang} /> },
    },
  ]
  return (
    <SectionShell id="experimental" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => key in exp} lang={lang} />
    </SectionShell>
  )
}

function PolicyEditor({ value, onChange, lang }: { value: unknown; onChange: (value: unknown[]) => void; lang: Lang }) {
  const list = Array.isArray(value) ? value : []
  return (
    <div className="space-y-1">
      {list.length === 0 && (
        <div className="py-2 text-[length:var(--fs-sm)] text-text-400">
          {tx('No policies yet. Add one below.', '还没有策略，可在下方添加。', lang)}
        </div>
      )}
      <div className="divide-y divide-border-200/35">
        {list.map((entry, index) => {
          const rec = isRecord(entry) ? entry : {}
          return (
            <div key={index} className="space-y-2.5 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[length:var(--fs-xs)] text-text-400">{tx('Action', '动作', lang)}</div>
                  <Select
                    value={rec.action}
                    options={[{ value: 'provider.use', label: 'provider.use' }]}
                    onChange={v => {
                      const next = [...list]
                      next[index] = { ...rec, action: v }
                      onChange(next)
                    }}
                  />
                </div>
                <div className="w-[120px] shrink-0">
                  <div className="mb-1 text-[length:var(--fs-xs)] text-text-400">{tx('Effect', '效果', lang)}</div>
                  <Select
                    value={rec.effect}
                    options={enumChoices(['allow', 'deny'])}
                    onChange={v => {
                      const next = [...list]
                      next[index] = { ...rec, effect: v }
                      onChange(next)
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onChange(list.filter((_, i) => i !== index))}
                  className="mt-5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 transition-colors hover:bg-bg-200/40 hover:text-error-100"
                  title={tx('Remove', '删除', lang)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
              <div>
                <div className="mb-1 text-[length:var(--fs-xs)] text-text-400">{tx('Resource', '资源', lang)}</div>
                <TextField
                  value={rec.resource}
                  onChange={v => {
                    const next = [...list]
                    next[index] = { ...rec, resource: v }
                    onChange(next)
                  }}
                  placeholder={tx('e.g. anthropic/*', '例如 anthropic/*', lang)}
                  mono
                />
              </div>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        onClick={() => onChange([...list, { action: 'provider.use', effect: 'allow', resource: '' }])}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border-200 px-2.5 text-[length:var(--fs-sm)] font-medium text-text-100 transition-colors hover:border-border-300"
      >
        <PlusIcon size={13} />
        {tx('Add policy', '添加策略', lang)}
      </button>
    </div>
  )
}

function CompatibilitySection({ config, setConfig, lang, models }: SectionProps) {
  const root = config as JsonRecord
  const mode = getObject(config, 'mode')
  const fields: FieldDef[] = [
    { key: '$schema', label: '$schema', desc: tx('JSON schema reference for editor/validator tooling.', '供编辑器/验证工具使用的 JSON schema 引用。', lang), control: <TextField value={root.$schema} onChange={v => setConfig(setRoot(config, '$schema', v))} mono /> },
    { key: 'autoshare', label: 'autoshare', badge: tx('deprecated', '已废弃', lang), desc: tx("Deprecated. Use 'share' instead.", "已废弃，请改用 'share'。", lang), control: <BoolField value={root.autoshare} onChange={v => setConfig(setRoot(config, 'autoshare', v))} /> },
    { key: 'layout', label: 'layout', badge: tx('deprecated', '已废弃', lang), desc: tx('Deprecated. opencode always uses stretch layout.', '已废弃，opencode 始终使用 stretch layout。', lang), control: <Select value={root.layout} options={enumChoices(['auto', 'stretch'])} onChange={v => setConfig(setRoot(config, 'layout', v))} /> },
    {
      key: 'mode',
      label: 'mode',
      badge: tx('deprecated', '已废弃', lang),
      desc: tx("Deprecated. Use 'agent' instead. Kept here for old configs.", "已废弃，请改用 'agent'。这里仅用于旧配置兼容。", lang),
      drill: { title: 'mode', preview: previewValue(mode, lang), render: () => <ModeCompatEditor value={mode} onChange={v => setConfig(setRoot(config, 'mode', v))} lang={lang} models={models} /> },
    },
  ]
  return (
    <SectionShell id="compatibility" lang={lang}>
      <DrillFields fields={fields} isConfigured={key => hasRoot(config, key)} lang={lang} />
    </SectionShell>
  )
}

function ModeCompatEditor({ value, onChange, lang, models }: { value: unknown; onChange: (value: JsonRecord) => void; lang: Lang; models: Choice[] }) {
  const { activeChildId, enter, depth } = useDrillContainer()
  const drill = useDrillState()
  const rec = isRecord(value) ? value : {}
  const names = Object.keys(rec).sort()
  const [newName, setNewName] = useState('')
  if (activeChildId?.startsWith('mode-agent:')) {
    const name = activeChildId.slice('mode-agent:'.length)
    const agent = getObject(rec, name)
    return (
      <DrillChild depth={depth}>
        <div className="space-y-6">
          {drill.stack.length === depth + 1 && (
            <DuplicateIdField
              sourceId={name}
              existing={rec}
              lang={lang}
              onCopy={targetId => {
                onChange({ ...rec, [targetId]: clone(agent) })
                drill.replace(depth, { id: `mode-agent:${targetId}`, title: targetId })
              }}
            />
          )}
          <AgentCompatEditor value={agent} onChange={next => onChange({ ...rec, [name]: next })} lang={lang} models={models} />
        </div>
      </DrillChild>
    )
  }
  return (
    <div className="space-y-3">
      {names.length === 0 ? <EmptyHint text={tx('No deprecated mode entries.', '没有旧 mode 条目。', lang)} /> : (
        <div className="space-y-0.5">
          {names.map(name => <DrillRow key={name} label={name} preview={previewValue(rec[name], lang)} onClick={() => enter({ id: `mode-agent:${name}`, title: name })} />)}
        </div>
      )}
      <div className="flex min-w-0 gap-2">
        <input value={newName} onChange={event => setNewName(event.target.value)} placeholder={tx('mode name', 'mode 名称', lang)} className={`${fieldClass} min-w-0 flex-1 font-mono`} />
        <button
          type="button"
          disabled={!newName.trim() || hasOwn(rec, newName.trim())}
          onClick={() => {
            onChange({ ...rec, [newName.trim()]: { description: '' } })
            setNewName('')
          }}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[length:var(--fs-sm)] font-medium text-accent-main-100 transition-colors hover:bg-accent-main-100/10 disabled:opacity-40"
        >
          <PlusIcon size={13} />
          {tx('Add', '添加', lang)}
        </button>
      </div>
    </div>
  )
}

function AgentCompatEditor({ value, onChange, lang, models }: { value: JsonRecord; onChange: (value: JsonRecord) => void; lang: Lang; models: Choice[] }) {
  const fields = buildAgentConfigFields({ value, setField: (key, v) => onChange({ ...value, [key]: v }), lang, models })
  return <DrillFields fields={fields} isConfigured={key => key in value} lang={lang} />
}

function AdvancedSection({ config, setConfig, lang }: SectionProps) {
  const [editingUnknown, setEditingUnknown] = useState(false)
  const rest = Object.entries(config as JsonRecord).filter(([key]) => !KNOWN_ROOT_KEYS.has(key))
  return (
    <SectionShell id="advanced" lang={lang}>
      <div className="mb-3 space-y-2 rounded-lg border border-warning-100/25 bg-warning-100/10 px-3 py-2 text-[length:var(--fs-xs)] leading-relaxed text-warning-100">
        <div>{tx('The official schema has additionalProperties=false. These fields are read-only by default.', '官方 schema 设置了 additionalProperties=false。这些字段默认只读。', lang)}</div>
        {rest.length > 0 && !editingUnknown && (
          <button type="button" onClick={() => setEditingUnknown(true)} className="rounded-md border border-warning-100/40 px-2 py-1 text-warning-100 transition-colors hover:bg-warning-100/10">
            {tx('Edit anyway', '仍然编辑', lang)}
          </button>
        )}
      </div>
      {rest.length === 0 ? (
        <EmptyHint text={tx('No unrecognized fields. Everything is editable in the sections above.', '没有未识别字段，全部都能在上面的分区里编辑。', lang)} />
      ) : (
        <div className="space-y-1">
          {rest.map(([key, value]) => (
            editingUnknown ? (
              <FieldRow
                key={key}
                label={key}
                desc={previewValue(value, lang)}
                control={
                  typeof value === 'boolean' ? (
                    <BoolField value={value} onChange={v => setConfig(setRoot(config, key, v))} />
                  ) : typeof value === 'number' ? (
                    <NumberField value={value} onChange={v => setConfig(setRoot(config, key, v))} />
                  ) : Array.isArray(value) ? (
                    <JsonStructuredEditor value={value} type="array" onChange={v => setConfig(setRoot(config, key, v))} />
                  ) : isRecord(value) ? (
                    <KeyValueField value={value} onChange={v => setConfig(setRoot(config, key, v))} />
                  ) : (
                    <TextField value={value} onChange={v => setConfig(setRoot(config, key, v))} />
                  )
                }
              />
            ) : (
              <FieldRow key={key} label={key} desc={tx('Read-only unknown field.', '只读未知字段。', lang)} control={<div className="truncate rounded-lg border border-border-200/40 bg-bg-100/40 px-3 py-2 font-mono text-[length:var(--fs-xs)] text-text-400">{previewValue(value, lang)}</div>} />
            )
          ))}
        </div>
      )}
    </SectionShell>
  )
}

export function SectionRouter(props: SectionProps & { section: SectionID }) {
  switch (props.section) {
    case 'general':
      return <GeneralSection {...props} />
    case 'server':
      return <ServerSection {...props} />
    case 'commands':
      return <CommandsSection {...props} />
    case 'skills':
      return <SkillsSection {...props} />
    case 'plugins':
      return <PluginsSection {...props} />
    case 'providers':
      return <ProvidersSection {...props} />
    case 'agents':
      return <AgentsSection {...props} />
    case 'mcp':
      return <McpSection {...props} />
    case 'permissions':
      return <PermissionsSection {...props} />
    case 'formatters':
      return <FormatterSection {...props} />
    case 'lsp':
      return <LspSection {...props} />
    case 'attachments':
      return <AttachmentsSection {...props} />
    case 'runtime':
      return <RuntimeSection {...props} />
    case 'experimental':
      return <ExperimentalSection {...props} />
    case 'compatibility':
      return <CompatibilitySection {...props} />
    case 'advanced':
      return <AdvancedSection {...props} />
  }
}
