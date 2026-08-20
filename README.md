# DSH Message Edit

[![npm version](https://img.shields.io/npm/v/dsh-message-edit)](https://www.npmjs.com/package/dsh-message-edit)
[![npm downloads](https://img.shields.io/npm/dm/dsh-message-edit)](https://www.npmjs.com/package/dsh-message-edit)
[![license](https://img.shields.io/npm/l/dsh-message-edit)](LICENSE)

`dsh-message-edit` ([npm](https://www.npmjs.com/package/dsh-message-edit) · [GitHub](https://github.com/disc0nct/dsh-message-edit-enhanced)) adds event-sourced **message editing and regeneration** to DeepSeek Harness. The plugin never rewrites historical events nor patches the DSH engine; every edit, reroll, or retry forks a new session version from before the target turn, while the original session is preserved and can be restored at any time.

```bash
dsh plugin --profile <your-profile> add github:disc0nct/dsh-message-edit-enhanced
```

## Features

- **Edit Messages**: Edit settled user text, `assistant.reasoning` thinking blocks, and `assistant.response` reply text.
- **Regenerate**: Fork from before the last settled assistant reply's turn and regenerate using the original user input.
- **Retry Any Turn**: Select any historical turn in the Timeline to re-execute it.
- **Cascade Policies**:
 - `truncate` (default): Re-execute only the target input and drop subsequent history after that point.
 - `preserve`: Keep subsequent user inputs and re-execute them sequentially in the new branch; assistant outputs and the entire tool chain are fully regenerated.
- **Version Navigation**: The session header's `←` undoes the current atomic effect, `→` redoes the latest direct child effect; the Timeline shows the complete known branch tree, operation time, before/after content, and current version.
- **Timeline Tab**: Registered at `conversation.view`, `order: 15`, between Trajectory (10) and Prompt Studio (20).

## Design

### Temporal Composability

The plugin treats a **complete turn** as the atomic effect. The target turn's `turn/start`, model request, tool calls, tool results, and `turn/end` are never spliced by copying parts locally; the new version branches from the closed boundary before that turn:

1. User message edit, Reroll, and Retry: roll back the entire target turn, then submit the target user input as a new turn to the Agent.
2. Assistant block edit: roll back the entire target turn, construct a new fully closed turn from the original user input plus the edited assistant content; the original tool chain does not carry into the new version. When `preserve` is selected, subsequent user inputs are then submitted to the Agent sequentially, producing a new complete tool chain.
3. Each version appends an indivisible `message-edit/version` effect pair: `effect` records the forward effect, `inverse` records the restore target. The parent version chain automatically derives the combined inverse; restoration does not delete events but switches to another existing version along the inverse chain.
4. Message history transforms do not commute, so undo follows LIFO: only the current atomic effect is undone while keeping earlier effects; all successor branches remain and can be re-applied from the parent version.

### Branching and Agent Wiring

The previous implementation first staged the branch with a short-lived Session, persisted it, removed the live Session, then rebuilt the Agent via `agents.resume()`. That flow had two separated lifecycle boundaries: after the staged log was persisted, Agent creation could still fail. The current implementation uses only the public `seed + meta` transaction seam exposed by `AgentRegistry.create()`:

1. Inside the source Agent's runMaintenance(), obtain an immutable seed from the closed boundary; use an empty seed before the first turn.
2. Use a locally equivalent pure event builder to add the version effect pair and optional manual assistant turn to the seed, then call `ctx.agents.create({ seed, meta })`. The Session validates the complete seed atomically before Agent construction; any failure is structurally undone by the AgentFactory, no half-baked Session is visible to external observers, and the Agent's turn counter is initialized directly from the full history.
3. After publication, call `ctx.sessions.flush()` to establish a durability barrier before the HTTP operation succeeds.
4. Workspace attachment and child Agent lifecycle each return an atomic inverse; on failure they are composed and recovered in reverse order. Subsequent user inputs needing re-execution are then enqueued via `child.agent.followup()`.

This path does not touch `ReactLoopAgent`, AgentLoop private methods, or apiproxy's narrowing fork RPC; the branch seed is still validated by the same Session public event contract.

### Spatial Composability

- Host depends only on public services `sessions`, `agents`, `sessionPersistence`, `sessionQuery`, `workspaceRegistry`, and `webServer`.
- Browser composes only through `slots`, `conversation`, `connection`, and runtime `sessions`.
- Timeline and header share a value-level Snapshot source keyed by `sessionId`; the controller reactively subscribes to the current Session's closed turn values and the lineage values in the Session list, rebinding when the Session identity is replaced without caching the old Session object.
- New version navigation waits for the runtime Session list to publish the corresponding ID before executing `ctx.sessions.open()`, with availability changes directly driving navigation.

## Data Model

Each plugin version contains a `message-edit/version` event in its own non-inherited suffix:

```ts
interface MessageEditVersionEvent {
 schemaVersion: 2
 effect: {
  id: string
  operation: 'edit' | 'reroll' | 'retry'
  cascade: 'truncate' | 'preserve'
  targetTurn: number
  targetEventSeq: number
  targetBlockIndex?: number
  blockKind?: 'user' | 'assistant.reasoning' | 'assistant.response'
  before?: string
  after?: string
 }
 inverse: {
  kind: 'restore-version'
  sessionId: string
 }
}
```

The session header's `parentSession` forms the version tree and must match `inverse.sessionId` in the event; `seedLength` distinguishes the current version's own metadata from inherited events of the same name from ancestors. The Timeline generates a complete value-level projection via `ctx.sessionQuery.traceSession()` and `readSession()`, and derives `undoStack` and direct `redoSessionIds` from the atomic inverse chain. Legacy flat events remain readable and are normalized to the same effect pair during projection.

## UI

- `conversation.view`
 - `id: message-edit-timeline`
 - `order: 15`
 - `label: Timeline`
- `conversation.session.header.actions`
 - `id: message-edit-controls`
 - Direct parent effect undo, direct child effect redo, effect chain count, last reply regenerate

Components use CSS Modules and `--dsw-*` semantic tokens without adding a UI library. All product copy is in English and code comments are in English.

## Build

```bash
npm install
npm run build
```

The build is based on `@deepseek-ai/*@0.1.0-rc.6` types published to npm and the local toolchain (typescript, tsdown, lightningcss), no longer depending on the dsh source tree. The build generates:

- `index.mjs`: Host plugin
- `client.js`: Browser plugin
- `client.js.map`: Browser source map

## Installation

```bash
dsh plugin --profile <your-profile> add github:disc0nct/dsh-message-edit-enhanced
```

Or for local development:

```bash
dsh plugin --profile web add -w link:/path/to/dsh-message-edit
```

`dsh plugin` is a pnpm forwarder: after `add` it automatically detects the `dsh.bundle` declaration and enrolls the plugin into the profile's `dsh.profile.bundles`; restart dsh to take effect. For local development, `link:` (symlink) is recommended; rebuilding after source changes and restarting will pick up updates.

## HTTP API

- `GET /message-edit?sessionId=<id>`: Read editable messages, retryable turns, and the complete version tree.
- `POST /message-edit`: Execute `edit`, `reroll`, or `retry` and return the newly published Session ID.

## Scope Boundaries

- Does not rewrite Session events in place; history is append-only and deep-frozen.
- Does not restore or modify workspace files, command side effects, or existing artifacts in coordination.
- Does not modify the DSH engine, apiproxy, or official UI packages.
