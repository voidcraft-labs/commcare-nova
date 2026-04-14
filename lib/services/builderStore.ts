/**
 * builderStore — legacy Zustand store for Builder session state.
 *
 * Phase 3 status: this store has been reduced to a session-state store.
 * All blueprint entity data (modules, forms, questions, app metadata) now
 * lives exclusively on the BlueprintDoc store (`lib/doc/store.ts`), which
 * owns mutations, undo/redo, and the generation-stream data path.
 *
 * What remains here:
 * - **Lifecycle**: builder `phase`, agent-active flag, post-build edit flag
 * - **Generation metadata**: current stage, progress counters, error state,
 *   status message, and the in-flight `generationData` scaffold accumulator
 * - **App identity**: `appId` (Firestore document ID)
 * - **Replay**: stages, done index, exit path, and the current stage's messages
 * - **Doc bridge**: `_docStore` reference, installed by SyncBridge on mount so
 *   generation-stream setters (setScaffold, setFormContent, etc.) can dispatch
 *   entity mutations into the doc without a direct import
 *
 * Middleware stack (outer → inner):
 * - **devtools** — Redux DevTools inspection in development
 * - **subscribeWithSelector** — fine-grained subscriptions for session fields
 * - **immer** — mutable-syntax immutable updates with structural sharing
 *
 * Undo/redo is NOT on this store. The doc store's zundo middleware tracks
 * blueprint history — this store has nothing worth undoing (session state).
 *
 * Phase 4 will delete this store entirely: remaining lifecycle/generation
 * fields migrate to a dedicated session store or to React-local state.
 */

import type { UIMessage } from "ai";
import { enableMapSet } from "immer";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createStore } from "zustand/vanilla";
import { toDoc } from "@/lib/doc/converter";
import type { BlueprintDocStore } from "@/lib/doc/provider";
import {
	asUuid,
	type FormEntity,
	type Mutation,
	type QuestionEntity,
	type Uuid,
} from "@/lib/doc/types";
import type {
	BlueprintForm,
	BlueprintModule,
	CaseType,
	FormType,
	Scaffold,
} from "@/lib/schemas/blueprint";
import {
	BuilderPhase,
	type GenerationError,
	GenerationStage,
	STAGE_LABELS,
} from "./builder";
import type { ReplayStage } from "./logReplay";

/* Enable Immer's Map/Set support for any Map/Set values that might appear
 * in session data (future-proofing — current fields are plain objects). */
enableMapSet();

// ── Generation-time partial state ──────────────────────────────────────

/** Intermediate scaffold data streamed before the full Scaffold arrives. */
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

/** Partial module data being built during streaming generation.
 *  caseListColumns is undefined (not yet received), null (server said no columns), or an array. */
export interface PartialModule {
	caseListColumns?: Array<{ field: string; header: string }> | null;
	/** Forms keyed by formIndex. Record for JSON-serializable devtools compat. */
	forms: Record<number, BlueprintForm>;
}

/** All generation-time state. Only set during the Generating phase.
 *  Cleared on completeGeneration() or reset(). */
export interface GenerationData {
	partialScaffold?: PartialScaffoldData;
	scaffold?: Scaffold;
	/** Partial modules keyed by moduleIndex. */
	partialModules: Record<number, PartialModule>;
}

// ── Store state interface ──────────────────────────────────────────────

export interface BuilderState {
	// ── Lifecycle ──
	phase: BuilderPhase;

	// ── Generation metadata ──
	generationStage: GenerationStage | null;
	generationError: GenerationError;
	statusMessage: string;
	agentActive: boolean;
	postBuildEdit: boolean;

	// ── Generation-time partial state ──
	generationData: GenerationData | undefined;

	// ── Progress ──
	progressCompleted: number;
	progressTotal: number;

	// ── App persistence ──
	appId: string | undefined;

