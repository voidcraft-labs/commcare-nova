/**
 * builderStore — Zustand store for the Builder's complete reactive state.
 *
 * State is normalized into flat entity maps (modules, forms, questions)
 * keyed by UUID, with separate ordering arrays for tree structure. No
 * monolithic blueprint object — assembleBlueprint() reconstructs the
 * wire format at save/export time only.
 *
 * Middleware stack:
 * - **Immer** — mutable-syntax immutable updates with structural sharing.
 *   `draft.questions[uuid].label = 'x'` produces a new state where only
 *   `questions` and the changed question get new references.
 * - **zundo (temporal)** — undo/redo via history snapshots of entity data.
 *   Navigation lives in the URL (browser history handles back/forward).
 *   Transient interaction state (cursorMode, activeFieldId) is NOT tracked.
 * - **devtools** — Redux DevTools inspection in development.
 *
 * Created per buildId via `createBuilderStore()`. Scoped to the /build/{id}
 * page via React Context in BuilderProvider.
 */

import type { UIMessage } from "ai";
import { enableMapSet } from "immer";
import { temporal } from "zundo";
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
	ConnectConfig,
	ConnectType,
	FormType,
	PostSubmitDestination,
	Scaffold,
} from "@/lib/schemas/blueprint";
import type {
	NewQuestion,
	QuestionRenameResult,
	QuestionUpdate,
	RenameResult,
	SearchResult,
} from "./blueprintHelpers";
import {
	BuilderPhase,
	type GenerationError,
	GenerationStage,
	STAGE_LABELS,
} from "./builder";
import type { ReplayStage } from "./logReplay";
import {
	assembleBlueprint,
	decomposeBlueprint,
	getEntityData,
	type NForm,
	type NModule,
	type NQuestion,
} from "./normalizedState";
import type { QuestionPath } from "./questionPath";

/* Enable Immer's Map/Set support for any Map/Set values that might appear
 * in blueprint data (future-proofing — current schema uses plain objects). */
enableMapSet();

// ── Cursor mode ──────────────────────────────────────────────────────

export type CursorMode = "pointer" | "edit";

// ── Move result ─────────────────────────────────────────────────────

/** Returned by moveQuestion when a cross-level move triggers auto-rename
 *  to avoid a sibling ID collision (CommCare requires unique IDs per level). */
