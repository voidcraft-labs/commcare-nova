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
 * - **zundo (temporal)** — undo/redo via history snapshots of entity data
 *   + navigation context. Transient interaction state (selected, cursorMode,
 *   activeFieldId) is NOT tracked — undo restores data and navigation only.
 * - **devtools** — Redux DevTools inspection in development.
 *
 * Created per buildId via `createBuilderStore()`. Scoped to the /build/{id}
 * page via React Context in BuilderProvider.
 */

import { enableMapSet } from "immer";
import { temporal } from "zundo";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { createStore } from "zustand/vanilla";
import {
	getParentScreen,
	type PreviewScreen,
	screensEqual,
} from "@/lib/preview/engine/types";
import type {
	BlueprintForm,
	BlueprintModule,
	CaseType,
	ConnectConfig,
	ConnectType,
	PostSubmitDestination,
	Scaffold,
} from "@/lib/schemas/blueprint";
import { transformBareHashtags } from "../preview/engine/labelRefs";
import { rewriteHashtagRefs, rewriteXPathRefs } from "../preview/xpath/rewrite";
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
	type SelectedElement,
	STAGE_LABELS,
} from "./builder";
import { normalizeConnectConfig } from "./connectConfig";
import {
	assembleBlueprint,
	collectAllQuestionIds,
	decomposeBlueprint,
	decomposeForm,
	getEntityData,
	type NForm,
	type NModule,
	type NQuestion,
	removeQuestionDeep,
	resolveQuestionContext,
	resolveQuestionUuid,
} from "./normalizedState";
import { type QuestionPath, qpath, qpathId, qpathParent } from "./questionPath";

/* Enable Immer's Map/Set support for any Map/Set values that might appear
 * in blueprint data (future-proofing — current schema uses plain objects). */
enableMapSet();

// ── Cursor mode ──────────────────────────────────────────────────────

export type CursorMode = "pointer" | "edit";

// ── Navigation history ────────────────────────────────────────────────

/** Maximum navigation history entries before oldest are pruned. */
const MAX_NAV_HISTORY = 50;

/** Append a screen to navigation history, truncating forward entries and
 *  capping at MAX_NAV_HISTORY. Returns new entries array and cursor position. */
function appendNavEntry(
	entries: PreviewScreen[],
	cursor: number,
	screen: PreviewScreen,
): { entries: PreviewScreen[]; cursor: number } {
	const truncated = entries.slice(0, cursor + 1);
	truncated.push(screen);
	if (truncated.length > MAX_NAV_HISTORY) {
		return {
			entries: truncated.slice(truncated.length - MAX_NAV_HISTORY),
			cursor: MAX_NAV_HISTORY - 1,
		};
	}
	return { entries: truncated, cursor: cursor + 1 };
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

	// ── Selection ──
	selected: SelectedElement | undefined;

	// ── View context ──
	/** Current navigation screen within the builder preview. */
	screen: PreviewScreen;
	/** Current cursor mode (inspect/text/pointer). */
	cursorMode: CursorMode;
	/** Which [data-field-id] element currently has focus. NOT tracked by zundo
	 *  — transient interaction state that stays at its live value through undo/redo. */
	activeFieldId: string | undefined;

	// ── Navigation history ──
	/** Back/forward navigation stack. `screen` is always `navEntries[navCursor]`. */
	navEntries: PreviewScreen[];
	/** Current position in the navigation history stack. */
	navCursor: number;

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
	) => void;
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
			type?: "registration" | "followup" | "survey";
			close_case?: { question?: string; answer?: string } | null;
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

	// -- Selection actions --
	select: (el?: SelectedElement) => void;

	// -- View context actions --
	setCursorMode: (mode: CursorMode) => void;
	setActiveFieldId: (fieldId: string | undefined) => void;

	// -- Navigation actions --
	navPush: (screen: PreviewScreen) => void;
	navPushIfDifferent: (screen: PreviewScreen) => void;
	navBack: () => PreviewScreen | undefined;
	navUp: () => void;
	navigateToHome: () => void;
	navigateToModule: (moduleIndex: number) => void;
	navigateToForm: (
		moduleIndex: number,
		formIndex: number,
		caseId?: string,
	) => void;
	navigateToCaseList: (moduleIndex: number, formIndex: number) => void;
	navResetTo: (screen: PreviewScreen) => void;

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
	reset: () => void;
}

// ── Undo/redo partialized state ────────────────────────────────────────

