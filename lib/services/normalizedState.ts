/**
 * normalizedState — flat entity types, decompose/assemble functions.
 *
 * The builder store holds app data as flat maps keyed by UUID (modules, forms,
 * questions) with separate ordering arrays for tree structure. This file
 * provides the types for those entities and the two-way conversion between
 * the normalized store shape and the nested AppBlueprint wire format.
 *
 * `decomposeBlueprint` flattens the tree on ingest (load, generation complete).
 * `assembleBlueprint` reconstructs it on egress (save, export, chat body).
 *
 * Server-side code (SA agent, expander, validator) operates on AppBlueprint
 * directly via blueprintHelpers.ts — this file is client-only.
 */

import type {
	AppBlueprint,
	BlueprintForm,
	CaseType,
	ConnectConfig,
	ConnectType,
	FormLink,
	FormType,
	PostSubmitDestination,
	Question,
} from "@/lib/schemas/blueprint";
import type { QuestionPath } from "./questionPath";

// ── Column types (reused from AppBlueprint) ──────────────────────────

export interface CaseColumn {
	field: string;
	header: string;
}

// ── Normalized entity types ──────────────────────────────────────────

/** Flat module entity — no nested forms. Tree structure is in formOrder. */
export interface NModule {
	uuid: string;
	name: string;
	caseType: string | undefined;
	caseListOnly: boolean | undefined;
	purpose: string | undefined;
	caseListColumns: CaseColumn[] | undefined;
	caseDetailColumns: CaseColumn[] | null | undefined;
}

/** Flat form entity — no nested questions. Tree structure is in questionOrder. */
export interface NForm {
	uuid: string;
	name: string;
	type: FormType;
	purpose: string | undefined;
	closeCondition:
		| { question: string; answer: string; operator?: "=" | "selected" }
		| undefined;
	connect: ConnectConfig | null | undefined;
	postSubmit: PostSubmitDestination | undefined;
	formLinks: FormLink[] | undefined;
}

/**
 * Flat question entity — no children array. Tree structure is in questionOrder.
 * Field names match the wire format (snake_case) to minimize mapping — the
 * Question type is shared with the server and all mutation helpers.
 */
export type NQuestion = Omit<Question, "children">;

// ── Normalized data slice ────────────────────────────────────────────

/** The normalized subset of store state that represents app data.
 *  Passed to assembleBlueprint for serialization. */
export interface NormalizedData {
	appName: string;
	connectType: ConnectType | undefined;
	caseTypes: CaseType[];
	modules: Record<string, NModule>;
	forms: Record<string, NForm>;
	questions: Record<string, NQuestion>;
	moduleOrder: string[];
	formOrder: Record<string, string[]>;
	questionOrder: Record<string, string[]>;
}

// ── Decompose (tree → flat maps) ─────────────────────────────────────

/**
 * Flatten an AppBlueprint into normalized entity maps + ordering arrays.
 * Generates UUIDs for modules and forms (questions already have UUIDs).
 * Called by `loadApp` and `completeGeneration`.
 */
export function decomposeBlueprint(bp: AppBlueprint): NormalizedData {
	const modules: Record<string, NModule> = {};
	const forms: Record<string, NForm> = {};
	const questions: Record<string, NQuestion> = {};
	const moduleOrder: string[] = [];
	const formOrder: Record<string, string[]> = {};
	const questionOrder: Record<string, string[]> = {};

	for (const mod of bp.modules) {
		const moduleId = crypto.randomUUID();
		moduleOrder.push(moduleId);

		modules[moduleId] = {
			uuid: moduleId,
			name: mod.name,
			caseType: mod.case_type ?? undefined,
			caseListOnly: mod.case_list_only ?? undefined,
			purpose: undefined,
			caseListColumns: mod.case_list_columns ?? undefined,
			caseDetailColumns: mod.case_detail_columns ?? undefined,
		};

		const formIds: string[] = [];
		formOrder[moduleId] = formIds;

		for (const form of mod.forms) {
			const formId = crypto.randomUUID();
			formIds.push(formId);

			forms[formId] = decomposeFormEntity(form, formId);
			decomposeQuestions(form.questions, formId, questions, questionOrder);
		}
	}

	return {
		appName: bp.app_name,
		connectType: bp.connect_type ?? undefined,
		caseTypes: bp.case_types ?? [],
		modules,
		forms,
		questions,
		moduleOrder,
		formOrder,
		questionOrder,
	};
}

/**
 * Decompose a single BlueprintForm into an NForm entity + its questions.
 * Used during generation when individual forms arrive via `setFormContent`.
 * Returns the form entity and question entities/ordering for merging into the store.
 */