export interface MoveQuestionResult {
	renamed?: {
		oldId: string;
		newId: string;
		newPath: QuestionPath;
		xpathFieldsRewritten: number;
	};
}

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

	// ── View context ──
	/** Current cursor mode (inspect/text/pointer). */
	cursorMode: CursorMode;
	/** Which [data-field-id] element currently has focus. NOT tracked by zundo
	 *  — transient interaction state that stays at its live value through undo/redo. */
	activeFieldId: string | undefined;

	// ── Layout state (sidebar visibility) ──
	/** Whether the chat sidebar is open. Lives in the store (not component
	 *  state) so consumers subscribe directly — no prop drilling or cascade.
	 *  NOT tracked by zundo (transient UI state). */
	chatOpen: boolean;
	/** Whether the structure sidebar is open. Same rationale as chatOpen. */
	structureOpen: boolean;
	/** Stashed sidebar state from before entering pointer mode. Restored
	 *  when switching back to edit. Ref-like (only read at one moment —
	 *  the edit-mode transition) but stored here so switchCursorMode can
	 *  atomically stash/restore in a single set() call. */
	sidebarStash: { chatOpen: boolean; structureOpen: boolean } | undefined;

	// ── Entity data (normalized — flat maps + ordering arrays) ──
	appName: string;
	connectType: ConnectType | undefined;
	caseTypes: CaseType[];
	modules: Record<string, NModule>;
	forms: Record<string, NForm>;
	questions: Record<string, NQuestion>;
	moduleOrder: string[];
	formOrder: Record<string, string[]>;
	questionOrder: Record<string, string[]>;

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
	 *  as doc mutations instead of writing directly to the legacy store.
	 *  Not tracked by zundo (excluded by the `partialize` allow-list). */
	_docStore: BlueprintDocStore | null;
	setDocStore: (store: BlueprintDocStore | null) => void;

	// ── Actions ────────────────────────────────────────────────────────

	// -- Blueprint mutation actions --
	updateQuestion: (
		mIdx: number,
		fIdx: number,
		path: QuestionPath,
		updates: Partial<QuestionUpdate>,
	) => void;
	addQuestion: (
		mIdx: number,
		fIdx: number,
		question: NewQuestion,
		opts?: {
			afterPath?: QuestionPath;
			beforePath?: QuestionPath;
			atIndex?: number;
			parentPath?: QuestionPath;
		},
	) => string;
	removeQuestion: (mIdx: number, fIdx: number, path: QuestionPath) => void;
	moveQuestion: (
		mIdx: number,
		fIdx: number,
		path: QuestionPath,
		opts: {
			afterPath?: QuestionPath;
			beforePath?: QuestionPath;
			targetParentPath?: QuestionPath;
		},
	) => MoveQuestionResult;
	duplicateQuestion: (
		mIdx: number,
		fIdx: number,
		path: QuestionPath,
	) => { newPath: QuestionPath; newUuid: string };
	renameQuestion: (
		mIdx: number,
		fIdx: number,
		path: QuestionPath,
		newId: string,
	) => QuestionRenameResult;
	updateModule: (
		mIdx: number,
		updates: {
			name?: string;
			case_list_columns?: Array<{ field: string; header: string }>;
			case_detail_columns?: Array<{ field: string; header: string }> | null;
		},
	) => void;
	updateForm: (
		mIdx: number,
		fIdx: number,
		updates: {
			name?: string;
			type?: FormType;
			close_condition?: {
				question: string;
				answer: string;
				operator?: "=" | "selected";
			} | null;
			connect?: ConnectConfig | null;
			post_submit?: PostSubmitDestination | null;
		},
	) => void;
	replaceForm: (mIdx: number, fIdx: number, form: BlueprintForm) => void;
	addForm: (mIdx: number, form: BlueprintForm) => void;
	removeForm: (mIdx: number, fIdx: number) => void;
	addModule: (module: BlueprintModule) => void;
	removeModule: (mIdx: number) => void;
	updateApp: (updates: { app_name?: string; connect_type?: string }) => void;
	renameCaseProperty: (
		caseType: string,
		oldName: string,
		newName: string,
	) => RenameResult;
	updateCaseProperty: (
		caseTypeName: string,
		propertyName: string,
		updates: Record<string, unknown>,
	) => void;
	searchBlueprint: (query: string) => SearchResult[];

	// -- View context actions --
	setCursorMode: (mode: CursorMode) => void;
	setActiveFieldId: (fieldId: string | undefined) => void;
	/** Set chat sidebar visibility. */
	setChatOpen: (open: boolean) => void;
	/** Set structure sidebar visibility. */
	setStructureOpen: (open: boolean) => void;
	/** Atomically switch cursor mode with sidebar stash/restore.
	 *  Pointer mode stashes current sidebar state and closes both.
	 *  Edit mode restores the stashed state. Combines what was previously
	 *  handleCursorModeChange + refs + multiple setState calls in BuilderLayout
	 *  into one atomic store update. */
	switchCursorMode: (mode: CursorMode) => void;

	// -- Generation lifecycle actions --
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

	// -- Replay lifecycle actions --
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

// ── Undo/redo partialized state ────────────────────────────────────────

/** The slice of state that zundo tracks for undo/redo. Only entity data —
 *  navigation lives in the URL (browser history), and transient interaction
 *  state (cursorMode, activeFieldId) stays at its live value through undo. */
type UndoSlice = Pick<
	BuilderState,
	| "appName"
	| "connectType"
	| "caseTypes"
	| "modules"
	| "forms"
	| "questions"
	| "moduleOrder"
	| "formOrder"
	| "questionOrder"