/** The slice of state that zundo tracks for undo/redo. Includes entity data
 *  and navigation context. Transient interaction state (selected, cursorMode,
 *  activeFieldId) is excluded — those stay at their live values through undo. */
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
	| "screen"
	| "navEntries"
	| "navCursor"
>;

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
						selected: undefined,
						screen: { type: "home" } as PreviewScreen,
						cursorMode: "edit" as CursorMode,
						activeFieldId: undefined,
						navEntries: [{ type: "home" }] as PreviewScreen[],
						navCursor: 0,

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

						// ── Blueprint mutation actions ──────────────────────────

						updateQuestion(mIdx, fIdx, path, updates) {
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;
								const uuid = resolveQuestionUuid(
									draft.questions,
									draft.questionOrder,
									formId,
									path,
								);
								if (!uuid) return;
								const q = draft.questions[uuid];
								if (!q) return;
								for (const [key, value] of Object.entries(updates)) {
									if (value === undefined) continue;
									if (value === null) {
										delete (q as Record<string, unknown>)[key];
									} else {
										(q as Record<string, unknown>)[key] = value;
									}
								}
							});
						},

						addQuestion(mIdx, fIdx, question, opts?) {
							let uuid = "";
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;

								const newQ = newQuestionToEntity(question);
								uuid = newQ.uuid;

								/* Resolve the parent ordering array */
								let parentId: string;
								if (opts?.parentPath) {
									const parentUuid = resolveQuestionUuid(
										draft.questions,
										draft.questionOrder,
										formId,
										opts.parentPath,
									);
									if (!parentUuid) return;
									parentId = parentUuid;
								} else {
									parentId = formId;
								}

								/* Ensure ordering array exists for this parent */
								if (!draft.questionOrder[parentId]) {
									draft.questionOrder[parentId] = [];
								}
								const siblings = draft.questionOrder[parentId];

								/* Add the question entity */
								draft.questions[newQ.uuid] = newQ;
								/* Initialize children ordering for groups/repeats */
								if (question.type === "group" || question.type === "repeat") {
									draft.questionOrder[newQ.uuid] = [];
									/* Add child questions if provided */
									if (question.children) {
										addChildQuestions(
											draft.questions,
											draft.questionOrder,
											newQ.uuid,
											question.children,
										);
									}
								}

								/* Insert into the ordering array */
								if (opts?.atIndex !== undefined) {
									siblings.splice(opts.atIndex, 0, newQ.uuid);
								} else {
									const afterId = opts?.afterPath
										? qpathId(opts.afterPath)
										: undefined;
									const beforeId = opts?.beforePath
										? qpathId(opts.beforePath)
										: undefined;
									insertIntoOrder(
										siblings,
										draft.questions,
										newQ.uuid,
										afterId,
										beforeId,
									);
								}
							});
							return uuid;
						},

						removeQuestion(mIdx, fIdx, path) {
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;
								const ctx = resolveQuestionContext(
									draft.questions,
									draft.questionOrder,
									formId,
									path,
								);
								if (!ctx) return;

								/* Remove from parent's ordering */
								const siblings = draft.questionOrder[ctx.parentId];
								if (siblings) {
									const idx = siblings.indexOf(ctx.uuid);
									if (idx !== -1) siblings.splice(idx, 1);
								}

								/* Check if this question is referenced by close_case */
								const form = draft.forms[formId];
								const bareId = qpathId(path);
								if (form?.closeCase?.question === bareId) {
									form.closeCase = undefined;
								}

								/* Remove entity and all descendants */
								removeQuestionDeep(
									draft.questions,
									draft.questionOrder,
									ctx.uuid,
								);
							});
						},

						moveQuestion(mIdx, fIdx, path, opts) {
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;

								/* No-op if moving relative to itself */
								if (opts.afterPath === path || opts.beforePath === path) return;

								const ctx = resolveQuestionContext(
									draft.questions,
									draft.questionOrder,
									formId,
									path,
								);
								if (!ctx) return;

								const isCrossLevel = "targetParentPath" in opts;

								/* Prevent circular nesting */
								if (isCrossLevel && opts.targetParentPath !== undefined) {
									const targetUuid = resolveQuestionUuid(
										draft.questions,
										draft.questionOrder,
										formId,
										opts.targetParentPath,
									);
									if (
										targetUuid === ctx.uuid ||
										(targetUuid !== undefined &&
											isDescendant(draft.questionOrder, ctx.uuid, targetUuid))
									)
										return;
								}

								/* Remove from current position */
								const srcSiblings = draft.questionOrder[ctx.parentId];
								if (srcSiblings) {
									const idx = srcSiblings.indexOf(ctx.uuid);
									if (idx !== -1) srcSiblings.splice(idx, 1);
								}

								/* Determine target parent */
								let targetParentId: string;
								if (isCrossLevel) {
									if (opts.targetParentPath) {
										const tpUuid = resolveQuestionUuid(
											draft.questions,
											draft.questionOrder,
											formId,
											opts.targetParentPath,
										);
										if (!tpUuid) return;
										targetParentId = tpUuid;
									} else {
										targetParentId = formId;
									}
								} else {
									targetParentId = ctx.parentId;
								}

								if (!draft.questionOrder[targetParentId]) {
									draft.questionOrder[targetParentId] = [];
								}
								const targetSiblings = draft.questionOrder[targetParentId];

								const afterId = opts.afterPath
									? qpathId(opts.afterPath)
									: undefined;
								const beforeId = opts.beforePath
									? qpathId(opts.beforePath)
									: undefined;
								insertIntoOrder(
									targetSiblings,
									draft.questions,
									ctx.uuid,
									afterId,
									beforeId,
								);
							});
						},

						duplicateQuestion(mIdx, fIdx, path) {
							let result = {
								newPath: "" as QuestionPath,
								newUuid: "",
							};
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;
								const ctx = resolveQuestionContext(
									draft.questions,
									draft.questionOrder,
									formId,
									path,
								);
								if (!ctx) return;

								const allIds = collectAllQuestionIds(
									draft.questions,
									draft.questionOrder,
									formId,
								);
								const origId = draft.questions[ctx.uuid].id;

								/* Generate unique ID */
								let newId = `${origId}_copy`;
								if (allIds.has(newId)) {
									let counter = 2;
									while (allIds.has(`${origId}_${counter}`)) counter++;
									newId = `${origId}_${counter}`;
								}

								/* Deep clone the question and all descendants */
								const cloneResult = deepCloneQuestion(
									draft.questions,
									draft.questionOrder,
									ctx.uuid,
								);

								/* Set new ID and clear case mapping on the root clone */
								cloneResult.rootEntity.id = newId;
								delete cloneResult.rootEntity.case_property_on;

								/* Merge cloned entities into the store */
								for (const [uuid, q] of Object.entries(cloneResult.questions)) {
									draft.questions[uuid] = q;
								}
								for (const [pid, childIds] of Object.entries(
									cloneResult.questionOrder,
								)) {
									draft.questionOrder[pid] = childIds;
								}

								/* Insert after the original */
								const siblings = draft.questionOrder[ctx.parentId];
								const origIdx = siblings.indexOf(ctx.uuid);
								if (origIdx !== -1) {
									siblings.splice(origIdx + 1, 0, cloneResult.rootEntity.uuid);
								} else {
									siblings.push(cloneResult.rootEntity.uuid);
								}

								result = {
									newPath: qpath(newId, qpathParent(path)),
									newUuid: cloneResult.rootEntity.uuid,
								};
							});
							return result;
						},

						renameQuestion(mIdx, fIdx, path, newId) {
							let result: QuestionRenameResult = {
								newPath: "" as QuestionPath,
								xpathFieldsRewritten: 0,
							};
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;
								const uuid = resolveQuestionUuid(
									draft.questions,
									draft.questionOrder,
									formId,
									path,
								);
								if (!uuid) return;

								const oldId = draft.questions[uuid].id;
								const oldXPathPath = path as string;
								draft.questions[uuid].id = newId;

								/* Rewrite XPath references in all questions in this form */
								let xpathFieldsRewritten = 0;
								const allFormQuestionIds = getAllQuestionUuids(
									draft.questionOrder,
									formId,
								);
								for (const qUuid of allFormQuestionIds) {
									const q = draft.questions[qUuid];
									if (!q) continue;
									xpathFieldsRewritten += rewriteXPathInQuestion(
										q,
										oldXPathPath,
										newId,
									);
								}

								/* Update close_case reference */
								const form = draft.forms[formId];
								if (form?.closeCase?.question === oldId) {
									form.closeCase.question = newId;
								}

								result = {
									newPath: qpath(newId, qpathParent(path)),
									xpathFieldsRewritten,
								};
							});
							return result;
						},

						updateModule(mIdx, updates) {
							set((draft) => {
								const moduleId = draft.moduleOrder[mIdx];
								if (!moduleId) return;
								const mod = draft.modules[moduleId];
								if (!mod) return;

								if (updates.name !== undefined) mod.name = updates.name;
								if (updates.case_list_columns !== undefined) {
									mod.caseListColumns = updates.case_list_columns;
								}
								if (updates.case_detail_columns !== undefined) {
									mod.caseDetailColumns =
										updates.case_detail_columns === null
											? undefined
											: updates.case_detail_columns;
								}
							});
						},

						updateForm(mIdx, fIdx, updates) {
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;
								const form = draft.forms[formId];
								if (!form) return;

								if (updates.name !== undefined) form.name = updates.name;
								if (updates.type !== undefined) form.type = updates.type;
								if (updates.close_case !== undefined) {
									form.closeCase =
										updates.close_case === null
											? undefined
											: updates.close_case;
								}
								if (updates.connect !== undefined) {
									if (updates.connect === null) {
										form.connect = undefined;
									} else {
										const normalized = normalizeConnectConfig(updates.connect);
										form.connect = normalized ?? undefined;
									}
								}
								if (updates.post_submit !== undefined) {
									form.postSubmit =
										updates.post_submit === null ||
										updates.post_submit === "default"
											? undefined
											: updates.post_submit;
								}
							});
						},

						replaceForm(mIdx, fIdx, form) {
							set((draft) => {
								const formId = resolveFormId(draft, mIdx, fIdx);
								if (!formId) return;

								/* Decompose the incoming BlueprintForm into entities */
								const decomposed = decomposeForm(form, formId);

								/* Replace form entity */
								draft.forms[formId] = decomposed.nForm;

								/* Remove old questions for this form */
								const oldChildIds = draft.questionOrder[formId];
								if (oldChildIds) {
									for (const uuid of [...oldChildIds]) {
										removeQuestionDeep(
											draft.questions,
											draft.questionOrder,
											uuid,
										);
									}
								}

								/* Merge new questions */
								for (const [uuid, q] of Object.entries(decomposed.questions)) {
									draft.questions[uuid] = q;
								}
								for (const [pid, childIds] of Object.entries(
									decomposed.questionOrder,
								)) {
									draft.questionOrder[pid] = childIds;
								}
							});
						},

						addForm(mIdx, form) {
							set((draft) => {
								const moduleId = draft.moduleOrder[mIdx];
								if (!moduleId) return;

								const formId = crypto.randomUUID();
								const decomposed = decomposeForm(form, formId);

								draft.forms[formId] = decomposed.nForm;
								if (!draft.formOrder[moduleId]) {
									draft.formOrder[moduleId] = [];
								}
								draft.formOrder[moduleId].push(formId);

								for (const [uuid, q] of Object.entries(decomposed.questions)) {
									draft.questions[uuid] = q;
								}
								for (const [pid, childIds] of Object.entries(
									decomposed.questionOrder,
								)) {
									draft.questionOrder[pid] = childIds;
								}
							});
						},

						removeForm(mIdx, fIdx) {
							set((draft) => {
								const moduleId = draft.moduleOrder[mIdx];
								if (!moduleId) return;
								const formIds = draft.formOrder[moduleId];
								if (!formIds || fIdx < 0 || fIdx >= formIds.length) return;

								const formId = formIds[fIdx];

								/* Remove all questions */
								const childIds = draft.questionOrder[formId];
								if (childIds) {
									for (const uuid of [...childIds]) {
										removeQuestionDeep(
											draft.questions,
											draft.questionOrder,
											uuid,
										);
									}
									delete draft.questionOrder[formId];
								}

								/* Remove form entity and ordering */
								delete draft.forms[formId];
								formIds.splice(fIdx, 1);
							});
						},

						addModule(module) {
							set((draft) => {
								const moduleId = crypto.randomUUID();

								draft.modules[moduleId] = {
									uuid: moduleId,
									name: module.name,
									caseType: module.case_type ?? undefined,
									caseListOnly: module.case_list_only ?? undefined,
									purpose: undefined,
									caseListColumns: module.case_list_columns ?? undefined,
									caseDetailColumns: module.case_detail_columns ?? undefined,
								};
								draft.moduleOrder.push(moduleId);
								draft.formOrder[moduleId] = [];

								/* Decompose forms */
								for (const form of module.forms) {
									const formId = crypto.randomUUID();
									const decomposed = decomposeForm(form, formId);

									draft.forms[formId] = decomposed.nForm;
									draft.formOrder[moduleId].push(formId);

									for (const [uuid, q] of Object.entries(
										decomposed.questions,
									)) {
										draft.questions[uuid] = q;
									}
									for (const [pid, childIds] of Object.entries(
										decomposed.questionOrder,
									)) {
										draft.questionOrder[pid] = childIds;
									}
								}
							});
						},

						removeModule(mIdx) {
							set((draft) => {
								const moduleId = draft.moduleOrder[mIdx];
								if (!moduleId) return;

								/* Remove all forms and their questions */
								const formIds = draft.formOrder[moduleId] ?? [];
								for (const formId of formIds) {
									const childIds = draft.questionOrder[formId];
									if (childIds) {
										for (const uuid of [...childIds]) {
											removeQuestionDeep(
												draft.questions,
												draft.questionOrder,
												uuid,
											);
										}
										delete draft.questionOrder[formId];
									}
									delete draft.forms[formId];
								}

								delete draft.formOrder[moduleId];
								delete draft.modules[moduleId];
								draft.moduleOrder.splice(mIdx, 1);
							});
						},

						updateApp(updates) {
							set((draft) => {
								if (updates.app_name !== undefined) {
									draft.appName = updates.app_name;
								}
								if (updates.connect_type !== undefined) {
									draft.connectType =
										(updates.connect_type as ConnectType) || undefined;
								}
							});
						},

						renameCaseProperty(caseType, oldName, newName) {
							let result: RenameResult = {
								formsChanged: [],
								columnsChanged: [],
							};
							set((draft) => {
								const formsChanged: string[] = [];
								const columnsChanged: string[] = [];

								for (let mIdx = 0; mIdx < draft.moduleOrder.length; mIdx++) {
									const moduleId = draft.moduleOrder[mIdx];
									const mod = draft.modules[moduleId];
									if (mod.caseType !== caseType) continue;

									/* Rename in columns */
									for (const columns of [
										mod.caseListColumns,
										mod.caseDetailColumns,
									]) {
										if (!columns) continue;
										for (const col of columns) {
											if (col.field === oldName) {
												col.field = newName;
												if (!columnsChanged.includes(`m${mIdx}`))
													columnsChanged.push(`m${mIdx}`);
											}
										}
									}

									/* Rename in questions */
									const formIds = draft.formOrder[moduleId] ?? [];
									for (let fIdx = 0; fIdx < formIds.length; fIdx++) {
										const formId = formIds[fIdx];
										const allUuids = getAllQuestionUuids(
											draft.questionOrder,
											formId,
										);
										let formChanged = false;
										for (const qUuid of allUuids) {
											const q = draft.questions[qUuid];
											if (!q) continue;
											if (q.id === oldName && q.case_property_on) {
												q.id = newName;
												formChanged = true;
											}
											formChanged =
												rewriteCasePropertyInQuestion(q, oldName, newName) ||
												formChanged;
										}
										if (formChanged) {
											formsChanged.push(`m${mIdx}-f${fIdx}`);
										}
									}
								}

								result = { formsChanged, columnsChanged };
							});
							return result;
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

						// ── Selection actions ──────────────────────────────────

						select(el?) {
							set((draft) => {
								draft.selected = el;
								if (!el || el.type !== "question") {
									draft.activeFieldId = undefined;
								}
							});
						},

						// ── View context actions ──────────────────────────────

						setCursorMode(mode) {
							set({ cursorMode: mode });
						},

						setActiveFieldId(fieldId) {
							if (fieldId === get().activeFieldId) return;
							set({ activeFieldId: fieldId });
						},

						// ── Navigation actions ────────────────────────────────

						navPush(screen) {
							set((draft) => {
								const result = appendNavEntry(
									draft.navEntries,
									draft.navCursor,
									screen,
								);
								draft.navEntries = result.entries;
								draft.navCursor = result.cursor;
								draft.screen = screen;
							});
						},

						navPushIfDifferent(screen) {
							const s = get();
							if (screensEqual(s.screen, screen)) return;
							set((draft) => {
								const result = appendNavEntry(
									draft.navEntries,
									draft.navCursor,
									screen,
								);
								draft.navEntries = result.entries;
								draft.navCursor = result.cursor;
								draft.screen = screen;
							});
						},

						navBack() {
							const s = get();
							if (s.navCursor <= 0) return undefined;
							const newScreen = s.navEntries[s.navCursor - 1];
							set((draft) => {
								draft.navCursor--;
								draft.screen = newScreen;
							});
							return newScreen;
						},

						navUp() {
							const parent = getParentScreen(get().screen);
							if (!parent) return;
							get().navPush(parent);
						},

						navigateToHome() {
							get().navPushIfDifferent({ type: "home" });
						},

						navigateToModule(moduleIndex) {
							get().navPushIfDifferent({ type: "module", moduleIndex });
						},

						navigateToForm(moduleIndex, formIndex, caseId?) {
							get().navPushIfDifferent({
								type: "form",
								moduleIndex,
								formIndex,
								caseId,
							});
						},

						navigateToCaseList(moduleIndex, formIndex) {
							get().navPushIfDifferent({
								type: "caseList",
								moduleIndex,
								formIndex,
							});
						},

						navResetTo(screen) {
							set((draft) => {
								draft.navEntries = [screen];
								draft.navCursor = 0;
								draft.screen = screen;
							});
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
							set({ caseTypes });
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
							set((draft) => {
								if (!draft.generationData)
									draft.generationData = {
										partialModules: {},
									};
								draft.generationData.scaffold = scaffold;
								draft.generationData.partialScaffold = undefined;

								/* Create module and form entities from the scaffold
								 * so setModuleContent/setFormContent can address them by index. */
								draft.appName = scaffold.app_name;
								if (
									scaffold.connect_type === "learn" ||
									scaffold.connect_type === "deliver"
								) {
									draft.connectType = scaffold.connect_type;
								}

								draft.modules = {};
								draft.forms = {};
								draft.moduleOrder = [];
								draft.formOrder = {};

								for (const sm of scaffold.modules) {
									const moduleId = crypto.randomUUID();
									draft.moduleOrder.push(moduleId);

									draft.modules[moduleId] = {
										uuid: moduleId,
										name: sm.name,
										caseType: sm.case_type != null ? sm.case_type : undefined,
										caseListOnly: sm.case_list_only ?? undefined,
										purpose: sm.purpose ?? undefined,
										caseListColumns: undefined,
										caseDetailColumns: undefined,
									};

									const formIds: string[] = [];
									draft.formOrder[moduleId] = formIds;

									for (const sf of sm.forms) {
										const formId = crypto.randomUUID();
										formIds.push(formId);

										draft.forms[formId] = {
											uuid: formId,
											name: sf.name,
											type: sf.type as "registration" | "followup" | "survey",
											purpose: sf.purpose ?? undefined,
											closeCase: undefined,
											connect: undefined,
											postSubmit: (sf as Record<string, unknown>).post_submit as
												| PostSubmitDestination
												| undefined,
											formLinks: undefined,
										};

										/* Initialize empty question ordering */
										draft.questionOrder[formId] = [];
									}
								}
							});
						},

						setModuleContent(moduleIndex, caseListColumns) {
							set((draft) => {
								const moduleId = draft.moduleOrder[moduleIndex];
								if (!moduleId) return;
								const mod = draft.modules[moduleId];
								if (!mod) return;

								mod.caseListColumns = caseListColumns ?? undefined;

								/* Also track in generationData for progress */
								if (!draft.generationData)
									draft.generationData = {
										partialModules: {},
									};
								const partial = draft.generationData.partialModules[
									moduleIndex
								] ?? { forms: {} };
								partial.caseListColumns = caseListColumns;
								draft.generationData.partialModules[moduleIndex] = partial;

								const progress = computeProgress(draft.generationData);
								draft.progressCompleted = progress.completed;
								draft.progressTotal = progress.total;
							});
						},

						setFormContent(moduleIndex, formIndex, form) {
							set((draft) => {
								const moduleId = draft.moduleOrder[moduleIndex];
								if (!moduleId) return;
								const formIds = draft.formOrder[moduleId] ?? [];
								const formId = formIds[formIndex];

								if (formId) {
									/* Form entity exists (scaffold created it or it's an edit).
									 * Decompose the incoming form and replace questions. */
									const decomposed = decomposeForm(form, formId);

									/* Update form entity fields */
									draft.forms[formId] = decomposed.nForm;
									/* Preserve purpose from scaffold */
									const existingPurpose = draft.forms[formId]?.purpose;
									if (existingPurpose) {
										draft.forms[formId].purpose = existingPurpose;
									}

									/* Remove old questions */
									const oldChildIds = draft.questionOrder[formId];
									if (oldChildIds) {
										for (const uuid of [...oldChildIds]) {
											removeQuestionDeep(
												draft.questions,
												draft.questionOrder,
												uuid,
											);
										}
									}

									/* Merge new questions */
									for (const [uuid, q] of Object.entries(
										decomposed.questions,
									)) {
										draft.questions[uuid] = q;
									}
									for (const [pid, childIds] of Object.entries(
										decomposed.questionOrder,
									)) {
										draft.questionOrder[pid] = childIds;
									}
								}

								/* Track in generationData for progress */
								if (!draft.generationData)
									draft.generationData = {
										partialModules: {},
									};
								const partial = draft.generationData.partialModules[
									moduleIndex
								] ?? { forms: {} };
								partial.forms[formIndex] = form;
								draft.generationData.partialModules[moduleIndex] = partial;

								const progress = computeProgress(draft.generationData);
								draft.progressCompleted = progress.completed;
								draft.progressTotal = progress.total;
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

						reset() {
							set((draft) => {
								draft.phase = BuilderPhase.Idle;
								draft.selected = undefined;
								draft.screen = { type: "home" };
								draft.cursorMode = "edit";
								draft.activeFieldId = undefined;
								draft.navEntries = [{ type: "home" }];
								draft.navCursor = 0;

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
							});
						},
					})),
				),
				{
					/* zundo config: undo/redo tracks entity data + navigation context.
					 * Transient interaction state (selected, cursorMode, activeFieldId)
					 * is excluded — those stay at their live values through undo/redo. */
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
						screen: s.screen,
						navEntries: s.navEntries,
						navCursor: s.navCursor,
					}),
					/* Only create undo entries when entity data actually changes.
					 * Navigation-only, selection, or cursor changes don't create
					 * undo entries but navigation IS captured in the snapshot when
					 * an entity change happens — so undo restores where the user
					 * was when they made the edit. */
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

