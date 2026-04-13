/**
 * Builder state re-architecture — ephemeral session type definitions.
 *
 * Everything in this store lives only while the builder route is mounted
 * and is NEVER undoable. Separating from BlueprintDoc means there's no
 * risk of UI state bleeding into undo history and no need for a partialize
 * allow-list — the two stores have disjoint responsibilities.
 *
 * Phase 3 builds the actual store, reducer-shaped actions, and hook API.
 * This file only declares the types those pieces will conform to.
 */

import type { Uuid } from "@/lib/doc/types";
import type { ConnectType } from "@/lib/schemas/blueprint";

/** Lifecycle phases of the builder. */
export type BuilderPhase = "idle" | "loading" | "ready" | "completed";

/** Interaction mode. "edit" = click to select + inline text editing;
 *  "pointer" = live form-fill preview. */
export type CursorMode = "edit" | "pointer";

/**
 * UI-facing representation of a failed agent stream. Phase 4 will map the
 * route handler's internal `GenerationError` enum onto this shape; defining
 * `AgentError` here keeps the session store free of a cross-layer import
 * until Phase 4 lands.
 */
export type AgentError = { code: string; message: string };

/**
 * Visibility + stash state for one sidebar column. `open` is current
 * visibility; `stashed` records whether we should reopen when leaving edit
 * mode. See `switchCursorMode` in Phase 3.
 */
export type SidebarState = { open: boolean; stashed: boolean };

/**
 * The ephemeral builder session.
 *
 * Field layout mirrors the spec exactly: flat agent fields (not nested
 * under an `agent:` object) so that selector hooks can subscribe to
 * `agentActive` without pulling the full agent payload on every render.
 *
 * Keys grouped by concern:
 *   - Lifecycle (`phase`, `agent*`, `postBuildEdit`) for what mode we're in.
 *   - Interaction (`cursorMode`, `activeFieldId`) for how the user is editing.
 *   - Chrome (`sidebars`) for layout.
 *   - Connect stash (`connectStash`, `lastConnectType`) for learn↔deliver
 *     toggle preservation within a session.
 */
export type BuilderSession = {
	phase: BuilderPhase;
	agentActive: boolean;
	agentStage?: string;
	agentError?: AgentError;
	postBuildEdit: boolean;

	cursorMode: CursorMode;
	activeFieldId?: Uuid;

	sidebars: {
		chat: SidebarState;
		structure: SidebarState;
	};

	/**
	 * Saved form-connect configs from the non-active connect mode, keyed by
	 * mode. Ephemeral: lost on reload. Same lifecycle as today's
	 * `BuilderEngine._connectStash` Map. `FormConnect` is currently typed in
	 * `lib/schemas/blueprint.ts` but Phase 3 will import it directly;
	 * `unknown` is a deliberate placeholder here to keep Phase 0 free of
	 * wire-through-session dependencies that none of the Phase 0 code
	 * actually exercises.
	 */
	connectStash: Partial<Record<ConnectType, Record<Uuid, unknown>>>;
	lastConnectType?: ConnectType;
};