>;

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
			temporal(
				subscribeWithSelector(
					immer((set, get) => ({
						// ── Initial state ──────────────────────────────────────

						phase: initialPhase,
						cursorMode: "edit" as CursorMode,
						activeFieldId: undefined,
						chatOpen: true,
						structureOpen: true,
						sidebarStash: undefined as
							| { chatOpen: boolean; structureOpen: boolean }
							| undefined,

						// Entity data (empty until blueprint is loaded/generated)
						appName: "",
						connectType: undefined,
						caseTypes: [] as CaseType[],
						modules: {} as Record<string, NModule>,
						forms: {} as Record<string, NForm>,
						questions: {} as Record<string, NQuestion>,
						moduleOrder: [] as string[],
						formOrder: {} as Record<string, string[]>,
						questionOrder: {} as Record<string, string[]>,

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

						// Phase 1b: doc store bridge (non-serializable, excluded
						// from undo by the partialize allow-list)
						_docStore: null as BlueprintDocStore | null,

						setDocStore(store) {
							set({ _docStore: store });
						},

						// ── Blueprint mutation actions ──────────────────────────

						updateQuestion(_mIdx, _fIdx, _path, _updates) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat while other
							// legacy-store consumers still reference the interface shape.
							// Phase 3 removes the action entirely when the legacy store is deleted.
						},

						addQuestion(_mIdx, _fIdx, _question, _opts?) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). Stub returns empty string for interface compat.
							return "";
						},

						removeQuestion(_mIdx, _fIdx, _path) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						moveQuestion(_mIdx, _fIdx, _path, _opts) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). Stub returns empty result for interface compat.
							return {} as MoveQuestionResult;
						},

						duplicateQuestion(_mIdx, _fIdx, _path) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). Stub returns empty sentinel for interface compat.
							return { newPath: "" as QuestionPath, newUuid: "" };
						},

						renameQuestion(_mIdx, _fIdx, _path, _newId) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). Stub returns empty sentinel for interface compat.
							return {
								newPath: "" as QuestionPath,
								xpathFieldsRewritten: 0,
							};
						},

						updateModule(_mIdx, _updates) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						updateForm(_mIdx, _fIdx, _updates) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						replaceForm(_mIdx, _fIdx, _form) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						addForm(_mIdx, _form) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						removeForm(_mIdx, _fIdx) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						addModule(_module) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						removeModule(_mIdx) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						updateApp(_updates) {
							// Phase 1b: entity mutations flow through useBlueprintMutations →
							// doc.apply(). This action is kept for signature-compat.
						},

						renameCaseProperty(_caseType, _oldName, _newName) {
							// Phase 1b: no UI caller invokes this action today. If a
							// case-property-rename feature is added, implement it as a
							// doc-level applyMany batch. Phase 3 deletes this stub
							// entirely when the legacy store is removed.
							return { formsChanged: [], columnsChanged: [] };
						},

						updateCaseProperty(caseTypeName, propertyName, updates) {
							set((draft) => {
								const ct = draft.caseTypes.find((c) => c.name === caseTypeName);
								if (!ct) return;
								const prop = ct.properties.find((p) => p.name === propertyName);
								if (!prop) return;
								Object.assign(prop, updates);
							});
						},

						searchBlueprint(query) {
							/* Assemble on-the-fly — searchBlueprint is read-only and
							 * called infrequently (SA agent search tool). */
							const s = get();
							if (s.moduleOrder.length === 0) return [];
							const bp = assembleBlueprint(getEntityData(s));
							const { searchBlueprint: bpSearch } =
								require("./blueprintHelpers") as typeof import("./blueprintHelpers");
							return bpSearch(bp, query);
						},

						// ── View context actions ──────────────────────────────

						setCursorMode(mode) {
							set({ cursorMode: mode });
						},

						setActiveFieldId(fieldId) {
							if (fieldId === get().activeFieldId) return;
							set({ activeFieldId: fieldId });
						},

						setChatOpen(open) {
							if (open === get().chatOpen) return;
							set({ chatOpen: open });
						},

						setStructureOpen(open) {
							if (open === get().structureOpen) return;
							set({ structureOpen: open });
						},

						switchCursorMode(mode) {
							const s = get();
							/* Guard against no-op switches. Without this, entering
							 * pointer mode twice overwrites the sidebar stash with
							 * { chatOpen: false, structureOpen: false }. */
							if (mode === s.cursorMode) return;

							if (mode === "pointer") {
								/* Stash current sidebar state, then close both for
								 * the immersive pointer mode experience. */
								set({
									cursorMode: mode,
									sidebarStash: {
										chatOpen: s.chatOpen,
										structureOpen: s.structureOpen,
									},
									chatOpen: false,
									structureOpen: false,
								});
							} else if (mode === "edit" && s.sidebarStash) {
								/* Restore pre-pointer sidebar state. */
								set({
									cursorMode: mode,
									chatOpen: s.sidebarStash.chatOpen,
									structureOpen: s.sidebarStash.structureOpen,
									sidebarStash: undefined,
								});
							} else {
								set({ cursorMode: mode });
							}
						},

						// ── Generation lifecycle actions ────────────────────────

						startGeneration() {
							set((draft) => {
								draft.phase = BuilderPhase.Generating;
								draft.generationStage = GenerationStage.DataModel;
								draft.generationError = null;
								draft.statusMessage = STAGE_LABELS[GenerationStage.DataModel];
								/* Clear entity data so treeData falls through to
								 * generationData during the build. */
								draft.appName = "";
								draft.connectType = undefined;
								draft.caseTypes = [];
								draft.modules = {};
								draft.forms = {};
								draft.questions = {};
								draft.moduleOrder = [];
								draft.formOrder = {};
								draft.questionOrder = {};
								draft.generationData = { partialModules: {} };
							});
						},

						setSchema(caseTypes) {
							// Entity write dispatched to the doc; the sync adapter
							// mirrors the result back to the legacy store's caseTypes.
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
							for (const [key, order] of Object.entries(
								scratch.questionOrder,
							)) {
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

						completeGeneration(blueprint) {
							set((draft) => {
								/* Decompose the final validated blueprint into normalized entities */
								const data = decomposeBlueprint(
									blueprint as import("@/lib/schemas/blueprint").AppBlueprint,
								);
								draft.appName = data.appName;
								draft.connectType = data.connectType;
								draft.caseTypes = data.caseTypes;
								draft.modules = data.modules;
								draft.forms = data.forms;
								draft.questions = data.questions;
								draft.moduleOrder = data.moduleOrder;
								draft.formOrder = data.formOrder;
								draft.questionOrder = data.questionOrder;

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

						loadApp(id, blueprint) {
							set((draft) => {
								const data = decomposeBlueprint(
									blueprint as import("@/lib/schemas/blueprint").AppBlueprint,
								);
								draft.appId = id;
								draft.appName = data.appName;
								draft.connectType = data.connectType;
								draft.caseTypes = data.caseTypes;
								draft.modules = data.modules;
								draft.forms = data.forms;
								draft.questions = data.questions;
								draft.moduleOrder = data.moduleOrder;
								draft.formOrder = data.formOrder;
								draft.questionOrder = data.questionOrder;

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
								draft.cursorMode = "edit";
								draft.activeFieldId = undefined;

								draft.appName = "";
								draft.connectType = undefined;
								draft.caseTypes = [];
								draft.modules = {};
								draft.forms = {};
								draft.questions = {};
								draft.moduleOrder = [];
								draft.formOrder = {};
								draft.questionOrder = {};

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
					/* zundo config: undo/redo tracks entity data only. Navigation
					 * lives in the URL (browser history handles back/forward).
					 * Transient interaction state (cursorMode, activeFieldId) is
					 * excluded — those stay at their live values through undo/redo. */
					partialize: (s): UndoSlice => ({
						appName: s.appName,
						connectType: s.connectType,
						caseTypes: s.caseTypes,
						modules: s.modules,
						forms: s.forms,
						questions: s.questions,
						moduleOrder: s.moduleOrder,
						formOrder: s.formOrder,
						questionOrder: s.questionOrder,
					}),
					/* Only create undo entries when entity data actually changes. */
					equality: (past, curr) =>
						past.modules === curr.modules &&
						past.forms === curr.forms &&
						past.questions === curr.questions &&
						past.moduleOrder === curr.moduleOrder &&
						past.formOrder === curr.formOrder &&
						past.questionOrder === curr.questionOrder &&
						past.appName === curr.appName &&
						past.connectType === curr.connectType &&
						past.caseTypes === curr.caseTypes,
					limit: 50,
				},
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
