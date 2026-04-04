import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { MutableBlueprint } from "./mutableBlueprint";
import { type QuestionPath, qpath, qpathParent } from "./questionPath";

/** Method names that mutate blueprint state and should create undo snapshots. */
const MUTATION_METHODS = new Set([
	"updateQuestion",
	"addQuestion",
	"removeQuestion",
	"moveQuestion",
	"duplicateQuestion",
	"updateModule",
	"updateForm",
	"replaceForm",
	"addForm",
	"removeForm",
	"addModule",
	"removeModule",
	"renameQuestion",
	"renameCaseProperty",
	"updateCaseProperty",
]);

export type MutationType =
	| "add"
	| "remove"
	| "move"
	| "duplicate"
	| "update"
	| "rename"
	| "structural";

export type CursorMode = "pointer" | "text" | "inspect";

export interface SnapshotMeta {
	type: MutationType;
	moduleIndex: number;
	formIndex: number;
	questionPath?: QuestionPath;
	secondaryPath?: QuestionPath;
}

interface SnapshotEntry {
	blueprint: AppBlueprint;
	meta: SnapshotMeta;
	cursorMode: CursorMode;
}

/** Maps a proxy-intercepted method call to SnapshotMeta. */
function deriveMeta(method: string, args: unknown[]): SnapshotMeta {
	const moduleIndex = typeof args[0] === "number" ? args[0] : -1;
	const formIndex = typeof args[1] === "number" ? args[1] : -1;
	const arg2 = args[2] as QuestionPath | undefined;
	const arg3 = args[3] as string | undefined;

	switch (method) {
		case "addQuestion": {
			const q = args[2] as { id?: string; parentPath?: string } | undefined;
			const parent = args[3] as { parentPath?: string } | undefined;
			return {
				type: "add",
				moduleIndex,
				formIndex,
				questionPath: qpath(
					q?.id ?? "",
					parent?.parentPath as QuestionPath | undefined,
				),
			};
		}
		case "removeQuestion":
			return { type: "remove", moduleIndex, formIndex, questionPath: arg2 };
		case "moveQuestion":
			return { type: "move", moduleIndex, formIndex, questionPath: arg2 };
		case "duplicateQuestion":
			// secondaryPath patched after execution with the clone's path
			return {
				type: "duplicate",
				moduleIndex,
				formIndex,
				questionPath: arg2,
			};
		case "updateQuestion":
			return { type: "update", moduleIndex, formIndex, questionPath: arg2 };
		case "renameQuestion":
			return {
				type: "rename",
				moduleIndex,
				formIndex,
				questionPath: arg2,
				secondaryPath:
					arg2 && arg3 ? qpath(arg3, qpathParent(arg2)) : undefined,
			};
		default:
			return { type: "structural", moduleIndex, formIndex };
	}
}

export class HistoryManager {
	private undoStack: SnapshotEntry[] = [];
	private redoStack: SnapshotEntry[] = [];
	private maxDepth: number;
	enabled = true;

	/** Current cursor mode — set by Builder, captured in each snapshot. */
	cursorMode: CursorMode = "inspect";

	/** Current MutableBlueprint — can be swapped on undo/redo. */
	private _mb: MutableBlueprint;

	/** The Proxy-wrapped MutableBlueprint — use this instead of the raw instance. */
	readonly proxied: MutableBlueprint;

	constructor(mb: MutableBlueprint, maxDepth = 50) {
		this._mb = mb;
		this.maxDepth = maxDepth;
		// Proxy delegates to this._mb, which can be swapped
		this.proxied = new Proxy({} as MutableBlueprint, {
			get: (_target, prop, _receiver) => {
				const value = Reflect.get(this._mb, prop, this._mb);
				if (
					typeof prop === "string" &&
					MUTATION_METHODS.has(prop) &&
					typeof value === "function"
				) {
					return (...args: unknown[]) => {
						const meta = deriveMeta(prop, args);
						this.snapshot(meta);
						const result = value.apply(this._mb, args);
						// Patch duplicate clone ID after execution
						if (
							prop === "duplicateQuestion" &&
							typeof result === "string" &&
							this.undoStack.length > 0
						) {
							this.undoStack[this.undoStack.length - 1].meta.secondaryPath =
								result as QuestionPath;
						}
						return result;
					};
				}
				if (typeof value === "function") {
					return value.bind(this._mb);
				}
				return value;
			},
		});
	}

	private snapshot(meta: SnapshotMeta) {
		if (!this.enabled) return;
		this.undoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			meta,
			cursorMode: this.cursorMode,
		});
		this.redoStack = [];
		if (this.undoStack.length > this.maxDepth) {
			this.undoStack.shift();
		}
	}

	/** Undo: returns the new MutableBlueprint + meta + cursorMode, or undefined if nothing to undo. */
	undo():
		| { mb: MutableBlueprint; meta: SnapshotMeta; cursorMode: CursorMode }
		| undefined {
		if (this.undoStack.length === 0) return undefined;
		const entry = this.undoStack.pop();
		if (!entry) return undefined;
		this.redoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			meta: entry.meta,
			cursorMode: this.cursorMode,
		});
		// entry was popped — no other reference exists, safe to adopt without cloning
		this._mb = MutableBlueprint.fromOwned(entry.blueprint);
		return { mb: this._mb, meta: entry.meta, cursorMode: entry.cursorMode };
	}

	/** Redo: returns the new MutableBlueprint + meta + cursorMode, or undefined if nothing to redo. */
	redo():
		| { mb: MutableBlueprint; meta: SnapshotMeta; cursorMode: CursorMode }
		| undefined {
		if (this.redoStack.length === 0) return undefined;
		const entry = this.redoStack.pop();
		if (!entry) return undefined;
		this.undoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			meta: entry.meta,
			cursorMode: this.cursorMode,
		});
		// entry was popped — no other reference exists, safe to adopt without cloning
		this._mb = MutableBlueprint.fromOwned(entry.blueprint);
		return { mb: this._mb, meta: entry.meta, cursorMode: entry.cursorMode };
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear() {
		this.undoStack = [];
		this.redoStack = [];
	}
}
