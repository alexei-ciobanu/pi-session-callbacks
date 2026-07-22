# Changelog

## [Unreleased]

### Changed

- Added compact, action-aware `session_job` call and result rendering. Job paths and timestamps are shown only in expanded output.
- Show the submitted Bash command in `session_job start` calls.
- Render quiet callbacks as durable TUI-only entries that never enter agent context or trigger agent turns.

## [0.1.0] - 2026-07-22

### Added

- Initial standalone Pi package.
- Durable per-session callback inboxes with waking and non-waking messages.
- Cross-platform detached background jobs using Pi's Bash runtime.
- Job start, list, status, logs, and stop operations through `session_job`.
