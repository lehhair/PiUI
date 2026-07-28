# Pi SDK API Matrix

Baseline: `@earendil-works/pi-coding-agent@0.81.1` with the local SDK export patch in `patches/`.

Capability revision: `pi-0.81.1-r17`; worker IPC: v13.

PiUI exposes serializable SDK behavior through HTTP, WebSocket, and worker IPC. SDK return values stay native on the transport; browser-only presentation fields are derived in the app. Function-valued dependency injection and TUI component factories remain inside the worker and are reported explicitly as `tui-only`; they are never advertised as browser RPC support.

## Native Data Contract

`SessionSnapshotV1.native` is a small native head containing Pi header identity, leaf, revision, and entry count. Exact entries are retrieved through opaque-cursor pages; concatenating every entries page is deep-equal to Pi `SessionManager.getEntries()`. The chat surface uses a separate lossless native branch page that is deep-equal to `SessionManager.getBranch()`, matching Pi's active-session semantics without reconstructing a branch from partial all-entry pages. Pages are limited by both item count and encoded byte size. The native tree route is a deep-equal JSON copy of `SessionManager.getTree()`. `runtime-inspection.native` remains an explicit, on-demand full envelope.

There is no remote timeline or presentation API. The browser pages Pi's native active branch and derives render-only `Message` objects in app memory. Raw Pi session events drive transient streaming entries; the next native revision replaces them with persisted branch entries. This browser adapter is disposable and cannot write or reconstruct Pi session data. Native image blocks, unknown fields, entries, and events retain their original JSON values on the transport.

## Session And Prompt

| Pi SDK surface | PiUI surface | Status |
| --- | --- | --- |
| `SessionManager.list/listAll/create/open` | session list/create/open routes | Complete, including settings and `PI_CODING_AGENT_SESSION_DIR` overrides |
| `AgentSession.prompt` | `session.prompt` command | Complete; source is `rpc`, templates configurable, images supported |
| `steer/followUp/sendUserMessage` | run-control commands | Complete |
| `abort/waitForIdle` | run-control/query commands | Complete |
| queue modes and clear | queue commands and snapshot state | Complete |
| model/thinking/scoped models | model commands and snapshot state | Complete, including thinking `max` |
| tools and tool inspection | tools commands and runtime inspection | Complete; parameter schema, prompt guidelines, and sourceInfo are retained |
| compaction/retry/branch summary | independent control commands | Complete |
| user bash | bash command, abort, bounded output metadata | Complete |
| entries/tree/labels/navigation | native entry/tree routes and commands | Complete; entries and tree nodes remain Pi-native JSON |
| new/fork/clone/switch/import | replacement commands | Complete with pre-replacement lease reservation |
| extension `ctx.newSession/fork/switchSession` | worker host-control IPC | Complete with setup/withSession support |
| extension `ctx.shutdown` | graceful worker disposal | Complete |
| HTML/JSONL export | export commands | Complete |

## Resources And Management

| Pi SDK surface | PiUI surface | Status |
| --- | --- | --- |
| settings getters | global/project native scope snapshots plus effective view | Complete, including applied `httpProxy` |
| persistent settings setters | typed settings patch | Complete for every setter exported by the patched SDK, including `httpProxy` |
| project trust store | trust GET/PUT | Complete |
| extension `project_trust` | pre-resource trust callback | Complete through Pi's exported `resolveProjectTrusted` |
| packages list/install/remove/update | package routes | Complete |
| package resolve missing action | `install`, `skip`, `error` | Complete; omitted remains non-destructive `skip` |
| package sources/path/update check | package management routes | Complete |
| extensions/skills/prompts/themes/context | resource snapshot and reload | Complete |
| providers/API key/OAuth/logout | provider auth routes and events | Complete |
| model catalogs and runtime inspection | model routes | Complete; Pi model JSON is retained without capability fabrication; credential-bearing config fields are redacted |
| model runtime reload/refresh | model runtime routes | Complete |

## Browser UI Coverage

Every interactive surface exposed by the current PiUI server has a browser path. Session lifecycle, prompt/image input, model and thinking selection, tree navigation, queue/retry/compaction, tools, providers, packages, resources, project trust, export, Bash, custom messages, custom entries, and extension dialogs have dedicated controls. Low-frequency persistent settings remain fully reachable through the typed `PiSettingsPatch` JSON editor; global, project, and effective native scopes are visible beside it.

Prompt-template expansion and Bash context exclusion are explicit controls in Session commands. Resource reload invalidates the browser command cache, and model runtime reload/refresh also refreshes the chat model catalog. Skills display the native serializable metadata returned by Pi rather than an empty fabricated body.

Transport-only surfaces do not receive artificial buttons: health, capability negotiation, command polling, cursors, replay/resync, attachment bytes, revisions, and idempotency records are consumed automatically. Capabilities that do not exist in the server API, including llama.cpp management, Git mutation, worktrees, PTY, and MCP, remain disabled and are not represented as completed UI integration.

## Extension UI

The capability manifest contains a per-method `rpc`, `web-equivalent`, or `tui-only` value and concrete size limits.

| Methods | Status |
| --- | --- |
| select, confirm, input, editor | Browser RPC dialog, timeout/abort, snapshot recovery, idempotent response |
| notify, status, string widgets, title | Web events and persistent session UI state |
| working indicator/message, hidden-thinking label | Web-equivalent state |
| editor set/paste/get | Browser draft synchronization with worker shadow state |
| theme name and tools expanded | Web-equivalent state |
| terminal input | `tui-only`; terminal byte streams are not browser keyboard events |
| component widget/header/footer/custom | `tui-only`; component factories are functions and cannot cross JSON IPC |
| editor component and autocomplete factory | `tui-only`; no false RPC declaration |
| theme enumeration | `rpc`; serializable `{name, path}` metadata comes from Pi ResourceLoader |
| TUI Theme object/getTheme | `tui-only`; Theme instances contain rendering functions |
| custom message/entry/tool renderers | Execute only in a TUI host; PiUI transports structured message/tool data instead |
| extension shortcuts | TUI-host keybinding behavior; extension commands remain available to Web command UI |

## Remote Boundary Policy

The following public library hooks are intentionally not remote APIs:

- function-valued `customTools`, custom `ResourceLoader`, `SettingsManager`, `SessionManager`, and `ModelRuntime` injection
- raw credential reads and credential-store injection
- `PromptOptions.preflightResult`, because command status is the remote acknowledgement
- low-level direct append/rewrite methods that can bypass command idempotency and the single-writer lease
- event handler functions and non-JSON event members

These remain usable by extensions inside the isolated worker. JSON-serializable `AgentSessionEvent` fields, including message content, tool arguments, partial results, and tool results, are transported unchanged to the authenticated session stream so the browser can render native events without a server projection.

## SDK Export Integration

The local Pi SDK fork exports `resolveProjectTrusted` and `applyHttpProxySettings`, adds native `SettingsManager.getHttpProxy()/setHttpProxy()`, and exposes the native command catalog through `AgentSession.getCommands()`. PiUI calls those APIs directly. Until that fork is published as a newer package version, `patch-package` applies the same compiled API additions to the pinned `0.81.1` dependency during install; no Pi behavior is reimplemented in PiUI.

## Conformance

Release checks must include:

- protocol and capability type tests
- real Pi SDK integration tests with the faux provider
- worker IPC handshake and host-call tests
- cross-process session lease tests
- server HTTP and WebSocket replay/resync tests
- app native-entry/event adapter and dialog tests
- live server file, Git, write, and chat-loop tests

Any Pi SDK version change requires reviewing this matrix and changing the capability revision.
