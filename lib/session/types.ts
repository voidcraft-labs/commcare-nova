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
 *   - Replay (Phase 4) — stage-by-stage build replay data
 */

import type { UIMessage } from "ai";

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

/** A single replay stage — data-only, no closures. Each stage captures
 *  the SA's reasoning (messages) and blueprint mutations (emissions) for
 *  one logical step of the build process. */
export interface ReplayStage {
	header: string;
	subtitle?: string;
	messages: UIMessage[];
	emissions: Array<{ type: string; data: Record<string, unknown> }>;
}

/** Replay session data stored on the session store. `stages` is the full
 *  replay script; `doneIndex` tracks how far the user has advanced;
 *  `exitPath` is the URL to navigate to when replay ends; `messages` is
 *  the chat content for the currently-visible stage. */
export interface ReplayData {
	stages: ReplayStage[];
	doneIndex: number;
	exitPath: string;
	messages: UIMessage[];
}

/* The canonical session state type is `BuilderSessionState` in `store.ts`.
 * It includes both fields and actions. The types above are shared between
 * the store, hooks, and consumers. */