	// ── Replay ──
	/** Replay stages for replay mode. Undefined when not replaying. */
	replayStages: ReplayStage[] | undefined;
	/** Index of the final "Done" stage in replayStages (ReplayController starts here). */
	replayDoneIndex: number;
	/** Path to navigate to when exiting replay mode (set by the replay route). */
	replayExitPath: string | undefined;
	/** Chat messages for the current replay stage. Written by ReplayController
	 *  (via store action), read by ChatContainer. Stored here so the two
	 *  components communicate through the store, not through a shared parent. */
	replayMessages: UIMessage[];

	// ── Phase 1b: doc store bridge ──
	/** Reference to the BlueprintDoc store, installed by SyncBridge after
	 *  provider mount. Generation setters use this to dispatch entity changes
	 *  as doc mutations — the doc store is the single source of truth for
	 *  blueprint data, so the legacy store never stores entities itself. */
	_docStore: BlueprintDocStore | null;
	setDocStore: (store: BlueprintDocStore | null) => void;

	// ── Generation lifecycle actions ──────────────────────────────────

	startGeneration: () => void;
	setSchema: (caseTypes: CaseType[]) => void;
	setPartialScaffold: (partial: Record<string, unknown>) => void;
	setScaffold: (scaffold: Scaffold) => void;
	setModuleContent: (
		moduleIndex: number,
		caseListColumns: Array<{ field: string; header: string }> | null,
	) => void;
	setFormContent: (
		moduleIndex: number,
		formIndex: number,
		form: BlueprintForm,
	) => void;
	advanceStage: (stage: string) => void;
	setFixAttempt: (attempt: number, errorCount: number) => void;
	completeGeneration: (blueprint: {
		app_name: string;
		modules: BlueprintModule[];
		case_types?: CaseType[] | null;
		connect_type?: string;
	}) => void;
	acknowledgeCompletion: () => void;
	setAppId: (id: string) => void;
	loadApp: (
		id: string,
		blueprint: {
			app_name: string;
			modules: BlueprintModule[];
			case_types?: CaseType[] | null;
			connect_type?: string;
		},
	) => void;
	setAgentActive: (active: boolean) => void;
	setGenerationError: (
		message: string,
		severity?: "failed" | "recovering",
	) => void;

	// ── Replay lifecycle actions ──────────────────────────────────────

	/** Hydrate replay metadata into the store. Stage application (applyToBuilder)
	 *  is handled separately by the engine factory. */
	loadReplay: (
		stages: ReplayStage[],
		doneIndex: number,
		exitPath: string,
	) => void;
	/** Set replay messages for the current stage. Called by ReplayController
	 *  when navigating between stages, read by ChatContainer for display. */
	setReplayMessages: (messages: UIMessage[]) => void;
	reset: () => void;
}

// ── Generation-stream doc helpers ─────────────────────────────────────

/**
 * Convert a Scaffold (server-emitted structure) into a doc Mutation batch
 * that creates modules and their empty forms in order. Module and form
 * UUIDs are minted here — the same pattern as `toDoc` for new entities.
 *
 * Used by `setScaffold` to dispatch to the BlueprintDoc. Progress state
 * on the legacy store's `generationData` is separately updated inside
 * `setScaffold`'s `set()` callback.
 */
function scaffoldToMutations(scaffold: Scaffold): Mutation[] {
	const mutations: Mutation[] = [];

	// App-level fields
	mutations.push({ kind: "setAppName", name: scaffold.app_name });
	if (
		scaffold.connect_type === "learn" ||
		scaffold.connect_type === "deliver"
	) {
		mutations.push({
			kind: "setConnectType",
			connectType: scaffold.connect_type,
		});
	}

	for (const sm of scaffold.modules) {
		const moduleUuid = asUuid(crypto.randomUUID());
		mutations.push({
			kind: "addModule",
			module: {
				uuid: moduleUuid,
				name: sm.name,
				caseType: sm.case_type ?? undefined,
				caseListOnly: sm.case_list_only ?? undefined,
				purpose: sm.purpose ?? undefined,
				caseListColumns: undefined,
				caseDetailColumns: undefined,
			},
		});

		for (const sf of sm.forms) {
			const formUuid = asUuid(crypto.randomUUID());
			mutations.push({
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: formUuid,
					name: sf.name,
					type: sf.type as FormType,
					purpose: sf.purpose ?? undefined,
					closeCondition: undefined,
					connect: undefined,
					postSubmit: sf.post_submit ?? undefined,
					formLinks: undefined,
				},
			});
		}
	}

	return mutations;
}

