/**
 * Builder state re-architecture — ephemeral session type definitions.
 *
 * Everything in this store lives only while the builder route is mounted
 * and is NEVER undoable. Separating from BlueprintDoc means there's no
 * risk of UI state bleeding into undo history and no need for a partialize
 * allow-list — the two stores have disjoint responsibilities.
 *
 * Types are organized by concern:
 *   - Cursor/sidebar primitives (Phase 3)
 *   - Generation lifecycle (Phase 4) — stages, errors, partial scaffold
 *   - Replay (Phase 4) — raw event log + derived chapter metadata
 */

import type { Event } from "@/lib/log/types";

// ── Interaction primitives ───────────────────────────────────────────────

/** Interaction mode. "edit" = click to select + inline text editing;
 *  "pointer" = live form-fill preview. */
export type CursorMode = "edit" | "pointer";

/**
 * Visibility + stash state for one sidebar column. `open` is current
 * visibility; `stashed` records whether we should reopen when leaving edit
 * mode. See `switchCursorMode` in the store.
 */
export type SidebarState = { open: boolean; stashed: boolean | undefined };

// ── Generation lifecycle ─────────────────────────────────────────────────

/** Progress stages within a generation run. Mirrors the SA's tool sequence:
 *  data model → structure → modules → forms → validate → fix. */
export enum GenerationStage {
	DataModel = "data-model",
	Structure = "structure",
	Modules = "modules",
	Forms = "forms",
	Validate = "validate",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase. The session
 *  stays in agent-active mode; this describes what went wrong. */
export type GenerationError = {
	message: string;
	severity: "recovering" | "failed";
} | null;

/** Status label for each generation stage, shown in the Signal Grid panel. */
export const STAGE_LABELS: Record<GenerationStage, string> = {
	[GenerationStage.DataModel]: "Designing data model",
	[GenerationStage.Structure]: "Designing app structure",
	[GenerationStage.Modules]: "Building app content",
	[GenerationStage.Forms]: "Building app content",
	[GenerationStage.Validate]: "Validating blueprint",
	[GenerationStage.Fix]: "Fixing validation errors",
};

/** Intermediate scaffold data streamed before the full Scaffold arrives.
 *  Drives the "building..." preview showing module/form names as they
 *  arrive from the SA's `setScaffold` tool call. */
export interface PartialScaffoldData {
	appName?: string;
	description?: string;
	modules: Array<{
		name: string;
		case_type?: string | null;
		purpose?: string;
		forms: Array<{
			name: string;
			type: string;
			purpose?: string;
		}>;
	}>;
}

// ── Replay ───────────────────────────────────────────────────────────────

/**
 * Chapter metadata for replay navigation. Start/end index into the
 * `events` array; chapters are cumulative — replaying to chapter N
 * means dispatching events[0..chapters[N].endIndex]. Derived at
 * extraction time from tool-call boundaries in the log, not stored on
 * events themselves.
 */
export interface ReplayChapter {
	header: string;
	subtitle?: string;
	startIndex: number;
	endIndex: number;
}

/**
 * Replay session data stored on the session store. Cursor is an index
 * into `events`, not `chapters` — chapters are derived scrub targets
 * over the same underlying stream. Messages are derived on read via
 * the `useReplayMessages` hook, which projects the conversation events
 * up to the cursor into `UIMessage[]`.
 */
export interface ReplayData {
	events: Event[];
	chapters: ReplayChapter[];
	cursor: number;
	exitPath: string;
}

/* The canonical session state type is `BuilderSessionState` in `store.ts`.
 * It includes both fields and actions. The types above are shared between
 * the store, hooks, and consumers. */

/**
 * Replay init data passed from the RSC page to BuilderProvider.
 * `initialCursor` is the scrub position at mount (usually `events.length - 1`
 * — the final frame, so the user sees the completed build before scrubbing
 * backward).
 */
export interface ReplayInit {
	events: Event[];
	chapters: ReplayChapter[];
	initialCursor: number;
	exitPath: string;
}
