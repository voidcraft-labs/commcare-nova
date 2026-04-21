/**
 * UI-shared structural types consumed across the builder surface.
 *
 * These types don't belong to any single store. `BuilderPhase` is derived
 * from session + doc state in `hooks.tsx::derivePhase`; `SelectedElement`
 * models the URL-owned selection; `EditScope` drives the signal grid's
 * focus zone during agent edits.
 */
import type { FieldPath } from "@/lib/doc/fieldPath";

/** Builder lifecycle phases — what mode the builder is in right now. */
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
	 *  (React keys, DOM selectors, drag-and-drop, scroll targeting). Unlike
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
