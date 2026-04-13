/**
 * User-facing mutation API for the BlueprintDoc store.
 *
 * Every consumer that edits a module, form, or question calls this hook
 * and dispatches via the returned action object. Function signatures
 * intentionally mirror the legacy `builderStore` action shapes so Phase
 * 1b call-site migration is a drop-in rename — the only thing a caller
 * needs to change is the import path and the hook name.
 *
 * Internally, each method:
 *   1. Reads the CURRENT doc snapshot via `store.getState()` (not the
 *      snapshot at hook construction) so uuid resolution always targets
 *      the freshest state, even after intervening mutations.
 *   2. Resolves the legacy (mIdx, fIdx, path) coordinates through the
 *      Task 2 adapters in `pathToUuid.ts`.
 *   3. Dispatches a `Mutation` through `store.getState().apply(...)`,
 *      which the Phase 1a reducer in `lib/doc/mutations/index.ts`
 *      translates into draft edits on the Immer-backed store.
 *
 * Missing references (unknown module, form, or path) are silently
 * swallowed — resolve-returns-undefined short-circuits the dispatch. The
 * legacy engine behaved the same way: no-op rather than throw, so the UI
 * never crashes on a stale selection held over a reload or undo.
 *
 * Phase 2 will add uuid-first overloads and Phase 3 will delete the
 * legacy (mIdx, fIdx, path) argument shape entirely as callers move to
 * URL-derived uuids.
 */

import { useContext, useMemo } from "react";
import {
	resolveFormUuid,
	resolveModuleUuid,
	resolveQuestionUuid,
} from "@/lib/doc/adapters/pathToUuid";
import { toDoc } from "@/lib/doc/converter";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type {
	FormEntity,
	ModuleEntity,
	Mutation,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	CaseType,
	ConnectType,
	Question,
} from "@/lib/schemas/blueprint";

/**
 * The full mutation surface returned by `useBlueprintMutations()`.
 *
 * Methods are grouped by entity (question / form / module / app-level)
 * and always accept legacy coordinates. Return type is `void` — dispatch
 * is fire-and-forget; read the new state via a subscription hook.
 */
export interface BlueprintMutations {
	// ── Question mutations ────────────────────────────────────────────────
	addQuestion: (
		mIdx: number,
		fIdx: number,
		question: Question,
		opts?: { parentPath?: string; index?: number },
	) => void;
	updateQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		patch: Partial<Omit<QuestionEntity, "uuid">>,
	) => void;
	removeQuestion: (mIdx: number, fIdx: number, path: string) => void;
	renameQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		newId: string,
	) => void;
	moveQuestion: (
		mIdx: number,
		fIdx: number,
		path: string,
		opts: {
			targetParentPath?: string;
			toIndex: number;
		},
	) => void;
	duplicateQuestion: (mIdx: number, fIdx: number, path: string) => void;

	// ── Form mutations ────────────────────────────────────────────────────
	addForm: (mIdx: number, form: BlueprintForm, index?: number) => void;
	updateForm: (
		mIdx: number,
		fIdx: number,
		patch: Partial<Omit<FormEntity, "uuid">>,
	) => void;
	removeForm: (mIdx: number, fIdx: number) => void;
	replaceForm: (mIdx: number, fIdx: number, form: BlueprintForm) => void;

	// ── Module mutations ──────────────────────────────────────────────────
	addModule: (module: BlueprintModule, index?: number) => void;
	updateModule: (
		mIdx: number,
		patch: Partial<Omit<ModuleEntity, "uuid">>,
	) => void;
	removeModule: (mIdx: number) => void;

	// ── App-level ─────────────────────────────────────────────────────────
	/**
	 * Combined app-level patch. Legacy `updateApp` accepted a partial
	 * object with two independent fields; we decompose it into individual
	 * `setAppName` / `setConnectType` mutations so undo history retains
	 * distinct entries per field.
	 */
	updateApp: (patch: {
		app_name?: string;
		connect_type?: ConnectType | null;
	}) => void;
	setCaseTypes: (caseTypes: CaseType[] | null) => void;

	// ── Batch ─────────────────────────────────────────────────────────────
	/**
	 * Dispatch multiple mutations in a single atomic undo snapshot. Used
	 * by compound edits (rename-case-property, switch-connect-mode, etc.)
	 * that need to coordinate several doc changes without fragmenting
	 * history.
	 */
	applyMany: (mutations: Mutation[]) => void;
}

