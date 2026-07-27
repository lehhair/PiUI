# Remote Workspace API

This document covers PiUI-owned APIs. Pi SDK parity is documented separately in `PI_SDK_API_MATRIX.md`.

## Security Model

- The server listens on `127.0.0.1` and requires a persisted random bearer token.
- Remote access is expected through an authenticated SSH tunnel or equivalent local port forwarding.
- A bearer token has the authority of the operating-system user running PiUI. Workspace registration is explicit and requires an existing absolute directory.
- Processes already running as that same operating-system user are part of the local trust boundary; Node does not expose portable `openat`/`renameat` primitives for defending against a hostile same-user process continuously swapping parent directories.
- Every file path after registration is workspace-relative. Absolute paths, `..` escapes, NUL bytes, and symlink escapes are rejected.
- Git is executed without a shell, with literal pathspecs, terminal prompts and optional locks disabled, inherited Git path/config overrides removed, filesystem monitors disabled, and external diff/textconv disabled.

## Workspace

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/workspaces` | List workspaces registered in this server process |
| `GET` | `/api/v1/workspaces/default` | Register and return the default workspace |
| `POST` | `/api/v1/workspaces` | Register an existing absolute host directory |
| `GET` | `/api/v1/workspaces/:path` | Return a registered canonical workspace |

The canonical absolute path is the workspace identity and is URL-encoded as one path segment.

## Files

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `.../files?path=&limit=&cursor=` | Deterministic paged directory listing |
| `POST` | `.../files` | Create a file or directory |
| `GET` | `.../file?path=` | Read UTF-8 text or base64 binary content |
| `PUT` | `.../file?path=` | Atomically write content with optional `If-Match` ETag |
| `PATCH` | `.../file` | Move or rename an entry |
| `DELETE` | `.../file?path=&recursive=` | Delete a file or directory |

Limits:

- directory page: 2,000 entries
- text read/write: 2 MiB
- binary read/write: 8 MiB before base64 encoding
- App directory aggregation: 20,000 entries

Concurrent writes to one path are serialized. If two writers use the same ETag, exactly one succeeds and the other receives `409 STALE_REVISION`.

## Search

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `.../search/files?q=&type=&limit=` | Case-insensitive relative-path search |
| `GET` | `.../search/text?q=&limit=` | Case-insensitive fixed-text search with byte offsets |

Search uses asynchronous filesystem I/O, skips dependency/build metadata directories and symlinks, and stops when a documented bound is reached. Every response includes `stats` with visited entries, scanned files/bytes, elapsed time, truncation, and limit reason. Client disconnect aborts the scan.

Limits:

- results: 200
- visited entries: 50,000
- text file: 1 MiB
- total text bytes: 32 MiB

## Git

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `.../git/info` | Root, branch, detached/unborn state, OID, upstream, default branch, ahead/behind |
| `GET` | `.../git/status` | Rename-aware NUL-delimited index/worktree status |
| `GET` | `.../git/diff?mode=` | Bounded diff file list and line statistics |
| `GET` | `.../git/file-diff?mode=&path=` | Lazy unified patch for one listed file |

Diff modes are `git` (`HEAD` to current files), `branch` (merge base to `HEAD`), `staged`, and `unstaged`. Binary changes and rename source paths are explicit. Branch mode returns the actual base ref and merge-base commit.

Git commands time out after 15 seconds, output is limited to 4 MiB, and at most four commands run concurrently. HTTP disconnect cancels queued or running work.

## Events

The v2 WebSocket uses the canonical `workspace:<path>` stream and emits:

- `workspace.files.changed`: batched create/change/delete entries, or `rescan: true`
- `workspace.git.updated`: invalidates Git info/status/diff caches

The watcher ignores dependency and build directories, does not follow symlinks, and monitors the Git index, HEAD, refs, and packed refs separately. It emits an authoritative rescan after startup, handles watcher errors without terminating the server, and keeps at most 32 recently accessed workspaces open. The App invalidates directory/preview caches, refreshes affected expanded parents, and reloads Git state. Cursor replay and authoritative resync always preserve the complete stream subscription set.

## Error Contract

Errors use `ProblemV1`. Important codes include:

- `PATH_OUTSIDE_WORKSPACE`, `SYMLINK_ESCAPE`
- `FILE_TOO_LARGE`, `FILE_CONFLICT`, `STALE_REVISION`
- `GIT_TIMEOUT`, `GIT_OUTPUT_LIMIT`, `GIT_BASE_NOT_FOUND`, `GIT_FAILED`
- `INVALID_REQUEST`, `WORKSPACE_NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`
