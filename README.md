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

The extension registers one LLM-callable tool with five actions:

| Action | Required fields | Purpose |
|---|---|---|
| `start` | `command` | Start a detached Bash command |
| `list` | none | List jobs belonging to the current Pi session |
| `status` | `name` | Inspect one job |
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

### Progress callbacks

Commands started through `session_job` receive `PI_CALLBACK_DIR` and a `pi-callback` helper on `PATH`:

```bash
pi-callback --no-wake "processed 200/1000"
pi-callback "input data is invalid; intervention required"
```

Callbacks wake Pi by default. A successful or failed job automatically emits a waking completion callback.

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
