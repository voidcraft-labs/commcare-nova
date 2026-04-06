import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { MutableBlueprint } from "./mutableBlueprint";

/**
 * Method names that mutate blueprint state and trigger undo snapshots.
 * The proxy intercepts calls to these methods, captures the current state
 * before the mutation executes, and pushes it onto the undo stack.
 */
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

export type CursorMode = "pointer" | "text" | "inspect";

/**
 * Each snapshot pairs the full blueprint with an opaque view context `V`
 * that captures exactly where the user was (selection, nav screen, cursor mode)
 * at the moment the mutation occurred. On undo/redo the view context is restored
 * atomically — no derivation, no inference from mutation type.
 */
interface SnapshotEntry<V> {
	blueprint: AppBlueprint;
	view: V;
}

/**
 * Generic undo/redo manager for blueprint mutations.
 *
 * Type parameter `V` is the view context — an opaque payload that captures
 * the UI state (selection, navigation screen, cursor mode, active field)
 * alongside each blueprint snapshot. The HistoryManager stores and returns
 * it without inspecting its contents, keeping the service layer decoupled
 * from UI types.
 *
 * View context is derived lazily via a `deriveView` callback rather than
 * stored eagerly. This ensures the snapshot captures the live UI state at
 * the exact moment of the mutation (during a user interaction / event handler)
 * rather than a stale copy from the last React render. It also avoids DOM
 * reads during render, which would be a side effect and cause SSR mismatches.
 *
 * Snapshots are captured automatically via a Proxy wrapper around MutableBlueprint.
 * Any call to a method in `MUTATION_METHODS` triggers a snapshot before the
 * mutation executes, recording both the blueprint state and the current view
 * context for faithful restoration on undo.
 */
export class HistoryManager<V> {
	private undoStack: SnapshotEntry<V>[] = [];
	private redoStack: SnapshotEntry<V>[] = [];
	private maxDepth: number;
	enabled = true;

	/**
	 * Callback that returns the current view context on demand.
	 * Called at snapshot time (during mutations) and when pushing to the
	 * opposite stack (during undo/redo). Never called during render.
	 * Set by Builder and updated whenever the view-producing dependencies change.
	 */
	deriveView: () => V;

	/** Current MutableBlueprint — swapped on undo/redo to the restored snapshot. */
	private _mb: MutableBlueprint;

	/** Proxy-wrapped MutableBlueprint — all external reads and mutations go through this. */
	readonly proxied: MutableBlueprint;

	constructor(mb: MutableBlueprint, deriveView: () => V, maxDepth = 50) {
		this._mb = mb;
		this.deriveView = deriveView;
		this.maxDepth = maxDepth;

		/**
		 * Proxy that delegates all property access to the current `_mb` instance.
		 * For mutation methods, it intercepts the call to snapshot state before
		 * the mutation executes. `_mb` can be swapped on undo/redo, so the proxy
		 * always reads from the live instance via closure.
		 */
		this.proxied = new Proxy({} as MutableBlueprint, {
			get: (_target, prop, _receiver) => {
				const value = Reflect.get(this._mb, prop, this._mb);
				if (
					typeof prop === "string" &&
					MUTATION_METHODS.has(prop) &&
					typeof value === "function"
				) {
					return (...args: unknown[]) => {
						this.snapshot();
						return value.apply(this._mb, args);
					};
				}
				if (typeof value === "function") {
					return value.bind(this._mb);
				}
				return value;
			},
		});
	}

	/**
	 * Capture the current blueprint + view context before a mutation.
	 * Calls `deriveView()` to get the live UI state at this exact moment.
	 * Clears the redo stack (new mutation invalidates the forward history)
	 * and enforces the max depth by discarding the oldest entry.
	 */
	private snapshot() {
		if (!this.enabled) return;
		this.undoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			view: this.deriveView(),
		});
		this.redoStack = [];
		if (this.undoStack.length > this.maxDepth) {
			this.undoStack.shift();
		}
	}

	/**
	 * Undo the most recent mutation.
	 * Pushes the current state onto the redo stack (so redo can get back here),
	 * then restores the popped snapshot's blueprint and view context.
	 *
	 * @returns The restored MutableBlueprint and view context, or undefined if
	 *          the undo stack is empty.
	 */
	undo(): { mb: MutableBlueprint; view: V } | undefined {
		const entry = this.undoStack.pop();
		if (!entry) return undefined;
		this.redoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			view: this.deriveView(),
		});
		/* Entry was popped — no other reference exists, safe to adopt without
		 * redundant deep cloning via `fromOwned`. */
		this._mb = MutableBlueprint.fromOwned(entry.blueprint);
		return { mb: this._mb, view: entry.view };
	}

	/**
	 * Redo the most recently undone mutation.
	 * Pushes the current state onto the undo stack (so undo can get back here),
	 * then restores the popped redo entry's blueprint and view context.
	 *
	 * @returns The restored MutableBlueprint and view context, or undefined if
	 *          the redo stack is empty.
	 */
	redo(): { mb: MutableBlueprint; view: V } | undefined {
		const entry = this.redoStack.pop();
		if (!entry) return undefined;
		this.undoStack.push({
			blueprint: structuredClone(this._mb.getBlueprint()),
			view: this.deriveView(),
		});
		/* Entry was popped — no other reference exists, safe to adopt without
		 * redundant deep cloning via `fromOwned`. */
		this._mb = MutableBlueprint.fromOwned(entry.blueprint);
		return { mb: this._mb, view: entry.view };
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