export function useBlueprintMutations(): BlueprintMutations {
	const store = useContext(BlueprintDocContext);
	if (!store) {
		throw new Error(
			"useBlueprintMutations requires a <BlueprintDocProvider> ancestor",
		);
	}

	// Memoize against the store instance so the returned action object is
	// reference-stable across re-renders. A consumer storing this in a
	// useEffect dependency array sees it as unchanging for the lifetime of
	// the provider.
	return useMemo<BlueprintMutations>(() => {
		// Lazy snapshot accessor — resolves uuids at dispatch time, never at
		// hook construction. This is critical: without it, a mutation made
		// immediately after another would resolve against stale indices.
		const get = () => store.getState();
		const dispatch = (mut: Mutation) => store.getState().apply(mut);

		return {
			addQuestion(mIdx, fIdx, question, opts) {
				const doc = get();
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) return;
				// Default parent is the form root; an explicit `parentPath` lets
				// callers insert into a group/repeat. Unresolvable paths fall back
				// to the form root rather than no-op, matching legacy behavior.
				const parentUuid: Uuid = opts?.parentPath
					? (resolveQuestionUuid(doc, mIdx, fIdx, opts.parentPath) ?? formUuid)
					: formUuid;
				// The blueprint `Question` shape carries a nested `children` array
				// for group/repeat subtrees; the normalized doc expresses nesting
				// via `questionOrder`, so we strip `children` before dispatching
				// the insert. Callers inserting a whole subtree should use
				// `applyMany` with one `addQuestion` per descendant instead.
				const { children: _children, ...rest } = question as Question & {
					children?: Question[];
				};
				dispatch({
					kind: "addQuestion",
					parentUuid,
					question: rest as QuestionEntity,
					index: opts?.index,
				});
			},

			updateQuestion(mIdx, fIdx, path, patch) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "updateQuestion", uuid, patch });
			},

			removeQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "removeQuestion", uuid });
			},

			renameQuestion(mIdx, fIdx, path, newId) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "renameQuestion", uuid, newId });
			},

			moveQuestion(mIdx, fIdx, path, opts) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				const formUuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!formUuid) return;
				// Same fallback rule as `addQuestion`: unresolved target parent
				// paths degrade to the form root so a stale drop target can't
				// orphan the moved question.
				const toParentUuid: Uuid = opts.targetParentPath
					? (resolveQuestionUuid(doc, mIdx, fIdx, opts.targetParentPath) ??
						formUuid)
					: formUuid;
				dispatch({
					kind: "moveQuestion",
					uuid,
					toParentUuid,
					toIndex: opts.toIndex,
				});
			},

			duplicateQuestion(mIdx, fIdx, path) {
				const doc = get();
				const uuid = resolveQuestionUuid(doc, mIdx, fIdx, path);
				if (!uuid) return;
				dispatch({ kind: "duplicateQuestion", uuid });
			},

			addForm(mIdx, form, index) {
				const doc = get();
				const moduleUuid = resolveModuleUuid(doc, mIdx);
				if (!moduleUuid) return;
				// Strip nested `questions` — the entity map only carries form-level
				// scalars. Callers wanting to insert a form plus its questions in
				// one shot should dispatch an `applyMany` batch.
				const { questions: _qs, ...formRest } = form as BlueprintForm & {
					questions?: Question[];
				};
				const formUuid = crypto.randomUUID() as Uuid;
				dispatch({
					kind: "addForm",
					moduleUuid,
					form: { ...formRest, uuid: formUuid } as FormEntity,
					index,
				});
			},

			updateForm(mIdx, fIdx, patch) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;
				dispatch({ kind: "updateForm", uuid, patch });
			},

			removeForm(mIdx, fIdx) {
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;
				dispatch({ kind: "removeForm", uuid });
			},

			replaceForm(mIdx, fIdx, form) {
				// Wholesale form swap. The reducer's `replaceForm` variant
				// expects a form entity + pre-flattened question entities + a
				// `questionOrder` map for the replacement subtree. Rather than
				// reimplement the nested-to-flat walk here, we reuse `toDoc` on
				// a minimal scratch blueprint wrapping the incoming form — the
				// converter handles children, nested groups, and uuid minting
				// for modules/forms.
				//
				// Scratch builds a throwaway app with one module containing only
				// the replacement form, converts to doc shape, then re-keys the
				// top-level `questionOrder` slot from the scratch form's uuid to
				// the destination form's uuid (preserving the existing form uuid
				// so stable references in `formOrder` don't move).
				const doc = get();
				const uuid = resolveFormUuid(doc, mIdx, fIdx);
				if (!uuid) return;

				const bp: AppBlueprint = {
					app_name: "",
					connect_type: undefined,
					case_types: null,
					modules: [{ name: "__replace__", forms: [form] }],
				};
				const scratch = toDoc(bp, "");
				const scratchModuleUuid = scratch.moduleOrder[0];
				const scratchFormUuid = scratch.formOrder[scratchModuleUuid][0];
				const scratchForm = scratch.forms[scratchFormUuid];

				// Carry the scratch form's fields but stamp the destination uuid.
				const replacement: FormEntity = { ...scratchForm, uuid };
				const questions = Object.values(scratch.questions) as QuestionEntity[];

				// `questionOrder` is keyed by parent uuid. The scratch root slot
				// is keyed by `scratchFormUuid`; we remap that single key to the
				// destination `uuid`. Nested (group/repeat) slots are keyed by
				// question uuids, which are preserved verbatim from the input
				// form — no remap needed.
				const questionOrder: Record<Uuid, Uuid[]> = {};
				for (const [key, order] of Object.entries(scratch.questionOrder)) {
					questionOrder[(key === scratchFormUuid ? uuid : key) as Uuid] = order;
				}

				dispatch({
					kind: "replaceForm",
					uuid,
					form: replacement,
					questions,
					questionOrder,
				});
			},

			addModule(module, index) {
				// Same strip-children trick as `addForm`: the entity map carries
				// only module-level scalars; forms join via `addForm` batches.
				const { forms: _forms, ...moduleRest } = module as BlueprintModule & {
					forms?: BlueprintForm[];
				};
				const moduleUuid = crypto.randomUUID() as Uuid;
				dispatch({
					kind: "addModule",
					module: { ...moduleRest, uuid: moduleUuid } as ModuleEntity,
					index,
				});
			},

			updateModule(mIdx, patch) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) return;
				dispatch({ kind: "updateModule", uuid, patch });
			},

			removeModule(mIdx) {
				const doc = get();
				const uuid = resolveModuleUuid(doc, mIdx);
				if (!uuid) return;
				dispatch({ kind: "removeModule", uuid });
			},

			updateApp(patch) {
				// Decompose the combined patch into the store's granular
				// setters — each field has its own undo entry, matching the
				// reducer's per-mutation history design.
				if (patch.app_name !== undefined) {
					dispatch({ kind: "setAppName", name: patch.app_name });
				}
				if (patch.connect_type !== undefined) {
					dispatch({
						kind: "setConnectType",
						connectType: patch.connect_type,
					});
				}
			},

			setCaseTypes(caseTypes) {
				dispatch({ kind: "setCaseTypes", caseTypes });
			},

			applyMany(mutations) {
				// Batch dispatch — the store's `applyMany` wraps the whole set
				// in one `set()` call so zundo records exactly one undo entry.
				store.getState().applyMany(mutations);
			},
		};
	}, [store]);
}