export function decomposeForm(
	form: BlueprintForm,
	existingFormId: string,
): {
	nForm: NForm;
	questions: Record<string, NQuestion>;
	questionOrder: Record<string, string[]>;
} {
	const questions: Record<string, NQuestion> = {};
	const questionOrder: Record<string, string[]> = {};

	const nForm = decomposeFormEntity(form, existingFormId);
	decomposeQuestions(form.questions, existingFormId, questions, questionOrder);

	return { nForm, questions, questionOrder };
}

// ── Assemble (flat maps → tree) ──────────────────────────────────────

/**
 * Reconstruct a nested AppBlueprint from normalized entity maps.
 * Called at save/export time — not on every mutation.
 */
export function assembleBlueprint(data: NormalizedData): AppBlueprint {
	return {
		app_name: data.appName,
		...(data.connectType && { connect_type: data.connectType }),
		case_types: data.caseTypes.length > 0 ? data.caseTypes : null,
		modules: data.moduleOrder.map((moduleId) => {
			const mod = data.modules[moduleId];
			const fIds = data.formOrder[moduleId] ?? [];

			return {
				name: mod.name,
				...(mod.caseType != null && { case_type: mod.caseType }),
				...(mod.caseListOnly && { case_list_only: mod.caseListOnly }),
				forms: fIds.map((formId) => {
					const form = data.forms[formId];
					return assembleForm(form, formId, data.questions, data.questionOrder);
				}),
				...(mod.caseListColumns && {
					case_list_columns: mod.caseListColumns,
				}),
				...(mod.caseDetailColumns !== undefined &&
					mod.caseDetailColumns !== null && {
						case_detail_columns: mod.caseDetailColumns,
					}),
			};
		}),
	};
}

/** Reconstruct a single BlueprintForm from normalized entities.
 *  Used by useAssembledForm to provide forms to FormEngine. */
export function assembleForm(
	form: NForm,
	formId: string,
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
): BlueprintForm {
	return {
		name: form.name,
		type: form.type,
		...(form.closeCondition && { close_condition: form.closeCondition }),
		...(form.postSubmit && { post_submit: form.postSubmit }),
		...(form.formLinks && { form_links: form.formLinks }),
		...(form.connect && { connect: form.connect }),
		questions: assembleQuestions(questions, questionOrder, formId),
	};
}

// ── Query helpers ────────────────────────────────────────────────────

/**
 * Walk the questionOrder tree to find a question's UUID from its QuestionPath.
 * Each path segment is a question `id` — we find the UUID at each level by
 * scanning the children of the current parent for a matching id.
 */
export function resolveQuestionUuid(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentId: string,
	path: QuestionPath,
): string | undefined {
	const segments = (path as string).split("/");
	let currentParentId = parentId;

	for (const segment of segments) {
		const childIds = questionOrder[currentParentId];
		if (!childIds) return undefined;
		const found = childIds.find((uuid) => questions[uuid]?.id === segment);
		if (!found) return undefined;
		currentParentId = found;
	}

	return currentParentId;
}

/**
 * Find the parent ordering array and the question UUID for a given path.
 * Returns the parent's child UUID list and the target UUID, needed for
 * splice operations (remove, insert, move).
 */
export function resolveQuestionContext(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	formId: string,
	path: QuestionPath,
): { parentId: string; uuid: string } | undefined {
	const segments = (path as string).split("/");

	if (segments.length === 1) {
		/* Top-level question — parent is the form */
		const childIds = questionOrder[formId];
		if (!childIds) return undefined;
		const uuid = childIds.find((id) => questions[id]?.id === segments[0]);
		if (!uuid) return undefined;
		return { parentId: formId, uuid };
	}

	/* Walk to the parent, then find the target in its children */
	let currentParentId = formId;
	for (let i = 0; i < segments.length - 1; i++) {
		const childIds = questionOrder[currentParentId];
		if (!childIds) return undefined;
		const found = childIds.find((uuid) => questions[uuid]?.id === segments[i]);
		if (!found) return undefined;
		currentParentId = found;
	}

	const lastSegment = segments[segments.length - 1];
	const parentChildIds = questionOrder[currentParentId];
	if (!parentChildIds) return undefined;
	const uuid = parentChildIds.find((id) => questions[id]?.id === lastSegment);
	if (!uuid) return undefined;

	return { parentId: currentParentId, uuid };
}

/**
 * Extract the NormalizedData slice from a store state object.
 * Convenience for callers that have the full store state and need
 * to pass it to assembleBlueprint.
 */
export function getEntityData(s: NormalizedData): NormalizedData {
	return {
		appName: s.appName,
		connectType: s.connectType,
		caseTypes: s.caseTypes,
		modules: s.modules,
		forms: s.forms,
		questions: s.questions,
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
		questionOrder: s.questionOrder,
	};
}

