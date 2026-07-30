/**
 * UI-shared structural types consumed across the builder surface.
 *
 * These types don't belong to any single store. `BuilderPhase` is derived
 * from session + doc state in `hooks.tsx::derivePhase`; `EditScope` drives the
 * signal grid's focus zone during agent edits.
 */

/** Builder lifecycle phases — what mode the builder is in right now. */
export enum BuilderPhase {
	Idle = "idle",
	Loading = "loading",
	Generating = "generating",
	/** Transient confirmation phase — a generation or edit just finished
	 *  successfully. Auto-decays to Ready after the confirmation is readable. */
	Completed = "completed",
	Ready = "ready",
}

/** Scope the agent is currently editing — drives signal grid focus zone. */
export interface EditScope {
	moduleUuid: string;
	formUuid?: string;
	fieldUuid?: string;
}