/** Resolve a form UUID from module and form indices. */
function resolveFormId(
	state: { moduleOrder: string[]; formOrder: Record<string, string[]> },
	mIdx: number,
	fIdx: number,
): string | undefined {
	const moduleId = state.moduleOrder[mIdx];
	if (!moduleId) return undefined;
	return state.formOrder[moduleId]?.[fIdx];
}

/** Convert a NewQuestion to an NQuestion entity with UUID. */
function newQuestionToEntity(nq: NewQuestion): NQuestion {
	return {
		uuid: crypto.randomUUID(),
		id: nq.id,
		type: nq.type,
		...(nq.label != null && { label: nq.label }),
		...(nq.hint != null && { hint: nq.hint }),
		...(nq.required != null && { required: nq.required }),
		...(nq.validation != null && { validation: nq.validation }),
		...(nq.validation_msg != null && { validation_msg: nq.validation_msg }),
		...(nq.relevant != null && { relevant: nq.relevant }),
		...(nq.calculate != null && { calculate: nq.calculate }),
		...(nq.default_value != null && { default_value: nq.default_value }),
		...(nq.options != null && { options: nq.options }),
		...(nq.case_property_on != null && {
			case_property_on: nq.case_property_on,
		}),
	};
}

/** Recursively add child questions (for group/repeat NewQuestion). */
function addChildQuestions(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentUuid: string,
	children: NewQuestion[],
): void {
	const childIds: string[] = [];
	questionOrder[parentUuid] = childIds;

	for (const child of children) {
		const entity = newQuestionToEntity(child);
		questions[entity.uuid] = entity;
		childIds.push(entity.uuid);

		if ((child.type === "group" || child.type === "repeat") && child.children) {
			addChildQuestions(questions, questionOrder, entity.uuid, child.children);
		} else if (child.type === "group" || child.type === "repeat") {
			questionOrder[entity.uuid] = [];
		}
	}
}

