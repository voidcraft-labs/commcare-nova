/**
 * builder.ts — Type definitions and the applyDataPart dispatcher.
 *
 * This file is the canonical source for all builder-related types:
 * BuilderPhase, GenerationStage, SelectedElement, TreeData, etc.
 *
 * State management is split across two stores: the legacy `builderStore.ts`
 * carries session/lifecycle state (phase, progress, error, replay metadata),
 * and the BlueprintDoc store (`lib/doc/store.ts`) owns all entity data plus
 * undo/redo via its zundo middleware. The BuilderEngine (`builderEngine.ts`)
 * is a thin non-reactive adapter that both stores hang off of.
 */
import type {
	AppBlueprint,
	BlueprintForm,
	CaseType,
	Question,
	Scaffold,
} from "@/lib/schemas/blueprint";
import { signalGrid } from "@/lib/signalGrid/store";
import type { BuilderEngine } from "./builderEngine";
import type { QuestionPath } from "./questionPath";

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
			signalGrid.injectEnergy(200);
			break;
		case "data-form-updated":
		case "data-blueprint-updated":
			signalGrid.injectEnergy(100);
			break;
		case "data-phase":
		case "data-schema":
		case "data-scaffold":
		case "data-partial-scaffold":
		case "data-fix-attempt":
			signalGrid.injectEnergy(50);
			break;
	}

	switch (type) {
		case "data-start-build":
			store.startGeneration();
			/* Pause doc-store undo tracking for the duration of the agent write
			 * stream. Every intermediate stage setter (setScaffold, setFormContent,
			 * setModuleContent) dispatches mutations into the doc — without this
			 * pause, each stage would enter the undo history as a separate entry.
			 * `endAgentWrite` on `data-done` resumes tracking; the entire build
			 * then collapses into a single undoable snapshot from the user's POV.
			 *
			 * Fresh builds in this session don't strictly need this because the
			 * `BlueprintDocProvider` starts with `startTracking={false}` for new
			 * apps. Re-generations (second build in the same session) run with
			 * tracking LIVE, so this call is what keeps their history clean. */
			engine.docStore?.getState().beginAgentWrite();
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
			/* Full blueprint replacement during a post-build edit. The SA's
			 * coarse edit tools (updateModule, createModule, removeModule,
			 * createForm, removeForm, renameCaseProperty, cross-form rename)
			 * emit this with the entire new blueprint.
			 *
			 * The doc store is the single source of truth for entity data, so
			 * we must dispatch the blueprint there — `docStore.load()` replaces
			 * the entire normalized state atomically. Before T11 this path was
			 * covered indirectly by the legacy store's `decomposeBlueprint` +
			 * the syncOldFromDoc adapter; both are gone, so without a direct
			 * `docStore.load()` the SA's edit vanishes silently.
			 *
			 * `load()` pauses and clears undo history, so we immediately resume
			 * tracking on the doc store — the edit should be undoable. Preserve
			 * `postBuildEdit` so the signal grid stays in edit mode instead of
			 * falling back to "reasoning" after the first mutation. */
			const bp = data.blueprint as AppBlueprint;
			const { postBuildEdit, appId } = engine.store.getState();
			const docStore = engine.docStore;
			if (docStore) {
				docStore.getState().load(bp, appId ?? "");
				/* Resume tracking so subsequent user edits enter the undo stack
				 * (load() leaves temporal paused and cleared). */
				docStore.getState().endAgentWrite();
			}
			store.completeGeneration();
			engine.store.setState({ phase: BuilderPhase.Ready, postBuildEdit });
			break;
		}
		case "data-fix-attempt":
			store.setFixAttempt(data.attempt as number, data.errorCount as number);
			break;
		case "data-done": {
			/* Generation is complete. Reconcile the doc store against the final
			 * authoritative blueprint the route handler just returned — during
			 * streaming, the form-fix loop (`validateAndFix`) can mutate forms
			 * silently without emitting per-fix `data-form-fixed` events in some
			 * code paths, which would leave the doc diverged from the server's
			 * canonical result. A single `load()` brings the doc into perfect
			 * sync at the end of the run. `load()` pauses temporal and clears
			 * history (everything up to this point is agent-authored, not
			 * user-undoable), so we resume afterward via `endAgentWrite` —
			 * which also pairs with the `beginAgentWrite` call on
			 * `data-start-build` for re-generations running with live tracking. */
			const result = data as { blueprint: AppBlueprint };
			const docStore = engine.docStore;
			if (docStore && result.blueprint) {
				const appId = engine.store.getState().appId ?? "";
				docStore.getState().load(result.blueprint, appId);
			}
			store.completeGeneration();
			/* Resume undo tracking on the doc store. From this point on, user
			 * edits enter the undo stack as individual entries. The generation
			 * stream as a whole is NOT undoable — the user cannot "undo" back
			 * to an empty app. */
			docStore?.getState().endAgentWrite();
			break;
		}
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
