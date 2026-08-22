import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
//#region src/workspace-checkpoints.ts
/**
* Workspace checkpointing for cascading message deletion.
*
* Every time a `user/message` lands in any session, this module captures a
* best-effort snapshot of the workspace the session is attached to: a full
* path→content-hash manifest plus content-addressed text blobs. Deleting a
* message later restores exactly that pre-message state.
*
* Storage layout (plugin-owned, inside the DSH home — never inside a user
* workspace):
*   <root>/manifests/<sessionId>/<seq>.json   one full tree manifest per user message
*   <root>/blobs/<hash[0:2]>/<hash>           deduplicated file contents
*   <root>/audit.log                          JSONL audit trail of deletions
*
* Workspace reads/writes go through the injected `fs` service (atomic writes,
* policy-respecting); only unlinking files created after a checkpoint falls
* back to contained `node:fs` removal because the service has no delete API.
*/
function fsOf(ctx) {
	return ctx.get("fs");
}
function sourceWorkspaceOf(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0) return void 0;
	return registry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
}
const MANIFEST_VERSION = 1;
const MAX_DEPTH = 12;
const MAX_FILES = 4e3;
const MAX_FILE_BYTES = 524288;
const MAX_CAPTURE_BYTES = 25165824;
const IGNORED_NAMES = /* @__PURE__ */ new Set([
	".git",
	".hg",
	".svn",
	".dsh",
	".cache",
	".next",
	".nuxt",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache"
]);
function checkpointRoot() {
	const raw = process.env["DSH_HOME"];
	const home = raw !== void 0 && raw.trim() !== "" ? raw.trim() : join(homedir(), ".dsh");
	return join(home, "message-edit-enhanced", "checkpoints");
}
function safeSegment(value) {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
function manifestFile(sessionId, seq) {
	return join(checkpointRoot(), "manifests", safeSegment(sessionId), `${String(seq)}.json`);
}
function blobFile(hash) {
	return join(checkpointRoot(), "blobs", hash.slice(0, 2), hash);
}
function hashText(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
async function writeAtomic(file, data) {
	await mkdir(dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, data, "utf8");
	await rename(temp, file);
}
async function readBlob(hash) {
	return readFile(blobFile(hash), "utf8");
}
async function blobExists(hash) {
	try {
		await stat(blobFile(hash));
		return true;
	} catch {
		return false;
	}
}
/** Per-session capture serialization: walks never interleave for one session. */
const captureChains = /* @__PURE__ */ new Map();
function chainCapture(sessionId, task) {
	const next = (captureChains.get(sessionId) ?? Promise.resolve()).then(task, task);
	captureChains.set(sessionId, next);
	next.catch(() => {}).finally(() => {
		if (captureChains.get(sessionId) === next) captureChains.delete(sessionId);
	});
}
/** Walk the workspace through the injected fs service, hashing every readable
* text file. Relative paths are built during the walk so any backend's opaque
* display paths stay out of the stored keys. */
async function snapshotTree(ctx, workspacePath) {
	const fs = fsOf(ctx);
	if (fs === void 0) throw new Error("Filesystem service is not available.");
	const result = {
		files: {},
		fileCount: 0,
		contents: /* @__PURE__ */ new Map(),
		skipped: [],
		warnings: []
	};
	const rootTarget = await fs.resolve(workspacePath);
	let budget = MAX_CAPTURE_BYTES;
	const visit = async (target, relBase, depth) => {
		if (result.fileCount >= MAX_FILES || budget <= 0 || depth > MAX_DEPTH) return;
		const children = await fs.listDir(target);
		for (const child of children) {
			if (result.fileCount >= MAX_FILES || budget <= 0) return;
			const rel = relBase === "" ? child.name : `${relBase}/${child.name}`;
			if (child.type === "directory") {
				if (!IGNORED_NAMES.has(child.name)) await visit(child.target, rel, depth + 1);
				continue;
			}
			if (child.type !== "file") continue;
			if ((child.size ?? 0) > MAX_FILE_BYTES) {
				result.skipped.push({
					path: rel,
					reason: "too-large"
				});
				continue;
			}
			let content;
			try {
				content = await fs.readText(child.target);
			} catch {
				result.skipped.push({
					path: rel,
					reason: "binary"
				});
				continue;
			}
			if (content.length > MAX_FILE_BYTES || content.length > budget) {
				result.skipped.push({
					path: rel,
					reason: "too-large"
				});
				continue;
			}
			budget -= content.length;
			const hash = hashText(content);
			result.files[rel] = hash;
			result.fileCount += 1;
			if (!await blobExists(hash)) result.contents.set(hash, content);
		}
	};
	await visit(rootTarget, "", 0);
	if (result.fileCount >= MAX_FILES) result.warnings.push(`Workspace tree exceeds ${String(MAX_FILES)} files; snapshot covers the first ${String(MAX_FILES)}.`);
	return result;
}
/** Capture the pre-message workspace state for one appended user message.
* Fire-and-forget safe: every failure is logged, never thrown into the feed. */
function captureCheckpoint(ctx, sessionId, seq) {
	chainCapture(sessionId, async () => {
		try {
			const workspace = sourceWorkspaceOf(ctx, sessionId);
			if (workspace === void 0) return;
			const tree = await snapshotTree(ctx, workspace.path);
			for (const [hash, content] of tree.contents) await writeAtomic(blobFile(hash), content);
			const manifest = {
				v: MANIFEST_VERSION,
				sessionId,
				seq,
				time: Date.now(),
				workspaceId: workspace.id,
				workspacePath: workspace.path,
				files: tree.files
			};
			await writeAtomic(manifestFile(sessionId, seq), JSON.stringify(manifest));
		} catch (error) {
			console.error("[message-edit-enhanced] checkpoint capture failed:", error);
		}
	});
}
function isManifest(value) {
	if (typeof value !== "object" || value === null) return null;
	const record = value;
	if (record["v"] !== MANIFEST_VERSION) return null;
	if (typeof record["sessionId"] !== "string") return null;
	if (typeof record["workspacePath"] !== "string") return null;
	if (typeof record["seq"] !== "number" || typeof record["workspaceId"] !== "string") return null;
	if (typeof record["files"] !== "object" || record["files"] === null) return null;
	return value;
}
async function loadManifestFile(sessionId, seq) {
	try {
		return isManifest(JSON.parse(await readFile(manifestFile(sessionId, seq), "utf8")));
	} catch {
		return null;
	}
}
/** Load the exact checkpoint captured before the given user message event. */
async function loadCheckpoint(sessionId, seq) {
	return loadManifestFile(sessionId, seq);
}
/** Build a read-only rollback plan for deleting everything from `eventSeq` on.
* Never mutates anything. Requires the EXACT checkpoint for the target event:
* restoring an older checkpoint would also revert preserved earlier exchanges. */
async function planRollback(ctx, sessionId, eventSeq) {
	const unavailable = (reason) => ({
		available: false,
		reason,
		filesToWrite: [],
		filesToRemove: [],
		skipped: [],
		warnings: []
	});
	const manifest = await loadManifestFile(sessionId, eventSeq);
	if (manifest === null) return unavailable("No workspace checkpoint exists for this message.");
	const workspace = sourceWorkspaceOf(ctx, sessionId);
	if (workspace === void 0) return unavailable("The session is not attached to a registered workspace.");
	if (fsOf(ctx) === void 0) return unavailable("The filesystem service is not available.");
	if (workspace.path !== manifest.workspacePath) return unavailable(`Snapshot recorded workspace ${manifest.workspacePath}, which no longer matches ${workspace.path}.`);
	const current = await snapshotTree(ctx, workspace.path);
	const filesToWrite = [];
	for (const [path, hash] of Object.entries(manifest.files)) {
		if (current.files[path] === hash) continue;
		filesToWrite.push({
			path,
			hash
		});
	}
	const plan = {
		available: true,
		manifest,
		filesToWrite: filesToWrite.sort((a, b) => a.path.localeCompare(b.path)),
		filesToRemove: Object.keys(current.files).filter((path) => manifest.files[path] === void 0).sort((a, b) => a.localeCompare(b)),
		skipped: current.skipped,
		warnings: []
	};
	if (current.fileCount >= MAX_FILES || current.skipped.length > 0) plan.warnings.push("Some files were not covered by the snapshot (binary, oversized, or ignored paths); they will be left untouched.");
	return plan;
}
function assertContained(workspacePath, rel) {
	if (rel.length === 0 || isAbsolute(rel) || rel.split("/").includes("..")) throw new Error(`Refusing to touch a path outside the workspace: ${rel}`);
	const absolute = resolve(workspacePath, ...rel.split("/"));
	const root = resolve(workspacePath);
	if (!(absolute + sep).startsWith(root + sep)) throw new Error(`Refusing to touch a path outside the workspace: ${rel}`);
	return absolute;
}
/** Restore the workspace to the planned checkpoint state. Best-effort per file:
* individual failures are collected so callers can report partial progress;
* every restore payload is pre-loaded BEFORE anything is mutated. */
async function applyRollback(ctx, plan, workspacePath) {
	const outcome = {
		reverted: 0,
		removed: 0,
		failures: []
	};
	const fs = fsOf(ctx);
	if (fs === void 0 || plan.manifest === void 0) {
		outcome.failures.push({
			path: "*",
			error: "Rollback prerequisites are missing."
		});
		return outcome;
	}
	const payloads = /* @__PURE__ */ new Map();
	for (const entry of plan.filesToWrite) try {
		payloads.set(entry.hash, await readBlob(entry.hash));
	} catch (error) {
		outcome.failures.push({
			path: entry.path,
			error: `checkpoint blob missing: ${error instanceof Error ? error.message : String(error)}`
		});
	}
	if (outcome.failures.length > 0) return outcome;
	for (const entry of plan.filesToWrite) {
		const content = payloads.get(entry.hash);
		if (content === void 0) continue;
		try {
			const absolute = assertContained(workspacePath, entry.path);
			await mkdir(dirname(absolute), { recursive: true });
			const target = await fs.resolve(join(workspacePath, entry.path));
			await fs.writeText(target, content);
			outcome.reverted += 1;
		} catch (error) {
			outcome.failures.push({
				path: entry.path,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	for (const rel of plan.filesToRemove) try {
		await rm(assertContained(workspacePath, rel), { force: true });
		outcome.removed += 1;
	} catch (error) {
		outcome.failures.push({
			path: rel,
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return outcome;
}
/** Append one JSONL audit record; returns the audit id carried in results. */
async function appendAuditEntry(entry) {
	const auditId = `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	try {
		const line = `${JSON.stringify({
			auditId,
			time: Date.now(),
			...entry
		})}\n`;
		const file = join(checkpointRoot(), "audit.log");
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, line, {
			flag: "a",
			encoding: "utf8"
		});
	} catch (error) {
		console.error("[message-edit-enhanced] audit write failed:", error);
	}
	return auditId;
}
//#endregion
//#region src/shared.ts
/** Same-origin endpoint owned by the Message Edit host plugin. */
const MESSAGE_EDIT_PATH = "/message-edit-enhanced";
/** Timeline sits between Trajectory (10) and Prompt Studio (20). */
const MESSAGE_EDIT_VIEW_ORDER = 15;
/** Current durable event schema for structurally paired version effects. */
const MESSAGE_EDIT_VERSION_SCHEMA = 2;
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "message-edit-enhanced";
/** Public services used by the branch transaction and timeline projection. */
const inject = [
	"sessions",
	"agents",
	"sessionPersistence",
	"sessionQuery",
	"workspaceRegistry",
	"webServer"
];
/** Safety limit for preserve cascades. */
const MAX_PRESERVE_QUEUE = 20;
/** Per-session FIFO of in-flight operations: edits/rerolls/retries against the
* same session run one at a time so `runMaintenance` never races itself. */
const sessionOperationQueues = /* @__PURE__ */ new Map();
/** Chain one operation behind any pending operation on the same session. */
function serializeSessionOperation(sessionId, task) {
	const next = (sessionOperationQueues.get(sessionId) ?? Promise.resolve()).then(() => task(), () => task());
	sessionOperationQueues.set(sessionId, next);
	next.catch(() => {}).finally(() => {
		if (sessionOperationQueues.get(sessionId) === next) sessionOperationQueues.delete(sessionId);
	});
	return next;
}
/** The agent loop rejects maintenance work while a turn is streaming. */
const AGENT_BUSY_MARKER = "already has active work";
/** Bounded TTL cache for value-level timeline projections. */
const TIMELINE_CACHE_TTL_MS = 5e3;
const TIMELINE_CACHE_MAX = 50;
const timelineCache = /* @__PURE__ */ new Map();
/** Invalidate one session's cached projection (call on POST). */
function invalidateTimelineCache(sessionId) {
	timelineCache.delete(sessionId);
}
function timelineCacheKey(sessionId, lineage, currentLength) {
	return lineage.map(({ record }) => {
		const live = record.header.id === sessionId ? String(currentLength) : "";
		return `${record.header.id}:${record.header.seedLength ?? 0}:${record.header.createdAt}:${live}`;
	}).join("|");
}
function cacheTimeline(sessionId, key, result) {
	if (timelineCache.size >= TIMELINE_CACHE_MAX) {
		const oldest = timelineCache.keys().next().value;
		if (oldest !== void 0) timelineCache.delete(oldest);
	}
	timelineCache.set(sessionId, {
		key,
		result,
		time: Date.now()
	});
}
function cachedTimeline(sessionId, key) {
	const entry = timelineCache.get(sessionId);
	if (entry === void 0 || entry.key !== key) return void 0;
	if (Date.now() - entry.time > TIMELINE_CACHE_TTL_MS) {
		timelineCache.delete(sessionId);
		return;
	}
	return entry.result;
}
function pairVersionEffect(sourceSessionId, effect) {
	return {
		schemaVersion: 2,
		effect: {
			...effect,
			id: crypto.randomUUID()
		},
		inverse: {
			kind: "restore-version",
			sessionId: sourceSessionId
		}
	};
}
function isTextualBlock(block) {
	return block?.type === "text" || block?.type === "reasoning";
}
function userText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
function cloneUser(message, content = structuredClone(message.content)) {
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "user",
		content: Object.freeze(content),
		source: Object.freeze({ kind: "user" })
	});
}
function replaceTextBlock(content, blockIndex, text) {
	const block = content[blockIndex];
	if (!isTextualBlock(block)) throw new Error("Selected block is not editable text.");
	return content.map((candidate, index) => index === blockIndex ? {
		...candidate,
		text
	} : structuredClone(candidate));
}
/** Fold complete turn brackets; an open tail is deliberately absent. */
function closedTurns(events) {
	const result = [];
	let current;
	for (const event of events) {
		if (event.type === "turn/start") {
			current = {
				turn: event.data.turn,
				startSeq: event.seq,
				assistants: []
			};
			continue;
		}
		if (current === void 0) continue;
		if (event.type === "user/message" && current.user === void 0 && event.data.source.kind === "user") {
			current.user = event;
			continue;
		}
		if (event.type === "assistant/message" && event.data.turn === current.turn) {
			current.assistants.push(event);
			continue;
		}
		if (event.type === "turn/end" && event.data.turn === current.turn) {
			result.push({
				...current,
				endSeq: event.seq
			});
			current = void 0;
		}
	}
	return result;
}
function editableMessages(turns) {
	const result = [];
	for (const turn of turns) {
		if (turn.user !== void 0) for (const [blockIndex, block] of turn.user.data.content.entries()) {
			if (block.type !== "text") continue;
			result.push({
				key: `${String(turn.user.seq)}:${String(blockIndex)}`,
				turn: turn.turn,
				eventSeq: turn.user.seq,
				blockIndex,
				kind: "user",
				text: block.text,
				time: turn.user.time
			});
		}
		for (const event of turn.assistants) for (const [blockIndex, block] of event.data.message.content.entries()) {
			if (!isTextualBlock(block)) continue;
			result.push({
				key: `${String(event.seq)}:${String(blockIndex)}`,
				turn: turn.turn,
				eventSeq: event.seq,
				blockIndex,
				kind: block.type === "reasoning" ? "assistant.reasoning" : "assistant.response",
				text: block.text,
				time: event.time
			});
		}
	}
	return result;
}
function retryableTurns(turns) {
	return turns.flatMap((turn) => turn.user === void 0 ? [] : [{
		turn: turn.turn,
		userEventSeq: turn.user.seq,
		preview: userText(turn.user.data),
		time: turn.user.time
	}]);
}
function downstreamUsers(turns, start) {
	return turns.slice(start).flatMap((turn) => turn.user === void 0 ? [] : [cloneUser(turn.user.data)]);
}
function assistantReplacement(event, blockIndex, text) {
	const replaced = replaceTextBlock(event.data.message.content, blockIndex, text).filter((block) => block.type === "text" || block.type === "reasoning");
	return Object.freeze({
		id: crypto.randomUUID(),
		role: "assistant",
		content: Object.freeze(replaced),
		source: Object.freeze({
			kind: "model",
			provider: event.data.message.source.provider,
			model: event.data.message.source.model
		})
	});
}
function editPlan(operation, turns) {
	const turnIndex = turns.findIndex((turn) => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq);
	const turn = turns[turnIndex];
	if (turn === void 0) throw new Error("Selected message does not belong to a settled turn.");
	const event = turn.user?.seq === operation.eventSeq ? turn.user : turn.assistants.find((candidate) => candidate.seq === operation.eventSeq);
	if (event === void 0) throw new Error("Selected message not found or not editable.");
	if (event.type === "user/message") {
		const before = event.data.content[operation.blockIndex];
		if (before?.type !== "text") throw new Error("Selected user message block is not text.");
		const edited = cloneUser(event.data, replaceTextBlock(event.data.content, operation.blockIndex, operation.text));
		const later = operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1).slice(0, 19) : [];
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(operation.sessionId, {
				operation: "edit",
				cascade: operation.cascade,
				targetTurn: turn.turn,
				targetEventSeq: event.seq,
				targetBlockIndex: operation.blockIndex,
				blockKind: "user",
				before: before.text,
				after: operation.text
			}),
			queuedUsers: [edited, ...later]
		};
	}
	const before = event.data.message.content[operation.blockIndex];
	if (!isTextualBlock(before)) throw new Error("Selected assistant block is not text or reasoning.");
	const blockKind = before.type === "reasoning" ? "assistant.reasoning" : "assistant.response";
	if (turn.user === void 0) throw new Error("Selected assistant message has no reconstructible user input.");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(operation.sessionId, {
			operation: "edit",
			cascade: operation.cascade,
			targetTurn: turn.turn,
			targetEventSeq: event.seq,
			targetBlockIndex: operation.blockIndex,
			blockKind,
			before: before.text,
			after: operation.text
		}),
		manualTurn: {
			turn: turn.turn,
			user: cloneUser(turn.user.data),
			assistant: assistantReplacement(event, operation.blockIndex, operation.text)
		},
		queuedUsers: operation.cascade === "preserve" ? downstreamUsers(turns, turnIndex + 1) : []
	};
}
function retryPlan(sessionId, turnNumber, cascade, turns) {
	const turnIndex = turns.findIndex((turn) => turn.turn === turnNumber);
	const turn = turns[turnIndex];
	if (turn?.user === void 0) throw new Error("Selected turn has no replayable user input.");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(sessionId, {
			operation: "retry",
			cascade,
			targetTurn: turn.turn,
			targetEventSeq: turn.user.seq
		}),
		queuedUsers: cascade === "preserve" ? downstreamUsers(turns, turnIndex).slice(0, MAX_PRESERVE_QUEUE) : [cloneUser(turn.user.data)]
	};
}
function rerollPlan(sessionId, turns) {
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index];
		if (turn?.user === void 0) continue;
		const target = turn.assistants.findLast((event) => event.data.message.content.some(isTextualBlock));
		if (target === void 0) continue;
		return {
			boundary: turn.startSeq - 1,
			version: pairVersionEffect(sessionId, {
				operation: "reroll",
				cascade: "truncate",
				targetTurn: turn.turn,
				targetEventSeq: target.seq
			}),
			queuedUsers: [cloneUser(turn.user.data)]
		};
	}
	throw new Error("Current session has no settled assistant reply to regenerate.");
}
/** Branch plan that ends just before the deleted exchange (fork fallback for
* sessions without a live agent; the original session keeps its history). */
function deletePlan(operation, turns) {
	const turn = turns.find((candidate) => candidate.user?.seq === operation.eventSeq);
	if (turn === void 0) throw new Error("Selected message is not a settled user message.");
	return {
		boundary: turn.startSeq - 1,
		version: pairVersionEffect(operation.sessionId, {
			operation: "delete",
			cascade: "truncate",
			targetTurn: turn.turn,
			targetEventSeq: operation.eventSeq,
			blockKind: "user",
			...turn.user === void 0 ? {} : { before: userText(turn.user.data) }
		}),
		queuedUsers: []
	};
}
function planOperation(operation, events) {
	const turns = closedTurns(events);
	switch (operation.action) {
		case "edit": return editPlan(operation, turns);
		case "reroll": return rerollPlan(operation.sessionId, turns);
		case "retry": return retryPlan(operation.sessionId, operation.turn, operation.cascade, turns);
		case "delete": return deletePlan(operation, turns);
	}
}
function agentOptions(events, fallback) {
	const config = events.findLast((event) => event.type === "request/header")?.data.header.config;
	const provider = config?.provider ?? fallback?.provider;
	const model = config?.model ?? fallback?.model;
	if (provider === void 0 || provider.length === 0 || model === void 0 || model.length === 0) throw new Error("Unable to resolve model route from session history.");
	const maxTokens = config?.maxTokens ?? fallback?.maxTokens;
	return {
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens }
	};
}
async function withSourceAgent(ctx, sessionId, operation) {
	let handle;
	let agent = ctx.agents.get(sessionId);
	if (agent === void 0) {
		const snapshot = await ctx.sessionQuery.readSession(sessionId);
		handle = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: agentOptions(snapshot.events)
		});
		agent = handle.agent;
	}
	try {
		return await agent.runMaintenance(async () => operation(agent));
	} finally {
		await handle?.dispose();
	}
}
function inheritedSeed(source, boundary) {
	if (boundary === -1) return [];
	const boundaryEvent = source.events[boundary];
	if (boundary < 0 || boundaryEvent === void 0 || boundaryEvent.seq !== boundary) throw new Error("Branch boundary is not a contiguous session event.");
	return source.events.slice(0, boundary + 1);
}
/** Build seed envelopes locally; Session construction performs canonical validation and freezing. */
function appendLogSeedEvent(events, type, data) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data
	});
}
function appendSurfaceSeedEvent(events, type, data, intent) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data,
		surfaceOp: intent.surfaceOp,
		...intent.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: intent.sourceEventSeqs }
	});
}
function appendManualTurn(events, manual) {
	const { turn, user, assistant } = manual;
	appendLogSeedEvent(events, "turn/start", { turn });
	appendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/start", {
		turn,
		step: 1
	});
	appendSurfaceSeedEvent(events, "assistant/message", {
		turn,
		step: 1,
		message: assistant
	}, {
		surfaceOp: "append",
		sourceEventSeqs: []
	});
	appendLogSeedEvent(events, "step/end", {
		turn,
		step: 1
	});
	appendLogSeedEvent(events, "turn/end", {
		turn,
		reason: { kind: "completed" }
	});
}
function versionSeed(source, plan) {
	const events = inheritedSeed(source, plan.boundary);
	const inheritedLength = events.length;
	appendLogSeedEvent(events, "message-edit-enhanced/version", plan.version);
	if (plan.manualTurn !== void 0) appendManualTurn(events, plan.manualTurn);
	return {
		events,
		inheritedLength
	};
}
function sessionPreset(session) {
	for (let index = session.events.length - 1; index >= 0; index -= 1) {
		const event = session.events[index];
		if (event?.type === "agent-preset/selected") return event.data.agentPreset;
	}
	return session.header.agentPreset;
}
async function createVersionAgent(ctx, source, childId, plan, options) {
	const seed = versionSeed(source, plan);
	const presets = ctx.get("agentPresets");
	const presetId = sessionPreset(source);
	let agentPreset;
	let setup;
	if (presets !== void 0 && presetId !== void 0) {
		const resolved = (await presets.resolve(presetId)).id;
		agentPreset = resolved;
		setup = async (agentCtx) => {
			await presets.mount(agentCtx, resolved);
		};
	}
	const child = await ctx.agents.create({
		sessionId: childId,
		seed: seed.events,
		meta: {
			...source.header.cwd === void 0 ? {} : { cwd: source.header.cwd },
			parentSession: source.id,
			seedLength: seed.inheritedLength,
			...agentPreset === void 0 ? {} : { agentPreset }
		},
		agentOptions: options,
		...setup === void 0 ? {} : { setup }
	});
	try {
		await ctx.sessions.flush(child.agent.session);
		return child;
	} catch (error) {
		await child.dispose();
		throw error;
	}
}
function sourceWorkspace(ctx, sessionId) {
	return ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
}
async function recoverOperation(inverses) {
	const failures = [];
	for (const inverse of inverses.reverse()) try {
		await inverse();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw new AggregateError(failures, "Failed to recover version operation.");
}
function isInPlaceEligible(ctx, sourceId, operation) {
	const sourceSession = ctx.sessions.get(sourceId);
	if (sourceSession === void 0) return false;
	if (ctx.agents.get(sourceId) === void 0) return false;
	if (sourceSession.events[operation.eventSeq]?.type !== "user/message") return false;
	return sourceSession.surface.nodes.includes(operation.eventSeq);
}
async function runInPlaceEdit(ctx, sourceId, operation) {
	const agent = ctx.agents.get(sourceId);
	if (agent === void 0) throw new Error("Session agent is not live; cannot edit in place.");
	return agent.runMaintenance(async () => {
		const session = agent.session;
		const events = session.events;
		const turns = closedTurns(events);
		const turn = turns[turns.findIndex((turn) => operation.eventSeq > turn.startSeq && operation.eventSeq < turn.endSeq)];
		if (turn === void 0) throw new Error("Selected message does not belong to a settled turn.");
		const target = turn.user?.seq === operation.eventSeq ? turn.user : void 0;
		if (target?.type !== "user/message") throw new Error("In-place edit requires a user message.");
		if (target.data.content[operation.blockIndex]?.type !== "text") throw new Error("Selected user message block is not text.");
		const edited = cloneUser(target.data, replaceTextBlock(target.data.content, operation.blockIndex, operation.text));
		const nodes = session.surface.nodes;
		const startIdx = nodes.indexOf(operation.eventSeq);
		if (startIdx === -1) throw new Error("Target message is no longer on the conversation surface.");
		const shadowed = nodes.slice(startIdx);
		const start = shadowed[0];
		const end = shadowed[shadowed.length - 1];
		if (start === void 0 || end === void 0) throw new Error("Target message has no surface span to truncate.");
		const options = agentOptions(events, agent.options);
		const provider = options.provider;
		const model = options.model;
		if (provider === void 0 || model === void 0) throw new Error("Unable to resolve model route for in-place edit.");
		const nextTurn = (turns.at(-1)?.turn ?? 0) + 1;
		const emptyMessage = Object.freeze({
			id: crypto.randomUUID(),
			role: "assistant",
			content: Object.freeze([]),
			source: Object.freeze({
				kind: "model",
				provider,
				model
			})
		});
		session.append("assistant/message", {
			turn: nextTurn,
			step: 1,
			message: emptyMessage
		}, {
			surfaceOp: {
				op: "replace",
				start,
				end
			},
			sourceEventSeqs: [...shadowed]
		});
		agent.followup(edited);
		try {
			await ctx.sessions.flush(session);
		} catch (error) {
			console.warn("In-place edit: flush failed, regeneration continues in memory.", error);
		}
		return {
			sessionId: session.id,
			queuedTurns: 1
		};
	});
}
async function runForkOperation(ctx, source, sourceId, events, operation) {
	const childId = sessionIdOf(`session-${crypto.randomUUID()}`);
	const inverses = [];
	try {
		const plan = planOperation(operation, events);
		const options = agentOptions(events, source.options);
		const child = await createVersionAgent(ctx, source.session, childId, plan, options);
		inverses.push(() => child.dispose());
		const workspace = sourceWorkspace(ctx, sourceId);
		if (workspace !== void 0) {
			await workspace.attachSession(childId);
			inverses.push(() => workspace.detachSession(childId));
		}
		for (const message of plan.queuedUsers) child.agent.followup(message);
		inverses.length = 0;
		return {
			sessionId: childId,
			queuedTurns: plan.queuedUsers.length
		};
	} catch (error) {
		try {
			await recoverOperation(inverses);
		} catch (recoveryError) {
			throw new AggregateError([error, recoveryError], "Version operation and its recovery both failed.");
		}
		throw error;
	}
}
/** In-place delete requires the same live prerequisites as in-place edit:
* a live session, a live agent for the followup-free truncation, and the
* target user message still on the active surface. */
function isInPlaceDeleteEligible(ctx, sourceId, operation) {
	const sourceSession = ctx.sessions.get(sourceId);
	if (sourceSession === void 0) return false;
	if (ctx.agents.get(sourceId) === void 0) return false;
	if (sourceSession.events[operation.eventSeq]?.type !== "user/message") return false;
	return sourceSession.surface.nodes.includes(operation.eventSeq);
}
/** Delete a settled user message exchange IN PLACE: truncate the surface from
* the target message to the end (one empty replacement node, no regeneration),
* after rolling the workspace back to the checkpoint taken before the message.
* Rollback-first ordering keeps the conversation untouched when files fail. */
async function runInPlaceDelete(ctx, sourceId, operation) {
	const agent = ctx.agents.get(sourceId);
	if (agent === void 0) throw new Error("Session agent is not live; cannot delete in place.");
	return agent.runMaintenance(async () => {
		const session = agent.session;
		const events = session.events;
		const turns = closedTurns(events);
		const turnIndex = turns.findIndex((turn) => turn.user?.seq === operation.eventSeq);
		const turn = turns[turnIndex];
		if (turn === void 0 || turn.user === void 0) {
			if (events[operation.eventSeq]?.type === "user/message") return {
				sessionId: session.id,
				queuedTurns: 0,
				alreadyDeleted: true
			};
			throw new Error("Selected message is not a settled user message.");
		}
		const removedTurns = turns.slice(turnIndex).map((candidate) => candidate.turn);
		let revertedFiles = 0;
		let removedFiles = 0;
		let skippedFiles = 0;
		let workspaceRolledBack = false;
		if (operation.rollbackWorkspace) {
			const plan = await planRollback(ctx, sourceId, operation.eventSeq);
			if (!plan.available || plan.manifest === void 0) throw new Error(`Workspace rollback is not available: ${plan.reason ?? "no checkpoint"}`);
			const outcome = await applyRollback(ctx, plan, plan.manifest.workspacePath);
			if (outcome.failures.length > 0) {
				const detail = outcome.failures.slice(0, 5).map((f) => `${f.path}: ${f.error}`).join("; ");
				throw new Error(`Workspace rollback failed on ${String(outcome.failures.length)} file(s); the conversation was left unchanged. Retry once file access is restored (${detail}${outcome.failures.length > 5 ? "; …" : ""})`);
			}
			revertedFiles = outcome.reverted;
			removedFiles = outcome.removed;
			skippedFiles = plan.skipped.length;
			workspaceRolledBack = true;
		}
		const nodes = session.surface.nodes;
		const startIdx = nodes.indexOf(operation.eventSeq);
		if (startIdx === -1) throw new Error("Target message is no longer on the conversation surface.");
		const shadowed = nodes.slice(startIdx);
		const start = shadowed[0];
		const end = shadowed[shadowed.length - 1];
		if (start === void 0 || end === void 0) throw new Error("Target message has no surface span to delete.");
		const options = agentOptions(events, agent.options);
		const provider = options.provider;
		const model = options.model;
		if (provider === void 0 || model === void 0) throw new Error("Unable to resolve model route for in-place delete.");
		const nextTurn = (turns.at(-1)?.turn ?? 0) + 1;
		const emptyMessage = Object.freeze({
			id: crypto.randomUUID(),
			role: "assistant",
			content: Object.freeze([]),
			source: Object.freeze({
				kind: "model",
				provider,
				model
			})
		});
		session.append("assistant/message", {
			turn: nextTurn,
			step: 1,
			message: emptyMessage
		}, {
			surfaceOp: {
				op: "replace",
				start,
				end
			},
			sourceEventSeqs: [...shadowed]
		});
		try {
			await ctx.sessions.flush(session);
		} catch (error) {
			console.warn("In-place delete: flush failed; truncation stays in memory until the next boundary.", error);
		}
		const auditId = await appendAuditEntry({
			kind: "delete",
			sessionId: session.id,
			eventSeq: operation.eventSeq,
			turn: turn.turn,
			removedTurns,
			revertedFiles,
			removedFiles,
			skippedFiles,
			rollbackWorkspace: operation.rollbackWorkspace
		});
		return {
			sessionId: session.id,
			queuedTurns: 0,
			delete: {
				removedTurns,
				revertedFiles,
				removedFiles,
				skippedFiles,
				workspaceRolledBack,
				auditId
			}
		};
	});
}
/** Read-only impact report for the confirmation dialog. */
async function deletePreview(ctx, sourceId, eventSeq) {
	const turns = closedTurns(await readCurrentLog(ctx, sourceId));
	const turnIndex = turns.findIndex((turn) => turn.user?.seq === eventSeq);
	const turn = turns[turnIndex];
	if (turn === void 0 || turn.user === void 0) throw new Error("Selected message is not a settled user message.");
	const laterTurns = turns.slice(turnIndex + 1).map((candidate) => candidate.turn);
	const liveSession = ctx.sessions.get(sourceId) !== void 0;
	const liveAgent = ctx.agents.get(sourceId) !== void 0;
	const preview = {
		sessionId: sourceId,
		eventSeq,
		turn: turn.turn,
		preview: userText(turn.user.data),
		laterTurns,
		willBranch: !liveSession || !liveAgent,
		checkpointFound: false,
		filesToRevert: [],
		filesToRemove: [],
		skipped: [],
		warnings: []
	};
	if (preview.willBranch) preview.warnings.push("This session is not active right now, so deleting will create a branch without the deleted exchanges instead of truncating this conversation.");
	try {
		const plan = await planRollback(ctx, sourceId, eventSeq);
		if (plan.available && plan.manifest !== void 0) {
			preview.checkpointFound = true;
			preview.workspacePath = plan.manifest.workspacePath;
			preview.filesToRevert = plan.filesToWrite.map((entry) => ({
				path: entry.path,
				change: "revert"
			}));
			preview.filesToRemove = plan.filesToRemove.map((path) => ({
				path,
				change: "remove"
			}));
			preview.skipped = plan.skipped;
			preview.warnings.push(...plan.warnings);
		} else {
			if (plan.reason !== void 0) preview.checkpointReason = plan.reason;
			preview.warnings.push("No pre-message workspace snapshot exists, so code changes from this exchange cannot be reverted automatically.");
		}
	} catch (error) {
		preview.checkpointReason = error instanceof Error ? error.message : String(error);
		preview.warnings.push("The workspace could not be inspected for a rollback plan.");
	}
	return preview;
}
async function runOperation(ctx, operation) {
	const sourceId = sessionIdOf(operation.sessionId);
	if (operation.action === "delete") {
		if (isInPlaceDeleteEligible(ctx, sourceId, operation)) return runInPlaceDelete(ctx, sourceId, operation);
		return withSourceAgent(ctx, sourceId, async (source) => runForkOperation(ctx, source, sourceId, source.session.events, operation));
	}
	if (operation.action === "edit" && isInPlaceEligible(ctx, sourceId, operation)) return runInPlaceEdit(ctx, sourceId, operation);
	return withSourceAgent(ctx, sourceId, async (source) => runForkOperation(ctx, source, sourceId, source.session.events, operation));
}
function ownVersionEvent(header, events) {
	const inherited = header.seedLength ?? 0;
	const ownEvents = events.filter((event) => event.type === "message-edit-enhanced/version" && event.seq >= inherited);
	if (ownEvents.length === 0) return void 0;
	if (ownEvents.length > 1) throw new Error(`Session ${header.id} contains multiple own version effects.`);
	const event = ownEvents[0];
	if (event === void 0) return void 0;
	const parent = header.parentSession;
	if ("schemaVersion" in event.data) {
		const version = event.data;
		if (version.schemaVersion !== 2) throw new Error(`Session ${header.id} uses an unsupported version effect schema.`);
		if (version.inverse.kind !== "restore-version" || parent === void 0 || version.inverse.sessionId !== parent) throw new Error(`Version effect and inverse mismatch for session ${header.id}.`);
		return {
			effect: version.effect,
			inverseSessionId: version.inverse.sessionId,
			time: event.time
		};
	}
	const legacy = event.data;
	if (parent === void 0 || legacy.sourceSessionId !== parent) throw new Error(`Legacy restore target mismatch for session ${header.id}.`);
	return {
		effect: {
			id: `legacy:${header.id}:${String(event.seq)}`,
			operation: legacy.operation,
			cascade: legacy.cascade,
			targetTurn: legacy.targetTurn,
			targetEventSeq: legacy.targetEventSeq,
			...legacy.targetBlockIndex === void 0 ? {} : { targetBlockIndex: legacy.targetBlockIndex },
			...legacy.blockKind === void 0 ? {} : { blockKind: legacy.blockKind },
			...legacy.before === void 0 ? {} : { before: legacy.before },
			...legacy.after === void 0 ? {} : { after: legacy.after }
		},
		inverseSessionId: legacy.sourceSessionId,
		time: event.time
	};
}
function flattenLineage(root, descendants) {
	const result = [{
		record: root,
		depth: 0
	}];
	const visit = (nodes, depth) => {
		const ordered = [...nodes].sort((left, right) => left.session.header.createdAt - right.session.header.createdAt || String(left.session.header.id).localeCompare(String(right.session.header.id)));
		for (const node of ordered) {
			result.push({
				record: node.session,
				depth
			});
			visit(node.descendants, depth + 1);
		}
	};
	visit(descendants, 1);
	return result;
}
/** Bounded parallel inspection of persisted branches; matches the corpus worker shape. */
const TIMELINE_READ_CONCURRENCY = 4;
async function mapConcurrent(items, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	const run = async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	};
	const workers = Math.min(TIMELINE_READ_CONCURRENCY, items.length);
	await Promise.all(Array.from({ length: workers }, () => run()));
	return results;
}
/** Full log for the requested session: live borrow, persisted inspection, query fallback. */
async function readCurrentLog(ctx, sessionId) {
	const live = ctx.sessions.get(sessionId);
	if (live !== void 0) return live.events;
	const persistence = ctx.get("sessionPersistence");
	if (persistence !== void 0) return (await persistence.inspect(sessionId)).events;
	return (await ctx.sessionQuery.readSession(sessionId)).events;
}
/** Own-version scan window for one lineage node: the tail from the durable
* seed boundary is enough, and root nodes cannot carry a version effect. */
async function versionLog(ctx, record) {
	const inherited = record.header.seedLength ?? 0;
	const live = ctx.sessions.get(record.header.id);
	if (live !== void 0) return live.events.slice(inherited);
	const persistence = ctx.get("sessionPersistence");
	if (persistence !== void 0) return (await persistence.readFrom(record.header.id, inherited)).events;
	return (await ctx.sessionQuery.readSession(record.header.id)).events.slice(inherited);
}
async function timeline(ctx, sessionId) {
	const targetTrace = await ctx.sessionQuery.traceSession(sessionId);
	const rootId = targetTrace.complete ? targetTrace.root.header.id : targetTrace.ancestors.at(-1)?.header.id ?? sessionId;
	const rootTrace = rootId === sessionId ? targetTrace : await ctx.sessionQuery.traceSession(rootId);
	const lineage = flattenLineage(rootTrace.target, rootTrace.descendants);
	const liveCurrent = ctx.sessions.get(sessionId);
	const currentLength = liveCurrent !== void 0 ? liveCurrent.events.length : -1;
	const cacheable = liveCurrent !== void 0 && sessionId === rootId;
	if (cacheable) {
		const hit = cachedTimeline(sessionId, timelineCacheKey(sessionId, lineage, currentLength));
		if (hit !== void 0) return hit;
	}
	const logs = await mapConcurrent(lineage, async ({ record }) => {
		if (record.header.id === sessionId) return readCurrentLog(ctx, sessionId);
		if (record.header.parentSession === void 0) return [];
		return versionLog(ctx, record);
	});
	const recordsById = new Map(lineage.map(({ record }) => [record.header.id, record]));
	const currentPath = /* @__PURE__ */ new Set();
	let pathId = sessionId;
	while (pathId !== void 0 && !currentPath.has(pathId)) {
		currentPath.add(pathId);
		pathId = recordsById.get(pathId)?.header.parentSession;
	}
	const versions = lineage.map(({ record, depth }, index) => {
		const version = ownVersionEvent(record.header, logs[index] ?? []);
		return {
			sessionId: record.header.id,
			...record.header.parentSession === void 0 ? {} : { parentSessionId: record.header.parentSession },
			...version === void 0 ? {} : {
				effectId: version.effect.id,
				inverseSessionId: version.inverseSessionId
			},
			createdAt: version?.time ?? record.header.createdAt,
			depth,
			current: record.header.id === sessionId,
			onCurrentEffectPath: currentPath.has(record.header.id),
			...version === void 0 ? {} : {
				operation: version.effect.operation,
				cascade: version.effect.cascade,
				targetTurn: version.effect.targetTurn,
				...version.effect.blockKind === void 0 ? {} : { blockKind: version.effect.blockKind },
				...version.effect.before === void 0 ? {} : { before: version.effect.before },
				...version.effect.after === void 0 ? {} : { after: version.effect.after }
			}
		};
	});
	const effectIds = /* @__PURE__ */ new Set();
	for (const version of versions) {
		if (version.effectId === void 0) continue;
		if (effectIds.has(version.effectId)) throw new Error(`Version effect ${version.effectId} is duplicated.`);
		effectIds.add(version.effectId);
	}
	const versionsById = new Map(versions.map((version) => [version.sessionId, version]));
	const undoStack = [];
	let undoCursor = versionsById.get(sessionId);
	while (undoCursor?.inverseSessionId !== void 0) {
		const inverseId = undoCursor.inverseSessionId;
		if (undoStack.includes(inverseId)) throw new Error("Version effect inverse chain contains a cycle.");
		if (!versionsById.has(inverseId)) throw new Error(`Restore target ${inverseId} not in visible version tree.`);
		undoStack.push(inverseId);
		undoCursor = versionsById.get(inverseId);
	}
	const redoSessionIds = versions.filter((version) => version.inverseSessionId === sessionId).map((version) => version.sessionId);
	const currentIndex = versions.findIndex((version) => version.current);
	const currentLog = logs[currentIndex];
	if (currentIndex < 0 || currentLog === void 0) throw new Error("Current version not in version tree.");
	const turns = closedTurns(currentLog);
	const result = {
		sessionId,
		messages: editableMessages(turns),
		retryableTurns: retryableTurns(turns),
		versions,
		undoStack,
		redoSessionIds
	};
	if (cacheable) cacheTimeline(sessionId, timelineCacheKey(sessionId, lineage, currentLength), result);
	return result;
}
function objectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Request body must be a JSON object.");
	return value;
}
function sessionIdOf(value) {
	if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId must be a non-empty string.");
	return value;
}
function integerOf(value, name) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
	return value;
}
function cascadeOf(value) {
	if (value !== "truncate" && value !== "preserve") throw new TypeError("cascade must be 'truncate' or 'preserve'.");
	return value;
}
function decodeOperation(value) {
	const record = objectValue(value);
	const sessionId = sessionIdOf(record["sessionId"]);
	switch (record["action"]) {
		case "edit":
			if (typeof record["text"] !== "string") throw new TypeError("text must be a string.");
			return {
				action: "edit",
				sessionId,
				eventSeq: integerOf(record["eventSeq"], "eventSeq"),
				blockIndex: integerOf(record["blockIndex"], "blockIndex"),
				text: record["text"],
				cascade: cascadeOf(record["cascade"])
			};
		case "reroll": return {
			action: "reroll",
			sessionId
		};
		case "retry": return {
			action: "retry",
			sessionId,
			turn: integerOf(record["turn"], "turn"),
			cascade: cascadeOf(record["cascade"])
		};
		case "delete": return {
			action: "delete",
			sessionId,
			eventSeq: integerOf(record["eventSeq"], "eventSeq"),
			rollbackWorkspace: record["rollbackWorkspace"] !== false
		};
		default: throw new TypeError("action must be 'edit', 'reroll', 'retry', or 'delete'.");
	}
}
function requestJson(request) {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = "";
		request.on("data", (chunk) => {
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		});
		request.on("end", () => {
			try {
				text += decoder.decode();
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}
function respondJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
/** Serve GET <MESSAGE_EDIT_PATH>/delete-preview for the confirmation dialog. */
async function handleDeletePreviewRoute(ctx, request, response) {
	try {
		const url = new URL(request.url ?? "/message-edit-enhanced", "http://message-edit-enhanced.local");
		respondJson(response, 200, await deletePreview(ctx, sessionIdOf(url.searchParams.get("sessionId")), integerOf(Number.parseInt(url.searchParams.get("eventSeq") ?? "", 10), "eventSeq")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
	}
}
async function handleRoute(ctx, request, response) {
	try {
		if (request.method === "GET") {
			respondJson(response, 200, await timeline(ctx, sessionIdOf(new URL(request.url ?? "/message-edit-enhanced", "http://message-edit-enhanced.local").searchParams.get("sessionId"))));
			return;
		}
		if (request.method === "POST") {
			const operation = decodeOperation(await requestJson(request));
			const sourceId = sessionIdOf(operation.sessionId);
			const result = await serializeSessionOperation(sourceId, () => runOperation(ctx, operation));
			invalidateTimelineCache(sourceId);
			if (result.sessionId !== sourceId) invalidateTimelineCache(result.sessionId);
			respondJson(response, 200, result);
			return;
		}
		response.writeHead(405);
		response.end();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const busy = message.includes(AGENT_BUSY_MARKER);
		respondJson(response, error instanceof TypeError ? 400 : 409, {
			error: busy ? "The assistant is still responding; wait for it to finish before editing." : message,
			...busy ? { code: "agent-busy" } : {}
		});
	}
}
/** Register the reversible route contributions and the checkpoint capture feed. */
function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: MESSAGE_EDIT_PATH,
		handler: (request, response) => handleRoute(ctx, request, response)
	}), "message-edit-enhanced: HTTP route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${MESSAGE_EDIT_PATH}/delete-preview`,
		handler: (request, response) => handleDeletePreviewRoute(ctx, request, response)
	}), "message-edit-enhanced: delete-preview route");
	ctx.effect(() => ctx.on("session/event", (session, event) => {
		if (event.type !== "user/message") return;
		if (event.data.source?.kind !== "user") return;
		captureCheckpoint(ctx, session.id, event.seq);
	}), "message-edit-enhanced: workspace checkpoint capture");
}
//#endregion
export { MESSAGE_EDIT_PATH, MESSAGE_EDIT_VERSION_SCHEMA, MESSAGE_EDIT_VIEW_ORDER, appendAuditEntry, apply, applyRollback, captureCheckpoint, inject, loadCheckpoint, name, planRollback, runOperation };