/** Insert a UUID into an ordering array after/before a given question id. */
function insertIntoOrder(
	siblings: string[],
	questions: Record<string, NQuestion>,
	uuid: string,
	afterId?: string,
	beforeId?: string,
): void {
	if (beforeId) {
		const idx = siblings.findIndex((u) => questions[u]?.id === beforeId);
		if (idx === -1) {
			siblings.push(uuid);
		} else {
			siblings.splice(idx, 0, uuid);
		}
		return;
	}
	if (!afterId) {
		siblings.push(uuid);
		return;
	}
	const idx = siblings.findIndex((u) => questions[u]?.id === afterId);
	if (idx === -1) {
		siblings.push(uuid);
	} else {
		siblings.splice(idx + 1, 0, uuid);
	}
}

/** Check if `descendantUuid` is a descendant of `ancestorUuid` in the question tree. */
function isDescendant(
	questionOrder: Record<string, string[]>,
	ancestorUuid: string,
	descendantUuid: string,
): boolean {
	const children = questionOrder[ancestorUuid];
	if (!children) return false;
	for (const child of children) {
		if (child === descendantUuid) return true;
		if (isDescendant(questionOrder, child, descendantUuid)) return true;
	}
	return false;
}

/** Get all question UUIDs reachable from a parent (depth-first). */
function getAllQuestionUuids(
	questionOrder: Record<string, string[]>,
	parentId: string,
): string[] {
	const result: string[] = [];
	function walk(pid: string) {
		const childIds = questionOrder[pid];
		if (!childIds) return;
		for (const uuid of childIds) {
			result.push(uuid);
			walk(uuid);
		}
	}
	walk(parentId);
	return result;
}

