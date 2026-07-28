# Pi SDK API Matrix

Baseline: `@earendil-works/pi-coding-agent@0.81.1`

Capability revision: `pi-0.81.1-r14`; worker IPC: v10.

PiUI exposes serializable SDK behavior through HTTP, WebSocket, and worker IPC. SDK return values stay native on the transport; browser-only presentation fields are derived in the app. Function-valued dependency injection and TUI component factories remain inside the worker and are reported explicitly as `tui-only`; they are never advertised as browser RPC support.

## Native Data Contract

`SessionSnapshotV1.native` is a small native head containing Pi header identity, leaf, revision, and entry count. Exact entries are retrieved through opaque-cursor pages; concatenating every page is deep-equal to Pi `SessionManager.getEntries()`. Pages are limited by both item count and encoded byte size. `runtime-inspection.native` remains an explicit, on-demand full envelope.

`timeline` contains only the most recent presentation page. Older pages use stable item cursors and can be prepended without reloading the session. Image bytes are fetched lazily by native entry id and block index; native entry pages and JSONL export retain the original base64 block. Timeline data is not a native serialization and must never be used to reconstruct Pi session data.

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
| entries/tree/labels/navigation | tree routes and snapshot native tree | Complete |
| new/fork/clone/switch/import | replacement commands | Complete with pre-replacement lease reservation |
| extension `ctx.newSession/fork/switchSession` | worker host-control IPC | Complete with setup/withSession support |
| extension `ctx.shutdown` | graceful worker disposal | Complete |
| HTML/JSONL export | export commands | Complete |

## Resources And Management

| Pi SDK surface | PiUI surface | Status |
| --- | --- | --- |
| settings getters | global/project native scope snapshots plus effective view | Complete except applying `httpProxy`; see SDK export blockers below |
| persistent settings setters | typed settings patch | Complete for every setter exported by 0.81.1 |
| project trust store | trust GET/PUT | Complete |
| extension `project_trust` | pre-resource trust callback | Behavior matches Pi, but blocked from calling Pi's resolver directly; see SDK export blockers below |
| packages list/install/remove/update | package routes | Complete |
| package resolve missing action | `install`, `skip`, `error` | Complete; omitted remains non-destructive `skip` |
| package sources/path/update check | package management routes | Complete |
| extensions/skills/prompts/themes/context | resource snapshot and reload | Complete |
| providers/API key/OAuth/logout | provider auth routes and events | Complete |
| model catalogs and runtime inspection | model routes | Complete; Pi model JSON is retained without capability fabrication; credential-bearing config fields are redacted |
| model runtime reload/refresh | model runtime routes | Complete |

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
- unsanitized native events containing message content, tool arguments, or tool results

These remain usable by extensions inside the isolated worker. They are excluded from browser RPC to preserve serialization, credential isolation, command accounting, and single-writer guarantees.

## SDK Export Blockers

Pi 0.81.1 implements `resolveProjectTrusted` and `applyHttpProxySettings`, but does not export either function from `@earendil-works/pi-coding-agent`. PiUI must not copy those implementations as a second source of truth. The current RPC trust callback remains isolated and covered for parity until the SDK exports its resolver; `httpProxy` is returned in the settings snapshot but is not advertised as applied by PiUI. Upgrading the SDK export surface is required to remove these two limitations.

## Conformance

Release checks must include:

- protocol and capability type tests
- real Pi SDK integration tests with the faux provider
- worker IPC handshake and host-call tests
- cross-process session lease tests
- server HTTP and WebSocket replay/resync tests
- app event-store and dialog tests
- live server file, Git, write, and chat-loop tests

Any Pi SDK version change requires reviewing this matrix and changing the capability revision.
