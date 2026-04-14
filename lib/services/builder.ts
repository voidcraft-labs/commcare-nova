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
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "./questionPath";

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
	type: "module" | "form" | "question";
	moduleIndex: number;
	formIndex?: number;
	questionPath?: QuestionPath;
	/** Stable crypto UUID — the primary identity key for UI-layer concerns
	 *  (React keys, DOM selectors, dnd-kit, scroll targeting). Unlike
	 *  `questionPath` (which changes on rename), UUID never changes. */
	questionUuid?: string;
}

/** Scope the agent is currently editing — drives signal grid focus zone. */
export interface EditScope {
	moduleIndex: number;
	formIndex?: number;
	/** Flat question index within the form (0-based, depth-first). */
	questionIndex?: number;
}

/** Common shape for AppTree rendering — satisfied by both Scaffold and AppBlueprint */
export interface TreeData {
	app_name: string;
	connect_type?: string;
	modules: Array<{
		name: string;
		case_type?: string | null;
		purpose?: string;
		forms: Array<{
			name: string;
			type: string;
			purpose?: string;
			questions?: Question[];
			connect?: Record<string, unknown>;
		}>;
		case_list_columns?: Array<{ field: string; header: string }> | null;
		case_detail_columns?: Array<{ field: string; header: string }> | null;
	}>;
}