// ── Store factory ──────────────────────────────────────────────────────

/** The Zustand store API type — used for context typing. */
export type BuilderStoreApi = ReturnType<typeof createBuilderStore>;

/** Create a scoped Zustand store for a builder session.
 *  Called once per buildId by BuilderProvider. */
export function createBuilderStore(initialPhase: BuilderPhase) {
	return createStore<BuilderState>()(
		devtools(
			subscribeWithSelector(
				immer((set, get) => ({
					// ── Initial state ──────────────────────────────────────

					phase: initialPhase,

					generationStage: null,
					generationError: null,
					statusMessage: "",
					agentActive: false,
					postBuildEdit: false,
					generationData: undefined,
					progressCompleted: 0,
					progressTotal: 0,
					appId: undefined,

					replayStages: undefined,
					replayDoneIndex: 0,
					replayExitPath: undefined,
					replayMessages: [] as UIMessage[],

					// Doc store bridge (non-serializable — generation setters
					// dispatch entity changes through this reference).
					_docStore: null as BlueprintDocStore | null,

					setDocStore(store) {
						set({ _docStore: store });
					},

					// ── Generation lifecycle actions ────────────────────────

					startGeneration() {
						set((draft) => {
							draft.phase = BuilderPhase.Generating;
							draft.generationStage = GenerationStage.DataModel;
							draft.generationError = null;
							draft.statusMessage = STAGE_LABELS[GenerationStage.DataModel];
							draft.generationData = { partialModules: {} };
						});
					},

					setSchema(caseTypes) {
						// Entity write dispatched to the doc — case types are doc state,
						// the legacy store no longer tracks them.
						const docStore = get()._docStore;
						if (!docStore) return;
						docStore.getState().apply({ kind: "setCaseTypes", caseTypes });
					},

					setPartialScaffold(partial) {
						const modules = partial?.modules as
							| Array<Record<string, unknown>>
							| undefined;
						if (!modules?.length) return;

						const parsed: PartialScaffoldData = {
							appName: partial.app_name as string | undefined,
							modules: modules
								.filter((m) => m?.name)
								.map((m) => ({
									name: m.name as string,
									case_type: m.case_type as string | undefined,
									purpose: m.purpose as string | undefined,
									forms: (
										(m.forms as Array<Record<string, unknown>> | undefined) ??
										[]
									)
										.filter((f) => f?.name)
										.map((f) => ({
											name: f.name as string,
											type: f.type as string,
											purpose: f.purpose as string | undefined,
										})),
								})),
						};

						set((draft) => {
							draft.generationStage = GenerationStage.Structure;
							draft.statusMessage = STAGE_LABELS[GenerationStage.Structure];
							if (!draft.generationData)
								draft.generationData = {
									partialModules: {},
								};
							draft.generationData.partialScaffold = parsed;
						});
					},

					setScaffold(scaffold) {
						// Progress tracking on the legacy store (session state).
						set((draft) => {
							if (!draft.generationData)
								draft.generationData = { partialModules: {} };
							draft.generationData.scaffold = scaffold;
							draft.generationData.partialScaffold = undefined;
						});

						// Entity writes dispatched to the doc as a single atomic
						// batch — collapses to one undoable unit after endAgentWrite.
						const docStore = get()._docStore;
						if (!docStore) return;
						docStore.getState().applyMany(scaffoldToMutations(scaffold));
					},

					setModuleContent(moduleIndex, caseListColumns) {
						// Progress tracking (session state).
						set((draft) => {
							if (!draft.generationData)
								draft.generationData = { partialModules: {} };
							const partial = draft.generationData.partialModules[
								moduleIndex
							] ?? { forms: {} };
							partial.caseListColumns = caseListColumns;
							draft.generationData.partialModules[moduleIndex] = partial;

							const progress = computeProgress(draft.generationData);
							draft.progressCompleted = progress.completed;
							draft.progressTotal = progress.total;
						});

						// Entity write dispatched to the doc.
						const docStore = get()._docStore;
						if (!docStore) return;
						const doc = docStore.getState();
						const moduleUuid = doc.moduleOrder[moduleIndex];
						if (!moduleUuid) return;
						doc.apply({
							kind: "updateModule",
							uuid: moduleUuid,
							patch: {
								caseListColumns: caseListColumns ?? undefined,
							},
						});
					},

					setFormContent(moduleIndex, formIndex, form) {
						// Progress tracking (session state).
						set((draft) => {
							if (!draft.generationData)
								draft.generationData = { partialModules: {} };
							const partial = draft.generationData.partialModules[
								moduleIndex
							] ?? { forms: {} };
							partial.forms[formIndex] = form;
							draft.generationData.partialModules[moduleIndex] = partial;

							const progress = computeProgress(draft.generationData);
							draft.progressCompleted = progress.completed;
							draft.progressTotal = progress.total;
						});

						// Entity write dispatched to the doc via replaceForm.
						const docStore = get()._docStore;
						if (!docStore) return;
						const doc = docStore.getState();
						const moduleUuid = doc.moduleOrder[moduleIndex];
						if (!moduleUuid) return;
						const formUuid = doc.formOrder[moduleUuid]?.[formIndex];
						if (!formUuid) return;

						// Build a scratch doc from the incoming form, then re-key
						// to the real formUuid so replaceForm swaps in-place.
						const scratch = toDoc(
							{
								app_name: "",
								connect_type: undefined,
								case_types: null,
								modules: [{ name: "__scratch__", forms: [form] }],
							},
							"",
						);
						const scratchModuleUuid = scratch.moduleOrder[0];
						const scratchFormUuid = scratch.formOrder[scratchModuleUuid][0];
						const scratchForm = scratch.forms[scratchFormUuid];

						// Preserve the scaffold-set purpose — BlueprintForm doesn't
						// carry purpose, so toDoc produces `purpose: undefined`.
						const existingForm = doc.forms[formUuid];
						const replacement: FormEntity = {
							...scratchForm,
							uuid: formUuid,
							purpose: existingForm?.purpose ?? scratchForm.purpose,
						};

						// Re-key question ordering: replace the scratch form UUID
						// with the real form UUID; nested group/repeat keys pass
						// through unchanged (they're question UUIDs, not form UUIDs).
						const questions = Object.values(
							scratch.questions,
						) as QuestionEntity[];
						const questionOrder: Record<Uuid, Uuid[]> = {};
						for (const [key, order] of Object.entries(scratch.questionOrder)) {
							questionOrder[
								key === scratchFormUuid ? formUuid : (key as Uuid)
							] = order;
						}

						doc.apply({
							kind: "replaceForm",
							uuid: formUuid,
							form: replacement,
							questions,
							questionOrder,
						});
					},

					advanceStage(stage) {
						const stageMap: Record<string, GenerationStage> = {
							structure: GenerationStage.Structure,
							modules: GenerationStage.Modules,
							forms: GenerationStage.Forms,
							validate: GenerationStage.Validate,
							fix: GenerationStage.Fix,
						};
						const newStage = stageMap[stage];
						if (!newStage) return;

						set((draft) => {
							draft.generationStage = newStage;
							draft.generationError = null;
							draft.statusMessage = STAGE_LABELS[newStage];

							const progress = draft.generationData
								? computeProgress(draft.generationData)
								: { completed: 0, total: 0 };
							draft.progressCompleted = progress.completed;
							draft.progressTotal = progress.total;
						});
					},

					setFixAttempt(attempt, errorCount) {
						set({
							statusMessage: `${STAGE_LABELS[GenerationStage.Fix]} — ${errorCount} error${errorCount !== 1 ? "s" : ""} (attempt ${attempt})`,
						});
					},

					completeGeneration(_blueprint) {
						/* Entity data already lives on the doc store — during initial
						 * generation the stream setters (setScaffold, setFormContent)
						 * wrote directly to the doc. We only transition the builder's
						 * lifecycle flags here. The `blueprint` argument is preserved in
						 * the signature for future Phase 4 rewrite (when the full blueprint
						 * arrival signal may want to `doc.load()` for edit-mode replacement). */
						set((draft) => {
							draft.phase = BuilderPhase.Completed;
							draft.generationStage = null;
							draft.generationError = null;
							draft.postBuildEdit = false;
							draft.statusMessage = "";
							draft.generationData = undefined;
							draft.progressCompleted = 0;
							draft.progressTotal = 0;
						});
					},

					acknowledgeCompletion() {
						if (get().phase !== BuilderPhase.Completed) return;
						set({ phase: BuilderPhase.Ready });
					},

					setAppId(id) {
						set({ appId: id });
					},

					loadApp(id, _blueprint) {
						/* The BlueprintDocProvider already hydrated the doc store from
						 * the initialBlueprint prop at mount time; this action only
						 * transitions the legacy store's lifecycle flags. The blueprint
						 * argument is kept in the signature so callers (engine factory,
						 * tests) can pass it without knowing whether the action writes
						 * it — Phase 4 will drop the argument entirely when this action
						 * is deleted. */
						set((draft) => {
							draft.appId = id;
							draft.phase = BuilderPhase.Ready;
							draft.generationStage = null;
							draft.generationError = null;
							draft.postBuildEdit = false;
							draft.statusMessage = "";
							draft.generationData = undefined;
						});
					},

					setAgentActive(active) {
						const s = get();
						if (s.agentActive === active) return;
						set((draft) => {
							draft.agentActive = active;
							if (
								active &&
								(s.phase === BuilderPhase.Ready ||
									s.phase === BuilderPhase.Completed)
							) {
								draft.phase = BuilderPhase.Ready;
								draft.postBuildEdit = true;
							}
						});
					},

					setGenerationError(message, severity = "failed") {
						set((draft) => {
							draft.generationError = { message, severity };
							draft.statusMessage = message;
							if (severity === "failed" && draft.generationData) {
								draft.generationData.partialModules = {};
							}
						});
					},

					loadReplay(stages, doneIndex, exitPath) {
						set((draft) => {
							draft.replayStages = stages;
							draft.replayDoneIndex = doneIndex;
							draft.replayExitPath = exitPath;
							/* Initialize replay messages to the done stage's messages
							 * so ChatContainer has content immediately on mount. */
							draft.replayMessages = stages[doneIndex]?.messages ?? [];
						});
					},

					setReplayMessages(messages) {
						set({ replayMessages: messages });
					},

					reset() {
						set((draft) => {
							draft.phase = BuilderPhase.Idle;

							draft.generationStage = null;
							draft.generationError = null;
							draft.statusMessage = "";
							draft.agentActive = false;
							draft.postBuildEdit = false;
							draft.generationData = undefined;
							draft.progressCompleted = 0;
							draft.progressTotal = 0;
							draft.appId = undefined;
							draft.replayMessages = [];
						});
					},
				})),
			),
			{
				name: "BuilderStore",
				enabled: process.env.NODE_ENV === "development",
			},
		),
	);
}

// ── Internal helpers ───────────────────────────────────────────────────

/** Compute generation progress from partialModules data. */
function computeProgress(gen: GenerationData): {
	completed: number;
	total: number;
} {
	if (!gen.scaffold) return { completed: 0, total: 0 };

	const total =
		gen.scaffold.modules.length +
		gen.scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0);

	let completed = 0;
	for (const key of Object.keys(gen.partialModules)) {
		const partial = gen.partialModules[Number(key)];
		if (partial.caseListColumns !== undefined) completed++;
		completed += Object.keys(partial.forms).length;
	}

	return { completed, total };
}
