/**
 * builder.ts — Type definitions and the applyDataPart dispatcher.
 *
 * This file is the canonical source for all builder-related types:
 * BuilderPhase, GenerationStage, SelectedElement, TreeData, etc.
 *
 * State management lives in builderStore.ts (Zustand + Immer + zundo).
 * The BuilderEngine (builderEngine.ts) is a thin adapter for non-reactive state.
 */
import type {
	AppBlueprint,
	BlueprintForm,
	CaseType,
	Question,
	Scaffold,
} from "@/lib/schemas/blueprint";
import type { BuilderEngine } from "./builderEngine";
import type { QuestionPath } from "./questionPath";

export type { CursorMode } from "./builderStore";

/** Apply a data part to a builder engine — shared between real-time streaming (onData) and replay. */
export function applyDataPart(
	engine: BuilderEngine,
	type: string,
	data: Record<string, unknown>,
): void {
	const store = engine.store.getState();

	/* Inject energy for signal grid based on data part significance */
	switch (type) {
		case "data-module-done":
		case "data-form-done":
		case "data-form-fixed":
			engine.injectEnergy(200);
			break;
		case "data-form-updated":
		case "data-blueprint-updated":
			engine.injectEnergy(100);
			break;
		case "data-phase":
		case "data-schema":
		case "data-scaffold":
		case "data-partial-scaffold":
		case "data-fix-attempt":
			engine.injectEnergy(50);
			break;
	}

	switch (type) {
		case "data-start-build":
			store.startGeneration();
			break;
		case "data-schema":
			store.setSchema(data.caseTypes as CaseType[]);
			break;
		case "data-partial-scaffold":
			store.setPartialScaffold(data);
			break;
		case "data-scaffold":
			store.setScaffold(data as unknown as Scaffold);
			break;
		case "data-phase":
			store.advanceStage(data.phase as string);
			break;
		case "data-module-done":
			store.setModuleContent(
				data.moduleIndex as number,
				(data.caseListColumns as Array<{
					field: string;
					header: string;
				}> | null) ?? null,
			);
			break;
		case "data-form-done":
		case "data-form-fixed":
		case "data-form-updated":
			store.setFormContent(
				data.moduleIndex as number,
				data.formIndex as number,
				data.form as BlueprintForm,
			);
			break;
		case "data-blueprint-updated": {
			/* Full blueprint replacement during edit — set directly in the store.
			 * completeGeneration() decomposes the blueprint into normalized entities
			 * but also resets generation flags (phase, postBuildEdit). Preserve
			 * postBuildEdit so fresh-edit sessions keep "editing" mode on the signal
			 * grid — without this, the first mutation clears postBuildEdit and the
			 * grid falls back to "reasoning" ("Thinking") for the rest of the session. */
			const bp = data.blueprint as AppBlueprint;
			const { postBuildEdit } = engine.store.getState();
			store.completeGeneration(bp);
			engine.store.setState({ phase: BuilderPhase.Ready, postBuildEdit });
			break;
		}
		case "data-fix-attempt":
			store.setFixAttempt(data.attempt as number, data.errorCount as number);
			break;
		case "data-done":
			store.completeGeneration((data as { blueprint: AppBlueprint }).blueprint);
			/* Resume undo tracking — generation is complete, user edits are now
			 * undoable. Tracking was paused in the engine constructor so intermediate
			 * generation steps (scaffold, addModule, addQuestions) stay out of history. */
			engine.store.temporal.getState().resume();
			break;
		case "data-app-saved":
			store.setAppId(data.appId as string);
			break;
		case "data-error":
			store.setGenerationError(
				data.message as string,
				(data.fatal as boolean) ? "failed" : "recovering",
			);
			break;
	}
}

/** Builder lifecycle phases — what mode the builder is in right now.
 *  Generation progress (DataModel→Fix) is tracked separately via GenerationStage. */
export enum BuilderPhase {
	Idle = "idle",
	Loading = "loading",
	Generating = "generating",
	/** Transient celebration phase — a generation or edit just finished successfully.
	 *  Auto-decays to Ready after the signal grid's done animation settles. */
	Completed = "completed",
	Ready = "ready",
}

/** Progress stages within a generation run — metadata on the Generating phase.
 *  Only meaningful when `builder.phase === Generating`. */
export enum GenerationStage {
	DataModel = "data-model",
	Structure = "structure",
	Modules = "modules",
	Forms = "forms",
	Validate = "validate",
	Fix = "fix",
}

/** Error state during generation — metadata, not a phase.
 *  The builder stays in Generating; this describes what went wrong. */
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
