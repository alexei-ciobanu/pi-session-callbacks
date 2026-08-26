# Changelog

## [Unreleased]

### Changed

- Added compact, action-aware `session_job` call and result rendering. Job paths and timestamps are shown only in expanded output.
- Show the submitted Bash command in `session_job start` calls.
- Render quiet callbacks as durable TUI-only entries that never enter agent context or trigger agent turns.
- Bound `session_job logs` results to Pi's 50KB and 2,000-line tool-output limits while preserving the complete durable log.
- Added bounded `session_job wait` with cancellation, zero-second snapshots, and coordinated completion acknowledgement.
- Atomically arbitrate automatic completions between the callback watcher and concurrent waiters.
- Show relative job start age in status, wait, list, start, logs, and stop summaries.

### Fixed

- Preserve UTF-8 boundaries and exact requested line counts when reading a durable log tail, including logs without a final newline.

## [0.1.0] - 2026-07-22

### Added

- Initial standalone Pi package.
- Durable per-session callback inboxes with waking and non-waking messages.
- Cross-platform detached background jobs using Pi's Bash runtime.
- Job start, list, status, logs, and stop operations through `session_job`.
