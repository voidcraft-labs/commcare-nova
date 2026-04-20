/**
 * builder.ts — Shared type definitions for the builder UI.
 *
 * `applyDataPart` and the generation-stream dispatcher have been replaced
 * by `applyStreamEvent` in `lib/generation/streamDispatcher.ts`. Generation
 * lifecycle types (`GenerationStage`, `GenerationError`, `STAGE_LABELS`)
 * now live exclusively in `lib/session/types.ts`.
 *
 * What remains here: structural types consumed across the builder surface
 * that don't belong to any single store.
 */
import type { FieldPath } from "./fieldPath";

/** Builder lifecycle phases — what mode the builder is in right now.
 *  Phase is now derived from session + doc state via `derivePhase` in
 *  `lib/session/hooks.tsx`. The enum still lives here because it's
 *  imported by layout, content area, sidebar, and tree components. */
export enum BuilderPhase {
	Idle = "idle",
	Loading = "loading",
	Generating = "generating",
	/** Transient celebration phase — a generation or edit just finished successfully.
	 *  Auto-decays to Ready after the signal grid's done animation settles. */
	Completed = "completed",
	Ready = "ready",
}

export interface SelectedElement {
	type: "module" | "form" | "field";
	moduleIndex: number;
	formIndex?: number;
	fieldPath?: FieldPath;
	/** Stable crypto UUID — the primary identity key for UI-layer concerns
	 *  (React keys, DOM selectors, dnd-kit, scroll targeting). Unlike
	 *  `fieldPath` (which changes on rename), UUID never changes. */
	fieldUuid?: string;
}

/** Scope the agent is currently editing — drives signal grid focus zone. */
export interface EditScope {
	moduleIndex: number;
	formIndex?: number;
	/** Flat field index within the form (0-based, depth-first). */
	fieldIndex?: number;
}
