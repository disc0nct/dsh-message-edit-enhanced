window.__ModuleLoader__.load({
	id: "dsh-message-edit-enhanced",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared.ts
		/** Same-origin endpoint owned by the Message Edit host plugin. */
		const MESSAGE_EDIT_PATH = "/message-edit-enhanced";
		//#endregion
		//#region src/client/controller.ts
		/** Merge a burst of turn completions into one refresh. */
		const REFRESH_DELAY_MS = 300;
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function objectValue(value, label) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} is not an object`);
			return value;
		}
		function stringValue(value, label) {
			if (typeof value !== "string") throw new TypeError(`${label} is not a string`);
			return value;
		}
		function numberValue(value, label) {
			if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} is not a number`);
			return value;
		}
		function booleanValue(value, label) {
			if (typeof value !== "boolean") throw new TypeError(`${label} is not a boolean`);
			return value;
		}
		function blockKind(value) {
			if (value !== "user" && value !== "assistant.reasoning" && value !== "assistant.response") throw new TypeError("Invalid message block kind");
			return value;
		}
		function decodeMessage(value, index) {
			const row = objectValue(value, `messages[${String(index)}]`);
			return {
				key: stringValue(row["key"], "message key"),
				turn: numberValue(row["turn"], "message turn"),
				eventSeq: numberValue(row["eventSeq"], "message eventSeq"),
				blockIndex: numberValue(row["blockIndex"], "message blockIndex"),
				kind: blockKind(row["kind"]),
				text: stringValue(row["text"], "message text"),
				time: numberValue(row["time"], "message time")
			};
		}
		function decodeRetryable(value, index) {
			const row = objectValue(value, `retryableTurns[${String(index)}]`);
			return {
				turn: numberValue(row["turn"], "turn"),
				userEventSeq: numberValue(row["userEventSeq"], "turn userEventSeq"),
				preview: stringValue(row["preview"], "turn preview"),
				time: numberValue(row["time"], "turn time")
			};
		}
		function optionalOperation(value) {
			if (value === void 0) return void 0;
			if (value === "edit" || value === "reroll" || value === "retry") return value;
			throw new TypeError("Invalid version operation");
		}
		function decodeVersion(value, index) {
			const row = objectValue(value, `versions[${String(index)}]`);
			const operation = optionalOperation(row["operation"]);
			const cascade = row["cascade"];
			if (cascade !== void 0 && cascade !== "truncate" && cascade !== "preserve") throw new TypeError("Invalid version cascade");
			const kind = row["blockKind"] === void 0 ? void 0 : blockKind(row["blockKind"]);
			return {
				sessionId: stringValue(row["sessionId"], "version sessionId"),
				...row["parentSessionId"] === void 0 ? {} : { parentSessionId: stringValue(row["parentSessionId"], "version parentSessionId") },
				...row["effectId"] === void 0 ? {} : { effectId: stringValue(row["effectId"], "version effectId") },
				...row["inverseSessionId"] === void 0 ? {} : { inverseSessionId: stringValue(row["inverseSessionId"], "version inverseSessionId") },
				createdAt: numberValue(row["createdAt"], "version createdAt"),
				depth: numberValue(row["depth"], "version depth"),
				current: booleanValue(row["current"], "version current"),
				onCurrentEffectPath: booleanValue(row["onCurrentEffectPath"], "version onCurrentEffectPath"),
				...operation === void 0 ? {} : { operation },
				...cascade === void 0 ? {} : { cascade },
				...row["targetTurn"] === void 0 ? {} : { targetTurn: numberValue(row["targetTurn"], "version targetTurn") },
				...kind === void 0 ? {} : { blockKind: kind },
				...row["before"] === void 0 ? {} : { before: stringValue(row["before"], "version before") },
				...row["after"] === void 0 ? {} : { after: stringValue(row["after"], "version after") }
			};
		}
		function arrayValue(value, label) {
			if (!Array.isArray(value)) throw new TypeError(`${label} is not an array`);
			return value;
		}
		function stringArray(value, label) {
			return arrayValue(value, label).map((item, index) => stringValue(item, `${label}[${String(index)}]`));
		}
		function decodeTimeline(value) {
			const data = objectValue(value, "Timeline response");
			return {
				sessionId: stringValue(data["sessionId"], "Timeline sessionId"),
				messages: arrayValue(data["messages"], "Timeline messages").map(decodeMessage),
				retryableTurns: arrayValue(data["retryableTurns"], "Timeline retryableTurns").map(decodeRetryable),
				versions: arrayValue(data["versions"], "Timeline versions").map(decodeVersion),
				undoStack: stringArray(data["undoStack"], "Timeline undoStack"),
				redoSessionIds: stringArray(data["redoSessionIds"], "Timeline redoSessionIds")
			};
		}
		function decodeOperationResult(value) {
			const data = objectValue(value, "Operation response");
			const result = {
				sessionId: stringValue(data["sessionId"], "operation sessionId"),
				queuedTurns: numberValue(data["queuedTurns"], "operation queuedTurns")
			};
			if (data["alreadyDeleted"] === true) result.alreadyDeleted = true;
			if (typeof data["delete"] === "object" && data["delete"] !== null) {
				const detail = objectValue(data["delete"], "delete result");
				result.delete = {
					removedTurns: Array.isArray(detail["removedTurns"]) ? detail["removedTurns"].map((turn) => numberValue(turn, "removedTurns entry")) : [],
					revertedFiles: numberValue(detail["revertedFiles"], "delete revertedFiles"),
					removedFiles: numberValue(detail["removedFiles"], "delete removedFiles"),
					skippedFiles: numberValue(detail["skippedFiles"], "delete skippedFiles"),
					workspaceRolledBack: booleanValue(detail["workspaceRolledBack"], "delete workspaceRolledBack"),
					auditId: stringValue(detail["auditId"], "delete auditId")
				};
			}
			return result;
		}
		/** Decode one file row of the delete preview payload. */
		function decodeDeleteFile(value, index, change) {
			return {
				path: stringValue(objectValue(value, `files[${String(index)}]`)["path"], "file path"),
				change
			};
		}
		/** Decode the host's read-only delete impact report. */
		function decodeDeletePreview(value) {
			const data = objectValue(value, "Delete preview response");
			const laterTurns = Array.isArray(data["laterTurns"]) ? data["laterTurns"].map((turn) => numberValue(turn, "laterTurns entry")) : [];
			const filesToRevert = Array.isArray(data["filesToRevert"]) ? data["filesToRevert"].map((row, index) => decodeDeleteFile(row, index, "revert")) : [];
			const filesToRemove = Array.isArray(data["filesToRemove"]) ? data["filesToRemove"].map((row, index) => decodeDeleteFile(row, index, "remove")) : [];
			const skipped = Array.isArray(data["skipped"]) ? data["skipped"].map((raw, index) => {
				const row = objectValue(raw, `skipped[${String(index)}]`);
				return {
					path: stringValue(row["path"], "skipped path"),
					reason: row["reason"] === "too-large" ? "too-large" : "binary"
				};
			}) : [];
			const warnings = Array.isArray(data["warnings"]) ? data["warnings"].map((warning) => stringValue(warning, "warning")) : [];
			const checkpointReason = typeof data["checkpointReason"] === "string" ? data["checkpointReason"] : void 0;
			const workspacePath = typeof data["workspacePath"] === "string" ? data["workspacePath"] : void 0;
			return {
				sessionId: stringValue(data["sessionId"], "preview sessionId"),
				eventSeq: numberValue(data["eventSeq"], "preview eventSeq"),
				turn: numberValue(data["turn"], "preview turn"),
				preview: stringValue(data["preview"], "preview text"),
				laterTurns,
				willBranch: booleanValue(data["willBranch"], "preview willBranch"),
				checkpointFound: booleanValue(data["checkpointFound"], "preview checkpointFound"),
				...checkpointReason === void 0 ? {} : { checkpointReason },
				...workspacePath === void 0 ? {} : { workspacePath },
				filesToRevert,
				filesToRemove,
				skipped,
				warnings
			};
		}
		async function responseValue(response) {
			const value = await response.json();
			if (response.ok) return value;
			const error = objectValue(value, "Error response")["error"];
			throw new Error(typeof error === "string" ? error : `Request failed: HTTP ${String(response.status)}`);
		}
		function conversationRevision(snapshot) {
			const turnEnds = [...snapshot.turnEnds.entries()].map(([turn, seq]) => `${String(turn)}:${String(seq)}`).join(",");
			return [
				snapshot.openState,
				snapshot.removed,
				snapshot.hasMore,
				turnEnds
			].join("|");
		}
		function lineageRevision(snapshot, sessionId) {
			let root = sessionId;
			const ancestorIds = /* @__PURE__ */ new Set();
			while (!ancestorIds.has(root)) {
				ancestorIds.add(root);
				const parent = snapshot.byId[root]?.parentId;
				if (parent === void 0 || snapshot.byId[parent] === void 0) break;
				root = parent;
			}
			const connected = [];
			for (const rawId of Object.keys(snapshot.byId).sort()) {
				const id = rawId;
				const seen = /* @__PURE__ */ new Set();
				let cursor = id;
				while (cursor !== void 0 && !seen.has(cursor)) {
					if (cursor === root) {
						connected.push(`${id}>${snapshot.byId[id]?.parentId ?? ""}`);
						break;
					}
					seen.add(cursor);
					cursor = snapshot.byId[cursor]?.parentId;
				}
			}
			return connected.join("|");
		}
		/** One stable controller is shared by all entries mounted for the same session. */
		var MessageEditController = class {
			sessionId;
			store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				status: "idle",
				error: null,
				pending: null,
				timeline: null,
				switchingTo: null,
				busy: false,
				regenerating: false,
				optimisticEdit: null
			});
			face;
			generation = 0;
			ctx;
			sessions;
			sessionSource;
			sessionSourceDispose;
			sessionRevision;
			listRevision = "";
			refreshScheduled = false;
			refreshTimer;
			observing = false;
			navigationWaits = /* @__PURE__ */ new Set();
			disposeObservation = void 0;
			inflight = null;
			rerunAfter = false;
			abort = null;
			disposed = false;
			users = 0;
			constructor(ctx, sessionId) {
				this.sessionId = sessionId;
				this.ctx = ctx;
				this.sessions = ctx.get("sessions");
				this.face = {
					hooks: { messageEdit: this.store },
					acquire: () => {
						this.users += 1;
						if (this.users === 1 && this.disposed) this.revive();
						return () => this.release();
					},
					load: () => {
						this.load();
					},
					edit: (message, text, cascade) => this.mutate({
						action: "edit",
						sessionId: this.sessionId,
						eventSeq: message.eventSeq,
						blockIndex: message.blockIndex,
						text,
						cascade
					}),
					retry: (turn, cascade) => this.mutate({
						action: "retry",
						sessionId: this.sessionId,
						turn,
						cascade
					}),
					reroll: () => this.mutate({
						action: "reroll",
						sessionId: this.sessionId
					}),
					previewDelete: async (eventSeq) => {
						const url = `${MESSAGE_EDIT_PATH}/delete-preview?sessionId=${encodeURIComponent(this.sessionId)}&eventSeq=${String(eventSeq)}`;
						return decodeDeletePreview(await responseValue(await fetch(url, {
							method: "GET",
							headers: { accept: "application/json" },
							cache: "no-store"
						})));
					},
					deleteMessage: (eventSeq, rollbackWorkspace) => this.mutate({
						action: "delete",
						sessionId: this.sessionId,
						eventSeq,
						rollbackWorkspace
					}),
					openVersion: (sessionId) => this.openWhenListed(sessionId),
					exportBranch: (format) => this.downloadTimeline(format)
				};
				this.observe();
			}
			parentVersionSnapshot() {
				const timeline = this.store.getSnapshot().timeline;
				if (timeline === null) return null;
				const current = timeline.versions.find((version) => version.current) ?? timeline.versions.at(-1) ?? null;
				return current === null ? null : {
					sessionId: current.sessionId,
					depth: current.depth
				};
			}
			appendStubVersion(childSessionId, operation) {
				const timeline = this.store.getSnapshot().timeline;
				if (timeline === null) return;
				const parent = this.parentVersionSnapshot();
				const parentId = parent?.sessionId ?? timeline.sessionId;
				const depth = (parent?.depth ?? 0) + 1;
				const eventSeq = operation.action === "edit" ? operation.eventSeq : void 0;
				const eventTurn = (eventSeq !== void 0 ? timeline.messages.find((candidate) => candidate.eventSeq === eventSeq) : void 0)?.turn ?? 0;
				const stamped = {
					sessionId: childSessionId,
					parentSessionId: parentId,
					createdAt: Date.now(),
					depth,
					current: true,
					onCurrentEffectPath: true,
					operation: operation.action,
					cascade: operation.action === "edit" || operation.action === "retry" ? operation.cascade : void 0,
					...operation.action === "edit" ? {
						targetTurn: eventTurn,
						targetEventSeq: operation.eventSeq,
						targetBlockIndex: operation.blockIndex,
						blockKind: "user"
					} : operation.action === "retry" ? { targetTurn: operation.turn } : {},
					current: true,
					onCurrentEffectPath: true
				};
				this.store.update((state) => {
					if (state.timeline === null) return;
					state.timeline = {
						...state.timeline,
						versions: [...state.timeline.versions.map((version) => ({
							...version,
							current: false,
							onCurrentEffectPath: false
						})), stamped],
						undoStack: [childSessionId, ...state.timeline.undoStack],
						redoSessionIds: []
					};
				});
			}
			downloadTimeline(format) {
				const snapshot = this.store.getSnapshot();
				if (snapshot.timeline === null) return;
				const timeline = snapshot.timeline;
				const payload = {
					sessionId: timeline.sessionId,
					exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
					versions: timeline.versions,
					messages: timeline.messages,
					retryableTurns: timeline.retryableTurns,
					undoStack: timeline.undoStack,
					redoSessionIds: timeline.redoSessionIds
				};
				if (format === "markdown") {
					const lines = [];
					lines.push(`# Timeline Export`);
					lines.push("");
					lines.push(`Session: ${payload.sessionId}`);
					lines.push(`Exported: ${payload.exportedAt}`);
					lines.push("");
					lines.push("---");
					lines.push("");
					lines.push("## Versions");
					lines.push("");
					for (const version of payload.versions) {
						const marker = version.current ? " [CURRENT]" : version.onCurrentEffectPath ? " [ON PATH]" : "";
						const label = version.operation ? `${version.operation} turn ${version.targetTurn ?? "?"}${marker}` : "Original";
						lines.push(`- ${label} \`${version.sessionId.slice(0, 12)}\``);
					}
					lines.push("");
					lines.push("---");
					lines.push("");
					lines.push("## Messages");
					lines.push("");
					for (const turn of payload.retryableTurns) {
						lines.push(`### Turn ${turn.turn}`);
						lines.push("");
						const messages = payload.messages.filter((message) => message.turn === turn.turn);
						for (const message of messages) {
							const kind = message.kind === "user" ? "User" : message.kind === "assistant.reasoning" ? "Assistant Reasoning" : "Assistant Response";
							lines.push(`**${kind}** \`${message.time ? new Date(message.time).toISOString() : ""}\``);
							lines.push("");
							lines.push(message.text || "(empty)");
							lines.push("");
						}
					}
					lines.push("---");
					lines.push("");
					lines.push("## JSON");
					lines.push("");
					lines.push("```json");
					lines.push(JSON.stringify(payload, null, 2));
					lines.push("```");
					lines.push("");
					const markdown = lines.join("\n");
					this.scheduleDownload(`timeline-${timeline.sessionId.slice(0, 8)}.md`, markdown, "text/markdown");
					return;
				}
				const json = JSON.stringify(payload, null, 2);
				this.scheduleDownload(`timeline-${timeline.sessionId.slice(0, 8)}.json`, json, "application/json");
			}
			scheduleDownload(filename, content, mimeType) {
				const blob = new Blob([content], { type: mimeType });
				const url = URL.createObjectURL(blob);
				if (typeof document === "undefined") {
					URL.revokeObjectURL(url);
					return;
				}
				try {
					const a = document.createElement("a");
					a.href = url;
					a.download = filename;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
				} finally {
					URL.revokeObjectURL(url);
				}
			}
			observe() {
				this.disposeObservation = this.ctx.effect(() => this.observeDependencies(), `message-edit-enhanced: observe ${this.sessionId}`);
			}
			release() {
				this.users -= 1;
				if (this.users <= 0) this.dispose();
			}
			/** Tear subscriptions down once no mounted entry uses this controller. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.generation += 1;
				if (this.refreshTimer !== void 0) {
					clearTimeout(this.refreshTimer);
					this.refreshTimer = void 0;
					this.refreshScheduled = false;
				}
				this.abort?.abort();
				this.abort = null;
				this.disposeObservation?.();
				this.disposeObservation = void 0;
			}
			/** Re-observe after a transient zero; the retained store keeps old data
			* until the immediate refetch below commits. */
			revive() {
				this.disposed = false;
				this.observe();
				this.refresh();
			}
			/** Bind to replaceable value sources instead of retaining a Session object. */
			observeDependencies() {
				this.observing = true;
				this.listRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
				this.bindSessionSource();
				const disposeList = this.sessions.list.subscribe(() => {
					const rebound = this.bindSessionSource();
					const nextRevision = lineageRevision(this.sessions.list.getSnapshot(), this.sessionId);
					if (nextRevision === this.listRevision && !rebound) return;
					this.listRevision = nextRevision;
					this.invalidate();
				});
				return () => {
					this.observing = false;
					this.generation += 1;
					disposeList();
					this.sessionSourceDispose?.();
					this.sessionSourceDispose = void 0;
					this.sessionSource = void 0;
					this.sessionRevision = void 0;
					for (const cancel of [...this.navigationWaits]) cancel();
				};
			}
			bindSessionSource() {
				const source = this.sessions.binding(this.sessionId)?.session;
				if (source === this.sessionSource) return false;
				this.sessionSourceDispose?.();
				this.sessionSource = source;
				this.sessionRevision = source === void 0 ? void 0 : conversationRevision(source.getSnapshot());
				if (source !== void 0) this.store.update((state) => {
					state.busy = source.getSnapshot().running;
				});
				this.sessionSourceDispose = source?.subscribe(() => {
					if (this.sessionSource !== source) return;
					const snapshot = source.getSnapshot();
					this.store.update((state) => {
						state.busy = snapshot.running;
					});
					const revision = conversationRevision(snapshot);
					if (revision === this.sessionRevision) return;
					this.sessionRevision = revision;
					this.invalidate();
				});
				return true;
			}
			invalidate() {
				if (!this.observing || this.store.getSnapshot().status === "idle" || this.refreshScheduled) return;
				this.refreshScheduled = true;
				this.refreshTimer = setTimeout(() => {
					this.refreshTimer = void 0;
					this.refreshScheduled = false;
					if (this.observing && this.store.getSnapshot().status !== "idle") this.refresh();
				}, REFRESH_DELAY_MS);
			}
			/** Invalidation-driven refetch: one in-flight request absorbs the demand
			* and commits a single rerun once it settles. */
			refresh() {
				if (this.disposed) return;
				if (this.inflight !== null) {
					this.rerunAfter = true;
					return;
				}
				this.load();
			}
			/** Refetch the full value-level projection; concurrent callers share one
			* request, and an invalidation during flight schedules exactly one rerun. */
			async load() {
				if (this.disposed) return;
				if (this.inflight !== null) return this.inflight;
				const generation = ++this.generation;
				this.abort?.abort();
				const abort = new AbortController();
				this.abort = abort;
				this.store.update((state) => {
					state.status = "loading";
					state.error = null;
				});
				const run = this.performLoad(generation, abort);
				this.inflight = run;
				try {
					await run;
				} finally {
					if (this.inflight === run) this.inflight = null;
					if (this.rerunAfter && !this.disposed) {
						this.rerunAfter = false;
						this.load();
					}
				}
			}
			async performLoad(generation, abort) {
				try {
					const timeline = decodeTimeline(await responseValue(await fetch(`${MESSAGE_EDIT_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`, {
						method: "GET",
						headers: { accept: "application/json" },
						cache: "no-store",
						signal: abort.signal
					})));
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "ready";
						state.error = null;
						state.timeline = timeline;
						if (state.optimisticEdit !== null) {
							if (timeline.messages.some((message) => message.turn === state.optimisticEdit?.turn)) {
								state.optimisticEdit = null;
								state.regenerating = false;
							}
						}
					});
				} catch (error) {
					if (generation !== this.generation) return;
					this.store.update((state) => {
						state.status = "error";
						state.error = messageOf(error);
					});
				}
			}
			/** Refresh only controllers whose projection has already been requested. */
			refreshIfLoaded() {
				if (this.disposed || this.store.getSnapshot().status === "idle") return;
				if (this.store.getSnapshot().switchingTo !== null) return;
				this.refresh();
			}
			async mutate(operation) {
				const current = this.store.getSnapshot();
				if (current.pending !== null || current.status !== "ready") return false;
				if (current.busy || current.regenerating) {
					this.store.update((state) => {
						state.error = "The assistant is still responding; wait for it to finish before editing.";
					});
					return false;
				}
				this.store.update((state) => {
					state.pending = operation.action;
					state.error = null;
				});
				try {
					const result = decodeOperationResult(await responseValue(await fetch(MESSAGE_EDIT_PATH, {
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json"
						},
						body: JSON.stringify(operation)
					})));
					if (this.disposed) return true;
					this.store.update((state) => {
						state.pending = null;
					});
					if (result.sessionId !== this.sessionId) {
						try {
							this.store.update((state) => {
								state.switchingTo = result.sessionId;
							});
							await this.openWhenListed(result.sessionId);
						} finally {
							this.store.update((state) => {
								state.switchingTo = null;
							});
						}
						this.appendStubVersion(result.sessionId, operation);
						return true;
					}
					if (operation.action === "delete") {
						this.refreshIfLoaded();
						return true;
					}
					if (operation.action === "edit") {
						const edit = operation;
						const nextTurn = this.nextTurnAfterCurrent();
						this.store.update((state) => {
							state.optimisticEdit = {
								turn: nextTurn,
								eventSeq: edit.eventSeq,
								text: edit.text
							};
							state.regenerating = true;
						});
					}
					return true;
				} catch (error) {
					if (this.disposed) return false;
					this.store.update((state) => {
						state.pending = null;
						state.regenerating = false;
						state.optimisticEdit = null;
						state.error = messageOf(error);
					});
					return false;
				}
			}
			/** Next turn number the in-place regeneration will open. */
			nextTurnAfterCurrent() {
				const timeline = this.store.getSnapshot().timeline;
				if (timeline === null) return 1;
				return timeline.messages.reduce((max, message) => Math.max(max, message.turn), 0) + 1;
			}
			/** Session-list publication is the reactive dependency for navigation. */
			openWhenListed(sessionId) {
				if (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) {
					this.sessions.open(sessionId);
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					let settled = false;
					let dispose = () => {};
					const finish = (open) => {
						if (settled) return;
						settled = true;
						dispose();
						this.navigationWaits.delete(cancel);
						if (open) this.sessions.open(sessionId);
						resolve();
					};
					const cancel = () => {
						finish(false);
					};
					this.navigationWaits.add(cancel);
					dispose = this.sessions.list.subscribe(() => {
						if (this.sessions.list.getSnapshot().byId[sessionId] === void 0) return;
						finish(true);
					});
					if (this.sessions.list.getSnapshot().byId[sessionId] !== void 0) finish(true);
				});
			}
		};
		//#endregion
		//#region \0dsh-css:/home/silini/tools/deepseek plugins/dsh-message-edit-enhanced/src/client/InlineMessageEdit.module.css.mjs
		const css$2 = ".D60d8a_overlay{z-index:1000;background:var(--dsw-alias-bg-mask,#00000073);justify-content:center;align-items:center;display:flex;position:fixed;inset:0}.D60d8a_panel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;width:560px;padding:14px 16px}.D60d8a_title{color:var(--dsw-alias-label-primary);padding:4px 0 10px;font-size:13px}.D60d8a_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);width:100%;min-height:160px;color:var(--dsw-alias-label-primary);font:inherit;resize:vertical;border-radius:8px;padding:10px}.D60d8a_footer{justify-content:flex-end;gap:8px;padding:10px 0 0;display:flex}.D60d8a_footer button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-hover);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;padding:6px 14px}.D60d8a_iconButton{width:20px;height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:4px;justify-content:center;align-items:center;padding:2px;display:inline-flex}.D60d8a_iconButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-hover)}.D60d8a_picker{flex-direction:column;gap:6px;padding:4px 0 12px;display:flex}.D60d8a_pickerItem{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-hover);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;border-radius:6px;padding:8px 10px;font-size:12px}.D60d8a_pickerItem:hover{background:var(--dsw-alias-bg-module-platform)}.D60d8a_pickerItemActive{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-hover);color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:6px;align-self:flex-end;padding:6px 14px}";
		const tagId$2 = "dsh-message-edit-enhanced/InlineMessageEdit.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-message-edit-enhanced";
			tag.dataset.pluginCss = tagId$2;
			tag.textContent = css$2;
			document.head.appendChild(tag);
		}
		var InlineMessageEdit_module_css_default = {
			"title": "D60d8a_title",
			"input": "D60d8a_input",
			"panel": "D60d8a_panel",
			"iconButton": "D60d8a_iconButton",
			"picker": "D60d8a_picker",
			"overlay": "D60d8a_overlay",
			"pickerItem": "D60d8a_pickerItem",
			"pickerItemActive": "D60d8a_pickerItemActive",
			"footer": "D60d8a_footer"
		};
		//#endregion
		//#region src/client/InlineMessageEdit.tsx
		/**
		* Message-row edit affordance: injects retry + edit icon buttons into each
		* settled message's icon-actions row (the official MessageIconActions has no
		* plugin slot, so injection rides a MutationObserver over action rows).
		* Icons are the official outline-16 SVGs inlined to avoid bundling the
		* primitives package.
		*/
		const BLOCK_TITLE = {
			user: "Edit User Message",
			"assistant.reasoning": "Edit Assistant Reasoning",
			"assistant.response": "Edit Assistant Response"
		};
		const STYLE = {
			overlay: InlineMessageEdit_module_css_default["overlay"] ?? "",
			panel: InlineMessageEdit_module_css_default["panel"] ?? "",
			title: InlineMessageEdit_module_css_default["title"] ?? "",
			input: InlineMessageEdit_module_css_default["input"] ?? "",
			footer: InlineMessageEdit_module_css_default["footer"] ?? "",
			iconButton: InlineMessageEdit_module_css_default["iconButton"] ?? "",
			picker: InlineMessageEdit_module_css_default["picker"] ?? "",
			pickerItem: InlineMessageEdit_module_css_default["pickerItem"] ?? "",
			pickerItemActive: InlineMessageEdit_module_css_default["pickerItemActive"] ?? ""
		};
		/** Official ic_ds_refresh_outline_16 path (dsh-client-ui-primitives). */
		const REFRESH_PATH = "M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z";
		/** Official ic_ds_edit_outline_16 path (dsh-client-ui-primitives). */
		const EDIT_PATH = "M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z";
		function svgIcon(path) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
			p.setAttribute("d", path);
			p.setAttribute("fill", "currentColor");
			svg.appendChild(p);
			return svg;
		}
		function blockTitle(kind) {
			return BLOCK_TITLE[kind] ?? "Edit Message";
		}
		/** Mount one editor DOM effect and return its exact inverse. */
		function mountEditor(block, edit, close) {
			const overlay = document.createElement("div");
			overlay.className = STYLE.overlay;
			const panel = document.createElement("div");
			panel.className = STYLE.panel;
			const title = document.createElement("div");
			title.className = STYLE.title;
			title.textContent = blockTitle(block.kind);
			const input = document.createElement("textarea");
			input.className = STYLE.input;
			input.value = block.text;
			const footer = document.createElement("div");
			footer.className = STYLE.footer;
			const save = document.createElement("button");
			save.textContent = "Save";
			const cancel = document.createElement("button");
			cancel.textContent = "Cancel";
			footer.append(save, cancel);
			panel.append(title, input, footer);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
			let mounted = true;
			let saving = false;
			const saveEdit = () => {
				if (saving) return;
				saving = true;
				save.disabled = true;
				edit(block, input.value, "truncate").then((applied) => {
					if (!mounted) return;
					if (applied) {
						close();
						return;
					}
					saving = false;
					save.disabled = false;
				});
			};
			const cancelEdit = () => {
				close();
			};
			const dismiss = (event) => {
				if (event.target === overlay) close();
			};
			save.addEventListener("click", saveEdit);
			cancel.addEventListener("click", cancelEdit);
			overlay.addEventListener("click", dismiss);
			return () => {
				mounted = false;
				save.removeEventListener("click", saveEdit);
				cancel.removeEventListener("click", cancelEdit);
				overlay.removeEventListener("click", dismiss);
				overlay.remove();
			};
		}
		/** Mount one block-picker DOM effect and return its exact inverse. */
		function mountPicker(blocks, select, close) {
			const overlay = document.createElement("div");
			overlay.className = STYLE.overlay;
			const panel = document.createElement("div");
			panel.className = STYLE.panel;
			const title = document.createElement("div");
			title.className = STYLE.title;
			title.textContent = blocks.some((block) => block.kind === "user") ? "Edit Message" : "Edit Assistant Message";
			const picker = document.createElement("div");
			picker.className = STYLE.picker;
			const itemListeners = [];
			for (const block of blocks) {
				const item = document.createElement("button");
				item.className = STYLE.pickerItem;
				item.textContent = `${blockTitle(block.kind)}: ${block.text.slice(0, 24)}${block.text.length > 24 ? "…" : ""}`;
				const listener = () => {
					select(block);
				};
				item.addEventListener("click", listener);
				itemListeners.push({
					item,
					listener
				});
				picker.appendChild(item);
			}
			const cancel = document.createElement("button");
			cancel.textContent = "Cancel";
			cancel.className = STYLE.pickerItemActive;
			const cancelPicker = () => {
				close();
			};
			cancel.addEventListener("click", cancelPicker);
			panel.append(title, picker, cancel);
			overlay.appendChild(panel);
			document.body.appendChild(overlay);
			return () => {
				for (const { item, listener } of itemListeners) item.removeEventListener("click", listener);
				cancel.removeEventListener("click", cancelPicker);
				overlay.remove();
			};
		}
		/** Compose every overlay with a single idempotent active inverse. */
		function createOverlayHost(edit) {
			let active;
			const mount = (effect) => {
				active?.();
				let cleanup = () => {};
				let mounted = true;
				const close = () => {
					if (!mounted) return;
					mounted = false;
					cleanup();
					if (active === close) active = void 0;
				};
				active = close;
				try {
					cleanup = effect(close);
				} catch (error) {
					active = void 0;
					mounted = false;
					throw error;
				}
			};
			const editBlock = (block) => {
				mount((close) => mountEditor(block, edit, close));
			};
			const chooseBlock = (blocks) => {
				mount((close) => mountPicker(blocks, (block) => {
					close();
					editBlock(block);
				}, close));
			};
			return {
				editBlock,
				chooseBlock,
				dispose: () => {
					active?.();
				}
			};
		}
		/** Inject retry + edit icon buttons into each message action row. */
		function InlineMessageEdit({ messages, edit, retry }) {
			(0, react.useEffect)(() => {
				const cleanups = [];
				const overlays = createOverlayHost(edit);
				let observer;
				let alive = true;
				let frame;
				let scheduled = false;
				const sync = () => {
					const actionRows = Array.from(document.querySelectorAll("[class*=\"actions\"]"));
					const claimedEvents = /* @__PURE__ */ new Set();
					for (const row of actionRows) {
						const marker = row;
						if (marker.__messageEditInjected === true) {
							if (marker.__messageEditEventSeq !== void 0) claimedEvents.add(marker.__messageEditEventSeq);
							continue;
						}
						const text = (row.parentElement?.parentElement?.textContent ?? "").trim();
						if (text.length === 0) continue;
						const eventSeq = [...new Set(messages.filter((message) => message.text.length > 0 && text.includes(message.text.slice(0, 24))).map((message) => message.eventSeq))].find((candidate) => !claimedEvents.has(candidate));
						if (eventSeq === void 0) continue;
						const blocks = messages.filter((message) => message.eventSeq === eventSeq);
						if (blocks.length === 0) continue;
						const previousMarker = marker.__messageEditInjected;
						const previousEventSeq = marker.__messageEditEventSeq;
						marker.__messageEditInjected = true;
						marker.__messageEditEventSeq = eventSeq;
						claimedEvents.add(eventSeq);
						const editButton = document.createElement("button");
						editButton.className = STYLE.iconButton;
						editButton.setAttribute("aria-label", "Edit message");
						editButton.title = "Edit message";
						editButton.appendChild(svgIcon(EDIT_PATH));
						const editMessage = () => {
							if (blocks.length === 1 && blocks[0] !== void 0) overlays.editBlock(blocks[0]);
							else overlays.chooseBlock(blocks);
						};
						editButton.addEventListener("click", editMessage);
						const retryButton = document.createElement("button");
						retryButton.className = STYLE.iconButton;
						retryButton.setAttribute("aria-label", "Retry this turn");
						retryButton.title = "Retry this turn";
						retryButton.appendChild(svgIcon(REFRESH_PATH));
						const turn = blocks[0]?.turn;
						const retryTurn = () => {
							if (turn !== void 0) retry(turn, "truncate");
						};
						retryButton.addEventListener("click", retryTurn);
						const lastOfficial = Array.from(row.querySelectorAll("button")).filter((button) => button !== editButton && button !== retryButton).at(-1);
						if (lastOfficial !== void 0) {
							lastOfficial.insertAdjacentElement("afterend", retryButton);
							lastOfficial.insertAdjacentElement("afterend", editButton);
						} else {
							row.appendChild(editButton);
							row.appendChild(retryButton);
						}
						cleanups.push(() => {
							editButton.removeEventListener("click", editMessage);
							retryButton.removeEventListener("click", retryTurn);
							editButton.remove();
							retryButton.remove();
							if (previousMarker === void 0) delete marker.__messageEditInjected;
							else marker.__messageEditInjected = previousMarker;
							if (previousEventSeq === void 0) delete marker.__messageEditEventSeq;
							else marker.__messageEditEventSeq = previousEventSeq;
						});
					}
				};
				sync();
				observer = new MutationObserver(() => {
					if (!alive || scheduled) return;
					scheduled = true;
					frame = requestAnimationFrame(() => {
						frame = void 0;
						scheduled = false;
						if (alive) sync();
					});
				});
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					alive = false;
					if (frame !== void 0) cancelAnimationFrame(frame);
					observer?.disconnect();
					overlays.dispose();
					for (const cleanup of cleanups.reverse()) cleanup();
				};
			}, [
				messages,
				edit,
				retry
			]);
			return null;
		}
		//#endregion
		//#region \0dsh-css:/home/silini/tools/deepseek plugins/dsh-message-edit-enhanced/src/client/MessageEditHeader.module.css.mjs
		const css$1 = ".EM6NxG_root{align-items:center;gap:4px;display:inline-flex}.EM6NxG_iconButton,.EM6NxG_rerollButton{box-sizing:border-box;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border:0}.EM6NxG_iconButton{border-radius:50%;justify-content:center;align-items:center;width:28px;height:28px;font-size:16px;line-height:20px;display:inline-flex}.EM6NxG_rerollButton{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;height:28px;padding:0 10px;font-size:12px;line-height:18px}.EM6NxG_iconButton:hover:not(:disabled),.EM6NxG_rerollButton:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.EM6NxG_iconButton:focus-visible,.EM6NxG_rerollButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.EM6NxG_iconButton:disabled,.EM6NxG_rerollButton:disabled{cursor:default;opacity:.4}.EM6NxG_counter{min-width:108px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:11px;line-height:18px}@media (width<=760px){.EM6NxG_counter{display:none}}";
		const tagId$1 = "dsh-message-edit-enhanced/MessageEditHeader.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-message-edit-enhanced";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var MessageEditHeader_module_css_default = {
			"counter": "EM6NxG_counter",
			"iconButton": "EM6NxG_iconButton",
			"rerollButton": "EM6NxG_rerollButton",
			"root": "EM6NxG_root"
		};
		//#endregion
		//#region src/client/MessageEditHeader.tsx
		/** Header contribution shared with the Timeline controller. */
		function MessageEditHeader({ useMessageEdit, acquire, load, openVersion, reroll, edit, retry }) {
			const state = useMessageEdit((value) => value);
			(0, react.useEffect)(() => {
				const release = acquire();
				load();
				return release;
			}, [acquire, load]);
			const timeline = state.timeline;
			const versions = state.timeline?.versions ?? [];
			const undoSessionId = timeline?.undoStack[0];
			const redoSessionId = timeline?.redoSessionIds.at(-1);
			const effectDepth = timeline?.undoStack.length ?? 0;
			const busy = state.pending !== null || state.status !== "ready";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(InlineMessageEdit, {
				messages: state.status === "ready" && state.pending === null ? timeline?.messages ?? [] : [],
				edit,
				retry
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditHeader_module_css_default["root"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["iconButton"],
						"aria-label": "Undo current version effect",
						title: "Undo current effect, keep earlier effects",
						disabled: undoSessionId === void 0 || busy,
						onClick: () => {
							if (undoSessionId !== void 0) openVersion(undoSessionId);
						},
						children: "←"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: MessageEditHeader_module_css_default["counter"],
						children: versions.length === 0 ? "Effects —" : `Effects: ${String(effectDepth)} deep · ${String(versions.length)} versions`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["iconButton"],
						"aria-label": "Redo next version effect",
						title: timeline !== null && timeline.redoSessionIds.length > 1 ? `Redo latest effect (${String(timeline.redoSessionIds.length - 1)} other branch(es))` : "Redo next effect",
						disabled: redoSessionId === void 0 || busy,
						onClick: () => {
							if (redoSessionId !== void 0) openVersion(redoSessionId);
						},
						children: "→"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: MessageEditHeader_module_css_default["rerollButton"],
						disabled: busy || state.timeline === null,
						onClick: () => {
							reroll();
						},
						children: state.pending === "reroll" ? "Regenerating…" : "Regenerate"
					})
				]
			})] });
		}
		//#endregion
		//#region \0dsh-css:/home/silini/tools/deepseek plugins/dsh-message-edit-enhanced/src/client/MessageEditTimelineView.module.css.mjs
		const css = ".kxmlFa_root{box-sizing:border-box;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:24px;overflow:auto}.kxmlFa_pageHeader{justify-content:space-between;align-items:flex-start;gap:20px;max-width:1480px;margin:0 auto 16px;display:flex}.kxmlFa_title,.kxmlFa_intro,.kxmlFa_subtitle,.kxmlFa_notice,.kxmlFa_error,.kxmlFa_empty,.kxmlFa_turnTitle,.kxmlFa_turnPreview,.kxmlFa_messageText{margin:0}.kxmlFa_title{font-size:22px;font-weight:600;line-height:30px}.kxmlFa_intro{max-width:700px;color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:13px;line-height:20px}.kxmlFa_headerActions{flex:none;align-items:flex-end;gap:8px;display:flex}.kxmlFa_cascadeField{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;font-size:11px;line-height:16px;display:flex}.kxmlFa_select,.kxmlFa_textarea,.kxmlFa_primaryButton,.kxmlFa_secondaryButton,.kxmlFa_textButton,.kxmlFa_versionButton,.kxmlFa_filterSearch,.kxmlFa_filterChip{box-sizing:border-box;font:inherit}.kxmlFa_select,.kxmlFa_textarea,.kxmlFa_filterSearch{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:8px}.kxmlFa_select{height:34px;padding:0 30px 0 9px;font-size:12px}.kxmlFa_filterSearch{width:100%;height:32px;padding:0 10px;font-size:12px}.kxmlFa_filterSearch:focus{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.kxmlFa_primaryButton,.kxmlFa_secondaryButton,.kxmlFa_textButton,.kxmlFa_versionButton,.kxmlFa_filterChip{cursor:pointer;border:0}.kxmlFa_primaryButton,.kxmlFa_secondaryButton,.kxmlFa_filterChip{border-radius:14px;justify-content:center;align-items:center;min-height:28px;padding:0 10px;font-size:11px;line-height:18px;display:inline-flex}.kxmlFa_primaryButton{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}.kxmlFa_primaryButton:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.kxmlFa_secondaryButton{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.kxmlFa_secondaryButton:hover:not(:disabled),.kxmlFa_textButton:hover:not(:disabled),.kxmlFa_versionButton:hover:not(:disabled),.kxmlFa_filterChip:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.kxmlFa_primaryButton:disabled,.kxmlFa_secondaryButton:disabled,.kxmlFa_textButton:disabled,.kxmlFa_versionButton:disabled,.kxmlFa_filterChip:disabled,.kxmlFa_select:disabled,.kxmlFa_filterSearch:disabled{cursor:default;opacity:.45}.kxmlFa_primaryButton:focus-visible,.kxmlFa_secondaryButton:focus-visible,.kxmlFa_textButton:focus-visible,.kxmlFa_versionButton:focus-visible,.kxmlFa_filterChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.kxmlFa_notice,.kxmlFa_error{max-width:1480px;margin:0 auto 10px;font-size:12px;line-height:18px}.kxmlFa_notice{color:var(--dsw-alias-state-warn-label)}.kxmlFa_error{color:var(--dsw-alias-state-error-primary)}.kxmlFa_status{box-sizing:border-box;width:100%;height:100%;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);flex-direction:column;align-items:flex-start;gap:12px;padding:24px;display:flex}.kxmlFa_status .kxmlFa_error{margin:0}.kxmlFa_columns{grid-template-columns:minmax(280px,.72fr) minmax(520px,1.75fr);align-items:start;gap:18px;max-width:1480px;margin:0 auto;display:grid}.kxmlFa_versionsPanel,.kxmlFa_turnsPanel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;min-width:0;padding:16px}.kxmlFa_versionsPanel{position:sticky;top:0}.kxmlFa_sectionHeading{justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;display:flex}.kxmlFa_filterBar{flex-direction:column;gap:8px;margin-bottom:12px;display:flex}.kxmlFa_filterChips{flex-wrap:wrap;gap:6px;display:flex}.kxmlFa_filterChip{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:12px;min-height:26px;padding:2px 8px;font-size:11px;line-height:18px}.kxmlFa_filterChip[data-active]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform)}.kxmlFa_turnFilterBar{margin-bottom:12px}.kxmlFa_effectControls{background:var(--dsw-alias-bg-module-platform);border-radius:9px;flex-direction:column;gap:8px;margin-bottom:12px;padding:10px;display:flex}.kxmlFa_effectDepth{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}.kxmlFa_effectButtons{flex-wrap:wrap;gap:6px;display:flex}.kxmlFa_effectButtons .kxmlFa_secondaryButton{min-height:28px;padding:0 10px;font-size:11px}.kxmlFa_subtitle{font-size:16px;font-weight:500;line-height:24px}.kxmlFa_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.kxmlFa_versionList,.kxmlFa_turnList{margin:0;padding:0;list-style:none}.kxmlFa_versionListScroller{min-height:120px;max-height:520px;overflow:auto}.kxmlFa_versionList{width:100%;position:relative}.kxmlFa_versionItem{--message-edit-enhanced-depth:0;padding-left:calc(var(--message-edit-enhanced-depth) * 14px);position:relative}.kxmlFa_versionButton{width:100%;min-width:0;color:var(--dsw-alias-label-secondary);text-align:left;background:0 0;border-radius:9px;align-items:flex-start;gap:9px;padding:9px;display:flex;position:relative}.kxmlFa_versionButton[data-current]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);opacity:1}.kxmlFa_versionButton:not([data-current]) .kxmlFa_pathBadge{opacity:.8}.kxmlFa_versionLine{background:var(--dsw-alias-border-l2);width:1px;position:absolute;top:0;bottom:0;left:14px}.kxmlFa_versionDot{z-index:1;border:2px solid var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;width:7px;height:7px;margin-top:6px}.kxmlFa_versionButton[data-current] .kxmlFa_versionDot{border-color:var(--dsw-alias-bg-module-platform);background:var(--dsw-alias-brand-primary)}.kxmlFa_versionMain{flex-direction:column;flex:1;min-width:0;display:flex}.kxmlFa_versionTitle{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.kxmlFa_versionMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;overflow:hidden}.kxmlFa_versionDiff{color:var(--dsw-alias-label-tertiary);flex-direction:column;gap:2px;margin-top:5px;font-size:10px;line-height:15px;display:flex}.kxmlFa_versionDiff span{-webkit-line-clamp:2;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}.kxmlFa_currentBadge,.kxmlFa_pathBadge,.kxmlFa_kindBadge{border-radius:9px;flex:none;padding:1px 6px;font-size:10px;line-height:17px}.kxmlFa_currentBadge{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}.kxmlFa_pathBadge{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}.kxmlFa_turnList{flex-direction:column;gap:14px;display:flex}.kxmlFa_turnSection{border:1px solid var(--dsw-alias-border-l2);border-radius:11px;padding:13px}.kxmlFa_turnHeader,.kxmlFa_messageHeader,.kxmlFa_editorActions{justify-content:space-between;align-items:center;gap:10px;display:flex}.kxmlFa_turnHeader{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:flex-start;padding-bottom:11px}.kxmlFa_turnTitle{font-size:14px;font-weight:500;line-height:22px}.kxmlFa_turnPreview{max-width:700px;color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:2;white-space:pre-wrap;-webkit-box-orient:vertical;font-size:11px;line-height:17px;display:-webkit-box;overflow:hidden}.kxmlFa_messageList{flex-direction:column;gap:8px;margin-top:10px;display:flex}.kxmlFa_messageCard{background:var(--dsw-alias-bg-module-platform);border-radius:9px;padding:10px}.kxmlFa_messageHeader{justify-content:flex-start}.kxmlFa_kindBadge{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}.kxmlFa_kindBadge[data-kind=assistant\\.reasoning]{color:var(--dsw-alias-label-tertiary)}.kxmlFa_messageTime{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:17px}.kxmlFa_textButton{color:var(--dsw-alias-label-secondary);background:0 0;border-radius:12px;margin-left:auto;padding:3px 8px;font-size:11px;line-height:17px}.kxmlFa_messageText{max-height:220px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:7px;font-family:inherit;font-size:12px;line-height:19px;overflow:auto}.kxmlFa_editor{margin-top:8px}.kxmlFa_textarea{resize:vertical;width:100%;min-height:120px;padding:9px;font-size:12px;line-height:19px}.kxmlFa_editorActions{margin-top:8px}.kxmlFa_editorHint{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}.kxmlFa_empty{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);border-radius:10px;padding:18px;font-size:13px;line-height:20px}.kxmlFa_versionExpand{background:var(--dsw-alias-bg-module-hover);width:24px;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;margin-left:8px;font-size:10px;line-height:1;display:flex}.kxmlFa_versionExpand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.kxmlFa_versionExpand:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.kxmlFa_versionDiffPanel{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:8px;padding:10px;animation:.15s ease-out kxmlFa_slideDown}@keyframes kxmlFa_slideDown{0%{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}.kxmlFa_versionDiffHeader{border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:8px;padding-bottom:8px}.kxmlFa_diffLegend{color:var(--dsw-alias-label-tertiary);gap:12px;font-size:10px;display:flex}.kxmlFa_diffLegend span{border-radius:4px;padding:1px 6px}.kxmlFa_diffDelete{background:var(--dsw-alias-state-error-bg);color:var(--dsw-alias-state-error-primary)}.kxmlFa_diffInsert{background:var(--dsw-alias-state-success-bg);color:var(--dsw-alias-state-success-primary)}.kxmlFa_diffEqual{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}.kxmlFa_versionDiffContent{background:var(--dsw-alias-bg-layer-1);white-space:pre-wrap;word-wrap:break-word;border-radius:6px;max-height:300px;margin:0;padding:8px;font-family:inherit;font-size:12px;line-height:1.6;overflow:auto}.kxmlFa_diffDelete{background:var(--dsw-alias-state-error-bg);color:var(--dsw-alias-state-error-primary);border-radius:2px;padding:0 2px;text-decoration:line-through}.kxmlFa_diffInsert{background:var(--dsw-alias-state-success-bg);color:var(--dsw-alias-state-success-primary);border-radius:2px;padding:0 2px}.kxmlFa_diffEqual{color:var(--dsw-alias-label-secondary)}.kxmlFa_versionPin{width:26px;height:26px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;margin-left:8px;padding:0;font-size:14px;line-height:1;display:inline-flex}.kxmlFa_versionPin:hover{background:var(--dsw-alias-bg-module-hover);color:var(--dsw-alias-brand-primary)}.kxmlFa_versionPin:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}.kxmlFa_versionTags{flex-wrap:wrap;gap:4px;margin-top:4px;display:inline-flex}.kxmlFa_versionTag{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;font-size:10px;line-height:16px}.kxmlFa_versionNote{color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:11px;font-style:italic;line-height:16px;display:block}@media (width<=1000px){.kxmlFa_columns{grid-template-columns:1fr}.kxmlFa_versionsPanel{position:static}}@media (width<=680px){.kxmlFa_root{padding:16px}.kxmlFa_pageHeader,.kxmlFa_headerActions,.kxmlFa_turnHeader,.kxmlFa_editorActions{flex-direction:column;align-items:stretch}.kxmlFa_headerActions,.kxmlFa_primaryButton,.kxmlFa_secondaryButton{width:100%}}.kxmlFa_optimisticMessage{background:var(--dsw-alias-bg-module-platform);border:1px dashed var(--dsw-alias-border-strong);border-radius:9px;flex-direction:column;gap:6px;padding:10px;display:flex}.kxmlFa_optimisticKind{color:var(--dsw-alias-label-secondary);font-size:12px}.kxmlFa_optimisticText{white-space:pre-wrap;overflow-wrap:anywhere}.kxmlFa_optimisticPulse{color:var(--dsw-alias-label-tertiary);align-self:flex-start;font-size:12px;animation:1.2s ease-in-out infinite kxmlFa_messageEditOptimisticPulse}@keyframes kxmlFa_messageEditOptimisticPulse{0%,to{opacity:.55}50%{opacity:1}}.kxmlFa_dialogOverlay{z-index:60;background:#00000073;justify-content:center;align-items:center;display:flex;position:fixed;inset:0}.kxmlFa_dialog{background:var(--dsw-alias-bg-module-platform);border-radius:12px;flex-direction:column;gap:10px;width:min(560px,100vw - 48px);max-height:min(80vh,640px);padding:18px;display:flex;overflow-y:auto;box-shadow:0 12px 40px #0000004d}.kxmlFa_dialogTitle{margin:0;font-size:16px}.kxmlFa_dialogText{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px}.kxmlFa_dialogQuote{overflow-wrap:anywhere;white-space:pre-wrap;background:var(--dsw-alias-bg-layer-1);border-radius:8px;max-height:120px;margin:0;padding:8px;font-size:12px;overflow-y:auto}.kxmlFa_dialogFacts{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:4px;margin:0;padding-left:18px;font-size:13px;display:flex}.kxmlFa_fileList{background:var(--dsw-alias-bg-layer-1);border-radius:8px;flex-direction:column;gap:2px;max-height:140px;padding:8px;display:flex;overflow-y:auto}.kxmlFa_fileRow{align-items:center;gap:8px;font-size:12px;display:flex}.kxmlFa_fileChange{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:5px;flex:none;padding:1px 6px;font-size:11px}.kxmlFa_fileChange[data-change=remove]{color:var(--dsw-alias-state-error-primary)}.kxmlFa_filePath{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.kxmlFa_dialogCheck{align-items:center;gap:8px;font-size:13px;display:flex}.kxmlFa_dialogWarning{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px}.kxmlFa_dialogActions{justify-content:flex-end;gap:8px;margin-top:4px;display:flex}.kxmlFa_dangerButton{cursor:pointer;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:#fff;border-radius:9px;padding:7px 14px}.kxmlFa_dangerButton:disabled{opacity:.55;cursor:not-allowed}.kxmlFa_textButton[data-danger]{color:var(--dsw-alias-state-error-primary)}";
		const tagId = "dsh-message-edit-enhanced/MessageEditTimelineView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-message-edit-enhanced";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var MessageEditTimelineView_module_css_default = {
			"versionButton": "kxmlFa_versionButton",
			"pathBadge": "kxmlFa_pathBadge",
			"status": "kxmlFa_status",
			"versionDiff": "kxmlFa_versionDiff",
			"diffInsert": "kxmlFa_diffInsert",
			"subtitle": "kxmlFa_subtitle",
			"fileList": "kxmlFa_fileList",
			"filePath": "kxmlFa_filePath",
			"effectButtons": "kxmlFa_effectButtons",
			"currentBadge": "kxmlFa_currentBadge",
			"turnHeader": "kxmlFa_turnHeader",
			"effectDepth": "kxmlFa_effectDepth",
			"slideDown": "kxmlFa_slideDown",
			"versionTag": "kxmlFa_versionTag",
			"versionTitle": "kxmlFa_versionTitle",
			"textButton": "kxmlFa_textButton",
			"sectionHeading": "kxmlFa_sectionHeading",
			"turnSection": "kxmlFa_turnSection",
			"turnTitle": "kxmlFa_turnTitle",
			"turnPreview": "kxmlFa_turnPreview",
			"messageCard": "kxmlFa_messageCard",
			"dialogText": "kxmlFa_dialogText",
			"dialogCheck": "kxmlFa_dialogCheck",
			"error": "kxmlFa_error",
			"messageText": "kxmlFa_messageText",
			"cascadeField": "kxmlFa_cascadeField",
			"filterBar": "kxmlFa_filterBar",
			"dialogQuote": "kxmlFa_dialogQuote",
			"editorActions": "kxmlFa_editorActions",
			"versionListScroller": "kxmlFa_versionListScroller",
			"primaryButton": "kxmlFa_primaryButton",
			"headerActions": "kxmlFa_headerActions",
			"versionMain": "kxmlFa_versionMain",
			"versionExpand": "kxmlFa_versionExpand",
			"versionLine": "kxmlFa_versionLine",
			"versionMeta": "kxmlFa_versionMeta",
			"messageHeader": "kxmlFa_messageHeader",
			"messageList": "kxmlFa_messageList",
			"editor": "kxmlFa_editor",
			"count": "kxmlFa_count",
			"filterSearch": "kxmlFa_filterSearch",
			"filterChip": "kxmlFa_filterChip",
			"versionDot": "kxmlFa_versionDot",
			"filterChips": "kxmlFa_filterChips",
			"title": "kxmlFa_title",
			"notice": "kxmlFa_notice",
			"intro": "kxmlFa_intro",
			"versionDiffPanel": "kxmlFa_versionDiffPanel",
			"versionsPanel": "kxmlFa_versionsPanel",
			"columns": "kxmlFa_columns",
			"versionDiffHeader": "kxmlFa_versionDiffHeader",
			"textarea": "kxmlFa_textarea",
			"effectControls": "kxmlFa_effectControls",
			"diffEqual": "kxmlFa_diffEqual",
			"diffLegend": "kxmlFa_diffLegend",
			"versionDiffContent": "kxmlFa_versionDiffContent",
			"versionNote": "kxmlFa_versionNote",
			"optimisticMessage": "kxmlFa_optimisticMessage",
			"versionList": "kxmlFa_versionList",
			"optimisticKind": "kxmlFa_optimisticKind",
			"optimisticText": "kxmlFa_optimisticText",
			"dialogTitle": "kxmlFa_dialogTitle",
			"diffDelete": "kxmlFa_diffDelete",
			"fileRow": "kxmlFa_fileRow",
			"editorHint": "kxmlFa_editorHint",
			"dialogWarning": "kxmlFa_dialogWarning",
			"pageHeader": "kxmlFa_pageHeader",
			"turnsPanel": "kxmlFa_turnsPanel",
			"dialogOverlay": "kxmlFa_dialogOverlay",
			"empty": "kxmlFa_empty",
			"messageEditOptimisticPulse": "kxmlFa_messageEditOptimisticPulse",
			"fileChange": "kxmlFa_fileChange",
			"versionTags": "kxmlFa_versionTags",
			"dialog": "kxmlFa_dialog",
			"dialogFacts": "kxmlFa_dialogFacts",
			"turnList": "kxmlFa_turnList",
			"turnFilterBar": "kxmlFa_turnFilterBar",
			"select": "kxmlFa_select",
			"optimisticPulse": "kxmlFa_optimisticPulse",
			"versionItem": "kxmlFa_versionItem",
			"messageTime": "kxmlFa_messageTime",
			"root": "kxmlFa_root",
			"secondaryButton": "kxmlFa_secondaryButton",
			"versionPin": "kxmlFa_versionPin",
			"dangerButton": "kxmlFa_dangerButton",
			"dialogActions": "kxmlFa_dialogActions",
			"kindBadge": "kxmlFa_kindBadge"
		};
		//#endregion
		//#region src/client/MessageEditTimelineView.tsx
		/** Timeline tab: durable version tree plus turn/block edit and retry controls. */
		/** Compute a simple word-level diff between two strings. */
		function computeDiff(before, after) {
			const beforeWords = before.split(/(\s+)/);
			const afterWords = after.split(/(\s+)/);
			const m = beforeWords.length;
			const n = afterWords.length;
			const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
			for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
				const prevRow = dp[i - 1];
				const currRow = dp[i];
				if (prevRow === void 0 || currRow === void 0) continue;
				const bw = beforeWords[i - 1];
				const aw = afterWords[j - 1];
				if (bw !== void 0 && aw !== void 0 && bw === aw) {
					const prev = prevRow[j - 1];
					if (prev !== void 0) currRow[j] = prev + 1;
				} else {
					const a = prevRow[j] ?? 0;
					const b = currRow[j - 1] ?? 0;
					currRow[j] = Math.max(a, b);
				}
			}
			const chunks = [];
			let i = m;
			let j = n;
			while (i > 0 || j > 0) {
				const currRow = dp[i];
				const prevRow = dp[i - 1];
				if (currRow === void 0 || prevRow === void 0) break;
				const bw = i > 0 ? beforeWords[i - 1] : void 0;
				const aw = j > 0 ? afterWords[j - 1] : void 0;
				if (i > 0 && j > 0 && bw !== void 0 && aw !== void 0 && bw === aw) {
					chunks.unshift({
						type: "equal",
						value: bw
					});
					i--;
					j--;
				} else if (j > 0 && (i === 0 || (currRow[j] ?? 0) >= (prevRow[j - 1] ?? 0))) {
					chunks.unshift({
						type: "insert",
						value: aw ?? ""
					});
					j--;
				} else {
					chunks.unshift({
						type: "delete",
						value: bw ?? ""
					});
					i--;
				}
			}
			const merged = [];
			for (const chunk of chunks) {
				const last = merged[merged.length - 1];
				if (last && last.type === chunk.type) last.value += chunk.value;
				else merged.push({ ...chunk });
			}
			return merged;
		}
		const BLOCK_LABEL = {
			user: "User Message",
			"assistant.reasoning": "Assistant Reasoning",
			"assistant.response": "Assistant Response"
		};
		const OPERATION_LABEL = {
			edit: "Edit",
			reroll: "Reroll",
			retry: "Retry",
			delete: "Delete"
		};
		const FILTER_LABEL = {
			all: "All",
			edit: "Edit",
			reroll: "Reroll",
			retry: "Retry",
			delete: "Delete",
			current: "Current",
			"on-path": "On Path",
			pinned: "Pinned"
		};
		const META_STORAGE_KEY = "dsh-message-edit-enhanced:version-meta";
		function loadVersionMeta() {
			try {
				const raw = localStorage.getItem(META_STORAGE_KEY);
				return raw ? JSON.parse(raw) : {};
			} catch {
				return {};
			}
		}
		function saveVersionMeta(meta) {
			try {
				localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
			} catch {}
		}
		function getVersionMeta(versionId, meta) {
			return meta[versionId] ?? {
				pinned: false,
				tags: [],
				note: ""
			};
		}
		function updateVersionMeta(versionId, updates, meta) {
			const next = {
				...meta,
				[versionId]: {
					...getVersionMeta(versionId, meta),
					...updates
				}
			};
			saveVersionMeta(next);
			return next;
		}
		function timeLabel(value) {
			return new Date(value).toLocaleString("en-US", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			});
		}
		function matchesFilter(version, filter, pinnedMeta) {
			switch (filter) {
				case "all": return true;
				case "current": return version.current;
				case "on-path": return version.onCurrentEffectPath;
				case "pinned": return getVersionMeta(version.sessionId, pinnedMeta).pinned;
				default: return version.operation === filter;
			}
		}
		function matchesSearch(version, query) {
			if (query.length === 0) return true;
			const q = query.toLowerCase();
			return [
				version.sessionId,
				version.parentSessionId,
				version.effectId,
				version.inverseSessionId,
				version.operation,
				version.cascade,
				version.before,
				version.after,
				version.targetTurn === void 0 ? void 0 : String(version.targetTurn)
			].some((field) => field !== void 0 && field.toLowerCase().includes(q));
		}
		function turnSections(turns, messages) {
			return turns.map((retry) => ({
				retry,
				messages: messages.filter((message) => message.turn === retry.turn)
			}));
		}
		function VersionRow({ version, disabled, onOpen, meta, onTogglePin }) {
			const depthStyle = { "--message-edit-enhanced-depth": String(version.depth) };
			const operation = version.operation === void 0 ? version.parentSessionId === void 0 ? "Original" : "External Branch" : OPERATION_LABEL[version.operation];
			const hasDiff = version.before !== void 0 || version.after !== void 0;
			const [expanded, setExpanded] = (0, react.useState)(false);
			const diffChunks = hasDiff ? computeDiff(version.before || "", version.after || "") : [];
			const handleClick = (e) => {
				if (e.target.closest(".version-expand")) return;
				if (e.target.closest(".version-pin")) return;
				onOpen(version.sessionId);
			};
			const handleExpandClick = (e) => {
				e.stopPropagation();
				setExpanded(!expanded);
			};
			const handlePinClick = (e) => {
				e.stopPropagation();
				onTogglePin(version.sessionId, !meta.pinned);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: MessageEditTimelineView_module_css_default["versionItem"],
				style: depthStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: MessageEditTimelineView_module_css_default["versionButton"],
					"data-current": version.current || void 0,
					disabled: version.current || disabled,
					onClick: handleClick,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["versionLine"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["versionDot"],
							"aria-hidden": true
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: MessageEditTimelineView_module_css_default["versionMain"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: MessageEditTimelineView_module_css_default["versionTitle"],
									children: [operation, version.targetTurn === void 0 ? null : ` · Turn ${String(version.targetTurn)}`]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: MessageEditTimelineView_module_css_default["versionMeta"],
									children: [
										timeLabel(version.createdAt),
										" · ",
										version.sessionId.slice(0, 12)
									]
								}),
								meta.tags.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["versionTags"],
									children: meta.tags.map((tag, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: MessageEditTimelineView_module_css_default["versionTag"],
										children: ["#", tag]
									}, idx))
								}),
								meta.note && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["versionNote"],
									children: meta.note
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageEditTimelineView_module_css_default["versionPin"],
							onClick: handlePinClick,
							"aria-label": meta.pinned ? "Unpin version" : "Pin version",
							"aria-pressed": meta.pinned,
							title: meta.pinned ? "Unpin" : "Pin",
							children: meta.pinned ? "📌" : "📍"
						}),
						version.current ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["currentBadge"],
							children: "Current"
						}) : version.onCurrentEffectPath ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["pathBadge"],
							children: "On Path"
						}) : null,
						hasDiff && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageEditTimelineView_module_css_default["versionExpand"],
							onClick: handleExpandClick,
							"aria-label": expanded ? "Collapse diff" : "Expand diff",
							"aria-expanded": expanded,
							children: expanded ? "▲" : "▼"
						})
					]
				}), expanded && hasDiff && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: MessageEditTimelineView_module_css_default["versionDiffPanel"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: MessageEditTimelineView_module_css_default["versionDiffHeader"],
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: MessageEditTimelineView_module_css_default["diffLegend"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["diffDelete"],
									children: "Removed"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["diffInsert"],
									children: "Added"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: MessageEditTimelineView_module_css_default["diffEqual"],
									children: "Unchanged"
								})
							]
						})
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						className: MessageEditTimelineView_module_css_default["versionDiffContent"],
						children: diffChunks.map((chunk, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default[`diff${chunk.type.charAt(0).toUpperCase() + chunk.type.slice(1)}`],
							children: chunk.value
						}, idx))
					})]
				})]
			});
		}
		function MessageCard({ message, editing, disabled, cascade, onBeginEdit, onCancelEdit, onTextChange, onApplyEdit, onDelete }) {
			const active = editing?.message.key === message.key;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
				className: MessageEditTimelineView_module_css_default["messageCard"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: MessageEditTimelineView_module_css_default["messageHeader"],
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["kindBadge"],
							"data-kind": message.kind,
							children: BLOCK_LABEL[message.kind]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["messageTime"],
							children: timeLabel(message.time)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageEditTimelineView_module_css_default["textButton"],
							disabled,
							onClick: () => {
								active ? onCancelEdit() : onBeginEdit(message);
							},
							children: active ? "Cancel" : "Edit"
						}),
						onDelete === null || message.kind !== "user" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageEditTimelineView_module_css_default["textButton"],
							"data-danger": true,
							disabled,
							title: "Delete this exchange and revert its workspace changes",
							onClick: () => {
								onDelete?.(message);
							},
							children: "Delete"
						})
					]
				}), active && editing !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: MessageEditTimelineView_module_css_default["editor"],
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: MessageEditTimelineView_module_css_default["textarea"],
						value: editing.text,
						rows: 6,
						autoFocus: true,
						onChange: (event) => {
							onTextChange(event.currentTarget.value);
						}
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MessageEditTimelineView_module_css_default["editorActions"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: MessageEditTimelineView_module_css_default["editorHint"],
							children: "Will branch from before this turn; the original version will remain."
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: MessageEditTimelineView_module_css_default["primaryButton"],
							disabled,
							onClick: () => {
								onApplyEdit(message, editing.text, cascade);
							},
							children: "Apply & Regenerate"
						})]
					})]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					className: MessageEditTimelineView_module_css_default["messageText"],
					children: message.text || "(empty)"
				})]
			});
		}
		/** Conversation-view entry point. */
		function MessageEditTimelineView({ useMessageEdit, acquire, load, edit, retry, reroll, previewDelete, deleteMessage, openVersion, exportBranch }) {
			const state = useMessageEdit((value) => value);
			const [cascade, setCascade] = (0, react.useState)("truncate");
			const [editing, setEditing] = (0, react.useState)(null);
			const [versionFilter, setVersionFilter] = (0, react.useState)("all");
			const [versionSearch, setVersionSearch] = (0, react.useState)("");
			const [turnSearch, setTurnSearch] = (0, react.useState)("");
			const [versionMeta, setVersionMeta] = (0, react.useState)(() => loadVersionMeta());
			const [exportFormat, setExportFormat] = (0, react.useState)("json");
			const [deleteTarget, setDeleteTarget] = (0, react.useState)(null);
			const [deletePreviewData, setDeletePreviewData] = (0, react.useState)(null);
			const [deletePreviewError, setDeletePreviewError] = (0, react.useState)(null);
			const [deleteRollback, setDeleteRollback] = (0, react.useState)(true);
			const [deleteBusy, setDeleteBusy] = (0, react.useState)(false);
			/** Open the confirmation dialog and fetch the read-only impact report. */
			const requestDelete = (message) => {
				setDeleteTarget(message);
				setDeletePreviewData(null);
				setDeletePreviewError(null);
				setDeleteRollback(true);
				previewDelete(message.eventSeq).then((report) => {
					setDeletePreviewData(report);
					setDeleteRollback(report.checkpointFound);
				}).catch((error) => {
					setDeletePreviewError(error instanceof Error ? error.message : String(error));
				});
			};
			const confirmDelete = () => {
				if (deleteTarget === null || deleteBusy) return;
				setDeleteBusy(true);
				const rollbackWorkspace = deleteRollback && (deletePreviewData?.checkpointFound ?? false);
				deleteMessage(deleteTarget.eventSeq, rollbackWorkspace).finally(() => {
					setDeleteBusy(false);
					setDeleteTarget(null);
					setDeletePreviewData(null);
				});
			};
			(0, react.useEffect)(() => {
				saveVersionMeta(versionMeta);
			}, [versionMeta]);
			(0, react.useEffect)(() => {
				const release = acquire();
				load();
				return release;
			}, [acquire, load]);
			const timeline = state.timeline;
			const sections = (0, react.useMemo)(() => timeline === null ? [] : turnSections(timeline.retryableTurns, timeline.messages), [timeline]);
			const busy = state.pending !== null || state.status !== "ready" || state.busy;
			(0, react.useEffect)(() => {
				setEditing((current) => {
					if (current === null || timeline === null) return current;
					return timeline.messages.some((message) => message.key === current.message.key) ? current : null;
				});
			}, [timeline]);
			const filteredVersions = (0, react.useMemo)(() => {
				if (timeline === null) return [];
				return timeline.versions.filter((version) => matchesFilter(version, versionFilter, versionMeta) && matchesSearch(version, versionSearch));
			}, [
				timeline,
				versionFilter,
				versionSearch,
				versionMeta
			]);
			const filteredSections = (0, react.useMemo)(() => {
				if (timeline === null) return [];
				const q = turnSearch.toLowerCase();
				if (q.length === 0) return sections;
				return sections.map((section) => ({
					...section,
					messages: section.messages.filter((m) => m.text.toLowerCase().includes(q) || m.kind.toLowerCase().includes(q) || String(m.turn).includes(q))
				})).filter((section) => section.messages.length > 0);
			}, [
				timeline,
				sections,
				turnSearch
			]);
			/** Lightweight list virtualization bounds. */
			const VERSION_ROW_ESTIMATED_HEIGHT = 68;
			const VIRTUAL_BUFFER = 8;
			const versionListRef = (0, react.useRef)(null);
			const [scrollTop, setScrollTop] = (0, react.useState)(0);
			const [viewportHeight, setViewportHeight] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const el = versionListRef.current;
				if (!el) return;
				setViewportHeight(el.clientHeight);
				const onScroll = () => setScrollTop(el.scrollTop);
				el.addEventListener("scroll", onScroll, { passive: true });
				return () => el.removeEventListener("scroll", onScroll);
			}, [timeline]);
			(0, react.useEffect)(() => {
				const el = versionListRef.current;
				if (el) el.scrollTop = 0;
				setScrollTop(0);
			}, [versionFilter, versionSearch]);
			const virtualWindow = (0, react.useMemo)(() => {
				const total = filteredVersions.length;
				const start = Math.max(0, Math.floor(scrollTop / VERSION_ROW_ESTIMATED_HEIGHT) - VIRTUAL_BUFFER);
				const visibleCount = Math.max(1, Math.ceil(viewportHeight / VERSION_ROW_ESTIMATED_HEIGHT));
				return {
					total,
					start,
					end: Math.min(total, start + visibleCount + 16)
				};
			}, [
				filteredVersions.length,
				scrollTop,
				viewportHeight
			]);
			if (timeline === null && (state.status === "idle" || state.status === "loading")) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: MessageEditTimelineView_module_css_default["status"],
				children: "Loading message timeline…"
			});
			if (timeline === null && state.status === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditTimelineView_module_css_default["status"],
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: MessageEditTimelineView_module_css_default["error"],
					children: state.error
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: MessageEditTimelineView_module_css_default["secondaryButton"],
					onClick: load,
					children: "Reload"
				})]
			});
			if (timeline === null) return null;
			const applyEdit = (message, text, policy) => {
				setEditing(null);
				edit(message, text, policy);
			};
			const togglePin = (sessionId, pinned) => {
				setVersionMeta((prev) => updateVersionMeta(sessionId, { pinned }, prev));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: MessageEditTimelineView_module_css_default["root"],
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: MessageEditTimelineView_module_css_default["pageHeader"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: MessageEditTimelineView_module_css_default["title"],
							children: "Message Edit & Regeneration"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: MessageEditTimelineView_module_css_default["intro"],
							children: "Each edit is recorded with its inverse; the entire turn and its tool chain are recomputed as a unit."
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: MessageEditTimelineView_module_css_default["headerActions"],
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: MessageEditTimelineView_module_css_default["cascadeField"],
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Cascade Policy" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: MessageEditTimelineView_module_css_default["select"],
									value: cascade,
									disabled: busy,
									onChange: (event) => {
										setCascade(event.currentTarget.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "truncate",
										children: "Truncate following (default)"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "preserve",
										children: "Preserve inputs & regenerate following"
									})]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: MessageEditTimelineView_module_css_default["primaryButton"],
								disabled: busy,
								onClick: () => {
									reroll();
								},
								children: state.pending === "reroll" ? "Regenerating…" : "Regenerate Last Reply"
							})]
						})]
					}),
					state.error === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MessageEditTimelineView_module_css_default["error"],
						children: state.error
					}),
					state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MessageEditTimelineView_module_css_default["notice"],
						children: "Refreshing timeline…"
					}) : null,
					state.switchingTo !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: MessageEditTimelineView_module_css_default["notice"],
						children: ["Switching session… ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: state.switchingTo.slice(0, 12) })]
					}) : null,
					state.regenerating ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: MessageEditTimelineView_module_css_default["notice"],
						role: "status",
						children: "Regenerating response in the current session…"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: MessageEditTimelineView_module_css_default["columns"],
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("aside", {
							className: MessageEditTimelineView_module_css_default["versionsPanel"],
							"aria-label": "Version Timeline",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["sectionHeading"],
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
											className: MessageEditTimelineView_module_css_default["subtitle"],
											children: "Version Timeline"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: MessageEditTimelineView_module_css_default["count"],
											children: [
												String(filteredVersions.length),
												" / ",
												String(timeline.versions.length)
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											className: MessageEditTimelineView_module_css_default["select"],
											value: exportFormat,
											disabled: busy || timeline === null,
											onChange: (event) => {
												setExportFormat(event.currentTarget.value);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "json",
												children: "JSON"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "markdown",
												children: "Markdown"
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline === null,
											onClick: () => {
												exportBranch(exportFormat);
											},
											title: `Export current timeline as ${exportFormat.toUpperCase()}`,
											children: "Export"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["filterBar"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "search",
										className: MessageEditTimelineView_module_css_default["filterSearch"],
										placeholder: "Search versions…",
										value: versionSearch,
										onChange: (event) => {
											setVersionSearch(event.currentTarget.value);
										}
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: MessageEditTimelineView_module_css_default["filterChips"],
										children: Object.keys(FILTER_LABEL).map((filter) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["filterChip"],
											"data-active": versionFilter === filter || void 0,
											disabled: busy,
											onClick: () => {
												setVersionFilter(filter);
											},
											children: FILTER_LABEL[filter]
										}, filter))
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["effectControls"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: MessageEditTimelineView_module_css_default["effectDepth"],
										children: [
											"Effect chain: ",
											String(timeline.undoStack.length),
											" level(s)"
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MessageEditTimelineView_module_css_default["effectButtons"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.undoStack[0] === void 0,
											onClick: () => {
												const target = timeline.undoStack[0];
												if (target !== void 0) openVersion(target);
											},
											children: "Undo Current Effect"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: MessageEditTimelineView_module_css_default["secondaryButton"],
											disabled: busy || timeline.redoSessionIds.length === 0,
											onClick: () => {
												const target = timeline.redoSessionIds.at(-1);
												if (target !== void 0) openVersion(target);
											},
											children: timeline.redoSessionIds.length > 1 ? `Redo Latest Branch (${String(timeline.redoSessionIds.length)})` : "Redo Next Effect"
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: MessageEditTimelineView_module_css_default["versionListScroller"],
									ref: versionListRef,
									children: filteredVersions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
										className: MessageEditTimelineView_module_css_default["empty"],
										children: "No versions match the current filter."
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
										className: MessageEditTimelineView_module_css_default["versionList"],
										style: {
											height: `${virtualWindow.total * VERSION_ROW_ESTIMATED_HEIGHT}px`,
											position: "relative"
										},
										children: filteredVersions.slice(virtualWindow.start, virtualWindow.end).map((version, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
											className: MessageEditTimelineView_module_css_default["versionItem"],
											style: {
												position: "absolute",
												top: `${(virtualWindow.start + index) * VERSION_ROW_ESTIMATED_HEIGHT}px`,
												left: 0,
												right: 0
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VersionRow, {
												version,
												disabled: busy,
												onOpen: (sessionId) => {
													openVersion(sessionId);
												},
												meta: getVersionMeta(version.sessionId, versionMeta),
												onTogglePin: togglePin
											})
										}, version.sessionId))
									})
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("main", {
							className: MessageEditTimelineView_module_css_default["turnsPanel"],
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["sectionHeading"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: MessageEditTimelineView_module_css_default["subtitle"],
										children: "Settled Messages"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: MessageEditTimelineView_module_css_default["count"],
										children: [
											String(filteredSections.reduce((sum, s) => sum + s.messages.length, 0)),
											" / ",
											String(timeline.messages.length)
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: MessageEditTimelineView_module_css_default["turnFilterBar"],
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "search",
										className: MessageEditTimelineView_module_css_default["filterSearch"],
										placeholder: "Search messages…",
										value: turnSearch,
										onChange: (event) => {
											setTurnSearch(event.currentTarget.value);
										}
									})
								}),
								filteredSections.length === 0 && state.optimisticEdit === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: MessageEditTimelineView_module_css_default["empty"],
									children: "No settled turns available to edit in this session."
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ol", {
									className: MessageEditTimelineView_module_css_default["turnList"],
									children: [filteredSections.map((section) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: MessageEditTimelineView_module_css_default["turnSection"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: MessageEditTimelineView_module_css_default["turnHeader"],
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
												className: MessageEditTimelineView_module_css_default["turnTitle"],
												children: ["Turn ", String(section.retry.turn)]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: MessageEditTimelineView_module_css_default["turnPreview"],
												children: section.retry.preview || "(empty user input)"
											})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: MessageEditTimelineView_module_css_default["secondaryButton"],
												disabled: busy,
												onClick: () => {
													retry(section.retry.turn, cascade);
												},
												children: state.pending === "retry" ? "Retrying…" : "Retry This Turn"
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: MessageEditTimelineView_module_css_default["messageList"],
											children: section.messages.map((message) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageCard, {
												message,
												editing,
												disabled: busy,
												cascade,
												onBeginEdit: (value) => {
													setEditing({
														message: value,
														text: value.text
													});
												},
												onCancelEdit: () => {
													setEditing(null);
												},
												onTextChange: (text) => {
													setEditing((current) => current === null ? null : {
														...current,
														text
													});
												},
												onApplyEdit: applyEdit,
												onDelete: requestDelete
											}, message.key))
										})]
									}, section.retry.turn)), state.optimisticEdit === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
										className: MessageEditTimelineView_module_css_default["turnSection"],
										"data-optimistic": "true",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: MessageEditTimelineView_module_css_default["turnHeader"],
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", {
												className: MessageEditTimelineView_module_css_default["turnTitle"],
												children: ["Turn ", String(state.optimisticEdit.turn)]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
												className: MessageEditTimelineView_module_css_default["turnPreview"],
												children: "Regenerating in the current session…"
											})] })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: MessageEditTimelineView_module_css_default["messageList"],
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: MessageEditTimelineView_module_css_default["optimisticMessage"],
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: MessageEditTimelineView_module_css_default["optimisticKind"],
														children: "User"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: MessageEditTimelineView_module_css_default["optimisticText"],
														children: state.optimisticEdit.text || "(empty)"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: MessageEditTimelineView_module_css_default["optimisticPulse"],
														role: "status",
														children: "regenerating"
													})
												]
											})
										})]
									})]
								})
							]
						})]
					}),
					deleteTarget === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: MessageEditTimelineView_module_css_default["dialogOverlay"],
						role: "presentation",
						onClick: () => {
							if (!deleteBusy) setDeleteTarget(null);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: MessageEditTimelineView_module_css_default["dialog"],
							role: "dialog",
							"aria-modal": "true",
							"aria-label": "Delete message",
							onClick: (event) => {
								event.stopPropagation();
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									className: MessageEditTimelineView_module_css_default["dialogTitle"],
									children: "Delete this message?"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: MessageEditTimelineView_module_css_default["dialogText"],
									children: "This will delete the user message, its response, and revert any code changes caused by this exchange."
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									className: MessageEditTimelineView_module_css_default["dialogQuote"],
									children: deleteTarget.text || "(empty)"
								}),
								deletePreviewData === null && deletePreviewError === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: MessageEditTimelineView_module_css_default["dialogText"],
									children: "Checking impact…"
								}) : null,
								deletePreviewError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
									className: MessageEditTimelineView_module_css_default["dialogWarning"],
									children: ["Impact check failed: ", deletePreviewError]
								}) : null,
								deletePreviewData !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
										className: MessageEditTimelineView_module_css_default["dialogFacts"],
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
												"Removes turn ",
												String(deletePreviewData.turn),
												deletePreviewData.laterTurns.length > 0 ? ` and ${String(deletePreviewData.laterTurns.length)} later exchange(s) (turn ${deletePreviewData.laterTurns.map((t) => String(t)).join(", ")})` : "",
												"."
											] }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
												deletePreviewData.willBranch ? "This session is not live, so the deletion will create a branch without these exchanges." : "The exchanges are removed from this conversation in place.",
												" ",
												"The full history stays in the session log as an audit trail."
											] }),
											deletePreviewData.checkpointFound ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
												"Workspace snapshot found (",
												deletePreviewData.workspacePath,
												"):",
												" ",
												String(deletePreviewData.filesToRevert.length),
												" file(s) to revert,",
												" ",
												String(deletePreviewData.filesToRemove.length),
												" created-after file(s) to remove."
											] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
												"No workspace snapshot for this message",
												deletePreviewData.checkpointReason === void 0 ? "" : `: ${deletePreviewData.checkpointReason}`,
												". Code changes cannot be reverted automatically."
											] })
										]
									}),
									(deletePreviewData.filesToRevert.length > 0 || deletePreviewData.filesToRemove.length > 0) && deleteRollback ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: MessageEditTimelineView_module_css_default["fileList"],
										children: [[...deletePreviewData.filesToRevert, ...deletePreviewData.filesToRemove].slice(0, 8).map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: MessageEditTimelineView_module_css_default["fileRow"],
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: MessageEditTimelineView_module_css_default["fileChange"],
												"data-change": file.change,
												children: file.change === "revert" ? "revert" : "remove"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: MessageEditTimelineView_module_css_default["filePath"],
												children: file.path
											})]
										}, `${file.change}:${file.path}`)), deletePreviewData.filesToRevert.length + deletePreviewData.filesToRemove.length > 8 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: MessageEditTimelineView_module_css_default["fileRow"],
											children: [
												"…and ",
												String(deletePreviewData.filesToRevert.length + deletePreviewData.filesToRemove.length - 8),
												" more"
											]
										}) : null]
									}) : null,
									deletePreviewData.skipped.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: MessageEditTimelineView_module_css_default["dialogText"],
										children: [String(deletePreviewData.skipped.length), " binary/oversized file(s) are left untouched."]
									}) : null,
									deletePreviewData.checkpointFound ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: MessageEditTimelineView_module_css_default["dialogCheck"],
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: deleteRollback,
											disabled: deleteBusy,
											onChange: (event) => {
												setDeleteRollback(event.currentTarget.checked);
											}
										}), "Also revert workspace changes from this exchange"]
									}) : null,
									deletePreviewData.warnings.map((warning, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: MessageEditTimelineView_module_css_default["dialogWarning"],
										children: warning
									}, index))
								] }) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: MessageEditTimelineView_module_css_default["dialogActions"],
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: MessageEditTimelineView_module_css_default["secondaryButton"],
										disabled: deleteBusy,
										onClick: () => {
											setDeleteTarget(null);
										},
										children: "Cancel"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: MessageEditTimelineView_module_css_default["dangerButton"],
										disabled: deleteBusy || deleteRollback && deletePreviewError !== null,
										onClick: () => {
											confirmDelete();
										},
										children: deleteBusy ? "Deleting…" : "Delete"
									})]
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Explicit value sources and slot declaration-order edges. */
		const inject = [
			"slots",
			"conversation",
			"connection",
			"sessions"
		];
		/** Register both UI contributions over one per-session controller identity. */
		function apply(ctx) {
			const controllers = /* @__PURE__ */ new Map();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new MessageEditController(ctx, sessionId);
					controllers.set(sessionId, controller);
				}
				return controller;
			};
			ctx.on("connection/reset", () => {
				for (const controller of controllers.values()) controller.refreshIfLoaded();
			});
			ctx.slots.register({
				name: "conversation.view",
				id: "message-edit-enhanced-timeline",
				order: 15,
				label: "Timeline",
				inject: (sessionId) => controllerFor(sessionId).face
			}, MessageEditTimelineView);
			ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "message-edit-enhanced-controls",
				order: 15,
				inject: (sessionId) => controllerFor(sessionId).face
			}, MessageEditHeader);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map