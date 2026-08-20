# Changelog

All notable changes to this project will be documented in this file.  
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),  
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-21

### Added
- **In-place truncate & regenerate for user-message edits** (ChatGPT-style, no fork): editing a settled user message shadows the surface range from the edited message to the end with an empty `assistant/message` replacement node, then re-sends the edited message through `agent.followup()` inside the source agent's `runMaintenance()`, so the response regenerates in the **same session** with full engine machinery (`src/index.ts:558`, `src/index.ts:575`, `src/index.ts:594`, `src/index.ts:603`)
- `keepAlive` option on `withSourceAgent()` so a resumed source agent survives long enough to process the queued in-place followup; only failure paths dispose (`src/index.ts:417`, `src/index.ts:432`)
- Client in-place branch in `mutate()`: when the host returns the current session id, skip navigation, the switching banner, and stub version insertion, and refresh the timeline in place (`src/client/controller.ts:609`)

### Changed
- Edit routing in `runOperation()`: `edit` on a `user/message` target takes the in-place path; assistant-block edits keep the fork path; reroll/retry unchanged (`src/index.ts:607`)
- Shared `runForkOperation()` helper extracted for the three fork paths (assistant edit, reroll, retry) (`src/index.ts:607`)
- README documents the dual behavior: in-place user edits vs forked assistant edits/rerolls/retries

### Fixed
- No `message-edit-enhanced/version` event is appended for in-place edits, keeping the timeline's `undoStack` walk cycle-free (a version event on the current session would make its own inverse match itself)

[0.3.0]: https://github.com/disc0nct/dsh-message-edit-enhanced/releases/tag/v0.3.0

## [0.2.3] - 2026-08-20

### Added
- Word-level diff viewer for edited message blocks (`src/client/MessageEditTimelineView.tsx:23`, `src/client/MessageEditTimelineView.module.css:314`)
- Version search and filter chips (`src/client/MessageEditTimelineView.tsx:103`, `src/client/MessageEditTimelineView.module.css:340`)
- Branch tagging with `localStorage` persistence for pins and tags (`src/client/MessageEditTimelineView.tsx:148`, `src/client/MessageEditTimelineView.module.css:372`)
- Optimistic switching banner while navigating to a forked version (`src/client/controller.ts:29`, `src/client/MessageEditTimelineView.tsx:535`)
- Export branch as JSON or Markdown (`src/client/controller.ts:65`, `src/client/controller.ts:355`, `src/client/MessageEditTimelineView.tsx:573`)
- Circuit breaker for preserve cascades (limit 20 queued users) (`src/index.ts:112`, `src/index.ts:296`, `src/index.ts:361`)
- Lightweight list virtualization for the version timeline (`src/client/MessageEditTimelineView.tsx:460`, `src/client/MessageEditTimelineView.module.css:665`)
- Incremental optimistic tree updates after successful mutations (`src/client/controller.ts:303`)

### Changed
- Client build size increased due to added diff, virtualisation, and export logic (`dist/client.js`)

### Fixed
- Scroll position resets on version filter/search changes to prevent blank rows (`src/client/MessageEditTimelineView.tsx:490`)
- Optimistic stub derives correct `targetTurn` for edit operations instead of hardcoding `0` (`src/client/controller.ts:309`)

[0.2.3]: https://github.com/disc0nct/dsh-message-edit-enhanced/releases/tag/v0.2.3