/**
 * Collect all question IDs reachable from a parent in the questionOrder tree.
 * Used for duplicate-ID prevention when adding questions.
 */
export function collectAllQuestionIds(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentId: string,
): Set<string> {
	const ids = new Set<string>();

	function walk(pid: string) {
		const childIds = questionOrder[pid];
		if (!childIds) return;
		for (const uuid of childIds) {
			const q = questions[uuid];
			if (q) {
				ids.add(q.id);
				walk(uuid);
			}
		}
	}

	walk(parentId);
	return ids;
}

/**
 * Collect question IDs of direct children of a given parent (non-recursive).
 * Used for same-level ID deduplication during move and rename — CommCare
 * requires siblings to have unique IDs, but cousins in different groups may share.
 */
export function collectSiblingIds(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentId: string,
	excludeUuid?: string,
): Set<string> {
	const ids = new Set<string>();
	const childUuids = questionOrder[parentId];
	if (!childUuids) return ids;
	for (const uuid of childUuids) {
		if (uuid === excludeUuid) continue;
		const q = questions[uuid];
		if (q) ids.add(q.id);
	}
	return ids;
}

/**
 * Count all questions reachable from a parent in the questionOrder tree.
 * Used by computeEditFocus for signal grid zone calculation.
 */
export function countQuestionsDeep(
	questionOrder: Record<string, string[]>,
	parentId: string,
): number {
	const childIds = questionOrder[parentId];
	if (!childIds) return 0;
	let count = childIds.length;
	for (const uuid of childIds) {
		count += countQuestionsDeep(questionOrder, uuid);
	}
	return count;
}

/**
 * Remove a question and all its descendants from the entity maps and ordering.
 * Mutates the provided records in place (called inside Immer drafts).
 */
export function removeQuestionDeep(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	uuid: string,
): void {
	/* Recursively remove children first */
	const childIds = questionOrder[uuid];
	if (childIds) {
		for (const childUuid of [...childIds]) {
			removeQuestionDeep(questions, questionOrder, childUuid);
		}
		delete questionOrder[uuid];
	}
	delete questions[uuid];
}

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Convert a BlueprintForm to an NForm entity (no questions).
 *
 * Migration: old blueprints have `close_case` on followup forms. When present,
 * the form is promoted to type "close" and `close_case` is converted to
 * `closeCondition`. Unconditional close (empty close_case `{}`) maps to
 * closeCondition = undefined (the default for close forms).
 */
function decomposeFormEntity(form: BlueprintForm, formId: string): NForm {
	let type: FormType = form.type;
	let closeCondition:
		| { question: string; answer: string; operator?: "=" | "selected" }
		| undefined;

	if (form.close_condition) {
		/* New-format blueprint — use close_condition directly */
		closeCondition = form.close_condition;
	} else if (form.close_case) {
		/* Old-format migration: followup + close_case → close form */
		type = "close";
		if (form.close_case.question && form.close_case.answer) {
			closeCondition = {
				question: form.close_case.question,
				answer: form.close_case.answer,
			};
		}
		/* else unconditional: closeCondition stays undefined */
	}

	return {
		uuid: formId,
		name: form.name,
		type,
		purpose: undefined,
		closeCondition,
		connect: form.connect ?? undefined,
		postSubmit: form.post_submit ?? undefined,
		formLinks: form.form_links ?? undefined,
	};
}

/** Recursively flatten questions into the entity map and ordering arrays. */
function decomposeQuestions(
	questions: Question[],
	parentId: string,
	entities: Record<string, NQuestion>,
	ordering: Record<string, string[]>,
): void {
	const childIds: string[] = [];
	ordering[parentId] = childIds;

	for (const q of questions) {
		childIds.push(q.uuid);

		/* Strip children — tree structure is captured by ordering */
		const { children, ...flat } = q;
		entities[q.uuid] = flat;

		if (children && children.length > 0) {
			decomposeQuestions(children, q.uuid, entities, ordering);
		}
	}
}

/** Recursively reconstruct nested Question arrays from flat maps. */
export function assembleQuestions(
	questions: Record<string, NQuestion>,
	questionOrder: Record<string, string[]>,
	parentId: string,
): Question[] {
	const childIds = questionOrder[parentId];
	if (!childIds) return [];

	return childIds.map((uuid) => {
		const q = questions[uuid];
		const childUuids = questionOrder[uuid];
		const assembled: Question = { ...q };
		if (childUuids && childUuids.length > 0) {
			assembled.children = assembleQuestions(questions, questionOrder, uuid);
		}
		return assembled;
	});
}
