# Changelog

All notable changes to this project will be documented in this file.  
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),  
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-21

### Added
- **Busy-agent guard**: client disables edit/retry/reroll buttons while the session's agent is streaming (`state.busy` from `ConversationSnapshot.running`); `mutate()` rejects with a clear message (`src/client/controller.ts:36`, `src/client/controller.ts:512`, `src/client/controller.ts:616`, `src/client/MessageEditTimelineView.tsx:428`)
- **Typed `agent-busy` 409**: the host catches "already has active work" from `runMaintenance()` and returns a friendly message + `code: 'agent-busy'` instead of a raw `Error` (`src/index.ts:130`, `src/index.ts:1040`)
- **Per-session operation serialization**: `serializeSessionOperation()` queues edits/rerolls/retries per source session so `runMaintenance` never races itself (`src/index.ts:116`)
- **Revision-keyed timeline cache**: `timeline()` caches the full projection keyed by lineage signature + current events length; TTL 5s, auto-evicted on POST for the affected session; reduces redundant GETs when the client invalidates during streaming (`src/index.ts:145`, `src/index.ts:860`, `src/index.ts:935`)
- **Optimistic in-place stub**: after an in-place edit, the timeline shows the edited message immediately with a "regenerating" pulse animation; the stub is retired when the regenerated turn's `turnEnds` lands (`src/client/controller.ts:38`, `src/client/controller.ts:648`, `src/client/controller.ts:589`, `src/client/MessageEditTimelineView.tsx:682`, `src/client/MessageEditTimelineView.module.css:770`)
- **Regenerating notice**: a status banner below the switching banner while an in-place regeneration is in flight (`src/client/MessageEditTimelineView.tsx:545`)

### Changed
- `runInPlaceEdit` re-ordered: `followup(edited)` is queued **before** `flush()`; a flush failure is logged but does not abort the regeneration (the in-memory session is correct and the loop persists on the next boundary) (`src/index.ts:677`)
- In-place edits now require a **live agent** (`isInPlaceEligible` checks `ctx.agents.get()`); non-live sessions fall through to the fork path, eliminating the `keepAlive` leak from resumed agents (`src/index.ts:618`, `src/index.ts:725`)
- `withSourceAgent` restored to its original signature (no `keepAlive` parameter) — the fork path always disposes resumed handles
- Client refresh coalescing: the in-place branch no longer calls `refreshIfLoaded()` — the session-event subscription drives the single refresh when the regenerated turn ends (`src/client/controller.ts:631`)
- `optimisticEdit` + `regenerating` are cleared on `mutate()` error, so a failed in-place edit does not leave a stale phantom stub (`src/client/controller.ts:668`)

### Fixed
- `onSurface` routing is now consistent: `isInPlaceEligible` reads the live session's surface; non-live sessions (cannot host a `runMaintenance` followup) always fork, matching the documented behavior

## [0.3.0] - 2026-08-21

### Added
- **In-place truncate & regenerate for user-message edits** (ChatGPT-style, no fork): editing a settled user message shadows the surface range from the edited message to the end with an empty `assistant/message` replacement node, then re-sends the edited message through `agent.followup()` inside the source agent's `runMaintenance()`, so the response regenerates in the **same session** with full engine machinery
- `keepAlive` option on `withSourceAgent()` so a resumed source agent survives long enough to process the queued in-place followup; only failure paths dispose
- Client in-place branch in `mutate()`: when the host returns the current session id, skip navigation, the switching banner, and stub version insertion, and refresh the timeline in place

### Changed
- Edit routing in `runOperation()`: `edit` on a `user/message` target takes the in-place path; assistant-block edits keep the fork path; reroll/retry unchanged
- Shared `runForkOperation()` helper extracted for the three fork paths (assistant edit, reroll, retry)
- README documents the dual behavior: in-place user edits vs forked assistant edits/rerolls/retries

### Fixed
- No `message-edit-enhanced/version` event is appended for in-place edits, keeping the timeline's `undoStack` walk cycle-free (a version event on the current session would make its own inverse match itself)

[0.4.0]: https://github.com/disc0nct/dsh-message-edit-enhanced/releases/tag/v0.4.0

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