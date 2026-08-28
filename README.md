# pi-session-callbacks

Durable background jobs and per-session callback streams for the [Pi coding agent](https://github.com/earendil-works/pi).

The extension has no tmux, Python, Node CLI, or native-addon dependency. Its extension logic is TypeScript, and detached jobs use the Bash runtime already required by Pi on Windows, macOS, and Linux.

## Behavior

- Every Pi session receives a private callback inbox.
- Waking callbacks trigger an agent turn; quiet callbacks only appear in the transcript.
- Callback files survive Pi restarts and are delivered when their originating session is resumed.
- Background jobs continue after Pi exits.
- Job output and state are stored beneath the session callback directory.
- Jobs are non-interactive. Use their durable logs instead of attaching to a terminal multiplexer.

## Installation

```bash
pi install git:github.com/alexei-ciobanu/pi-session-callbacks
```

For local development:

```bash
pi install /path/to/pi-session-callbacks
# or
pi -e /path/to/pi-session-callbacks/src/index.ts
```

Restart Pi or run `/reload` after installation.

## `session_job` tool

The extension registers one LLM-callable tool with six actions:

| Action | Required fields | Purpose |
|---|---|---|
| `start` | `command` | Start a detached Bash command |
| `list` | none | List jobs belonging to the current Pi session with limit/offset pagination |
| `status` | `name` | Inspect one job |
| `wait` | `name` | Wait up to a bounded timeout for one job |
| `logs` | `name` | Read the tail of its durable log |
| `stop` | `name` | Terminate its process tree |

Example tool input:

```json
{
  "action": "start",
  "name": "test-suite",
  "command": "npm test",
  "cwd": "."
}
```

Explicit names may contain alphanumerics, `.`, `_`, and `-`, and cannot be reused within the same Pi session. If `name` is omitted, the extension creates one.

`list` returns 10 jobs by default. It accepts `limit` from 1 to 1,000 and a
zero-based `offset`, reports the displayed range and total, and provides the
next offset when another page exists. Running and starting jobs appear first;
terminal jobs follow from newest to oldest. Each group uses job creation time
and then name for deterministic ordering. Pagination does not remove retained
jobs. Each page is a fresh snapshot, so jobs changing state between calls can
shift later offsets.

```json
{ "action": "list", "limit": 1000, "offset": 1000 }
```

A requested list page is bounded to 2,000 lines and 50KB. If it exceeds either
limit, the displayed result is truncated from the end and the complete page is
written to the temporary file named in the result. Use subsequent offsets to
inspect sessions containing more than 1,000 jobs. Before writing another
overflow page, the extension removes its own temporary list directories older
than 24 hours on a best-effort basis; normal operating-system temporary-file
cleanup still applies. Control characters are escaped when displaying the
path; if an extraordinary path cannot fit safely, its display is shortened
while the exact value remains in tool-result details.

`logs` returns at most 2,000 lines and 50KB to the agent, whichever limit is
reached first. The complete durable log remains available at the path shown by
expanded tool output. The existing `lines` field can also be supplied to
`status` or `wait` to include an opt-in, bounded recent-output tail in the same
tool result. Omitting `lines` preserves metadata-only status and wait output.

`wait` defaults to 30 seconds and accepts `timeoutSeconds` from 0 to 3,600. A
zero-second wait returns immediately. While a wait is active, the job's normal
waking completion callback is deferred; if the wait observes terminal state,
it acknowledges that callback so completion enters agent context only once.
Timeout or cancellation leaves callback delivery intact. `status` remains the
side-effect-free snapshot action and is retained for compatibility.

Job summaries include how long ago the job started. Expanded output also shows
the exact ISO start time. For `wait`, this job age is separate from the time
spent by that individual wait call.

While `wait` is active, it publishes throttled partial tool updates. These show
the current job state and wait duration, plus the requested log tail when
`lines` is supplied. Unchanged output is suppressed between five-second
heartbeats. Partial updates stop when the wait completes, times out, or is
cancelled. Automatic completion callbacks remain concise and never include job
logs.

### Progress callbacks

Commands started through `session_job` receive `PI_CALLBACK_DIR` and a `pi-callback` helper on `PATH`:

```bash
pi-callback --no-wake "processed 200/1000"
pi-callback "input data is invalid; intervention required"
```

Callbacks wake Pi by default. A successful or failed job automatically emits a
waking completion callback unless an active `wait` observes and acknowledges
that completion first.

The callback watcher and concurrent waiters use an atomic filesystem rename to
claim an automatic completion. This ensures that only one path can consume it,
including when multiple waits finish together.

`--no-wake` updates are rendered immediately as durable, TUI-only session entries. They are never sent to the agent and cannot trigger a turn. Use a waking callback when information needs the agent's attention or context.

## Storage

For session ID `<id>`:

```text
~/.pi/agent/callbacks/<id>/
├── bin/
│   └── pi-callback
├── inbox/
└── jobs/
    └── <job-name>/
        ├── job.json
        ├── job.log
        ├── state
        └── exit-code
```

Use `/callback-info` to display the current paths.

The inbox is a filesystem spool rather than JSONL. Producers write the message body to a temporary file in `inbox/`, then atomically rename it to either `<unique-id>.wake` or `<unique-id>.quiet`. This avoids partial records, JSON escaping, cursor files, and cross-process append races.

Callbacks are untrusted external status data and should never be treated as instructions without validation against the user's request.

## Development

```bash
bun install
bun run test
bun run typecheck
bun run lint
bun run check
```

Run the extension directly with:

```bash
pi -e ./src/index.ts
```

## License

MIT