/** Deep clone a question and all its descendants, assigning fresh UUIDs. */
function deepCloneQuestion(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	uuid: string,
): {
	rootEntity: NQuestion;
	questions: Record<string, NQuestion>;
	questionOrder: Record<string, string[]>;
} {
	const clonedQuestions: Record<string, NQuestion> = {};
	const clonedOrder: Record<string, string[]> = {};

	function cloneRecursive(origUuid: string): string {
		const orig = questions[origUuid];
		const newUuid = crypto.randomUUID();
		clonedQuestions[newUuid] = { ...orig, uuid: newUuid };

		const children = questionOrder[origUuid];
		if (children && children.length > 0) {
			clonedOrder[newUuid] = children.map((childUuid) =>
				cloneRecursive(childUuid),
			);
		}

		return newUuid;
	}

	const rootUuid = cloneRecursive(uuid);
	return {
		rootEntity: clonedQuestions[rootUuid],
		questions: clonedQuestions,
		questionOrder: clonedOrder,
	};
}

/** Rewrite XPath references in a single question's fields. Returns count of fields changed. */
function rewriteXPathInQuestion(
	q: NQuestion,
	oldPath: string,
	newId: string,
): number {
	const xpathFields = [
		"relevant",
		"calculate",
		"default_value",
		"validation",
	] as const;
	const displayFields = ["label", "hint"] as const;
	const rewriter = (expr: string) => rewriteXPathRefs(expr, oldPath, newId);
	let count = 0;

	for (const field of xpathFields) {
		const val = q[field];
		if (!val) continue;
		const rewritten = rewriter(val);
		if (rewritten !== val) {
			(q as Record<string, unknown>)[field] = rewritten;
			count++;
		}
	}

	for (const field of displayFields) {
		const text = q[field];
		if (!text) continue;
		const rewritten = transformBareHashtags(text, rewriter);
		if (rewritten !== text) {
			(q as Record<string, unknown>)[field] = rewritten;
			count++;
		}
	}

	return count;
}

/** Rewrite case property references in a single question's XPath and display fields. */
function rewriteCasePropertyInQuestion(
	q: NQuestion,
	oldName: string,
	newName: string,
): boolean {
	const xpathFields = [
		"relevant",
		"calculate",
		"default_value",
		"validation",
	] as const;
	const displayFields = ["label", "hint"] as const;
	const hashtagRewriter = (expr: string) =>
		rewriteHashtagRefs(expr, "#case/", oldName, newName);
	const pathRewriter = (expr: string) =>
		rewriteXPathRefs(expr, oldName, newName);
	let changed = false;

	for (const field of xpathFields) {
		const val = q[field];
		if (!val) continue;
		let rewritten = hashtagRewriter(val);
		rewritten = pathRewriter(rewritten);
		if (rewritten !== val) {
			(q as Record<string, unknown>)[field] = rewritten;
			changed = true;
		}
	}

	for (const field of displayFields) {
		const text = q[field];
		if (!text) continue;
		const rewritten = transformBareHashtags(text, (hashtag) =>
			pathRewriter(hashtagRewriter(hashtag)),
		);
		if (rewritten !== text) {
			(q as Record<string, unknown>)[field] = rewritten;
			changed = true;
		}
	}

	return changed;
}

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
