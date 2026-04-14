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
	BlueprintModule,
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
 * Reads module and form UUIDs verbatim from the blueprint — every module +
 * form must carry a uuid (mint sites are `bpAddModule`/`bpAddForm`/`bp
 * SetScaffold` in `blueprintHelpers.ts`). Throws on missing uuids, matching
 * the contract enforced by `toDoc` in `lib/doc/converter.ts`.
 *
 * Now used only by tests covering close_case → close_condition migration
 * (`formBuilderAgent.test.ts`). Runtime ingestion goes through `toDoc`.
 */
export function decomposeBlueprint(bp: AppBlueprint): NormalizedData {
	const modules: Record<string, NModule> = {};
	const forms: Record<string, NForm> = {};
	const questions: Record<string, NQuestion> = {};
	const moduleOrder: string[] = [];
	const formOrder: Record<string, string[]> = {};
	const questionOrder: Record<string, string[]> = {};

	for (const mod of bp.modules) {
		if (!mod.uuid) {
			throw new Error(
				`decomposeBlueprint: module "${mod.name}" missing uuid — run scripts/migrate-module-form-uuids.ts or re-create the app`,
			);
		}
		const moduleId = mod.uuid;
		moduleOrder.push(moduleId);

		modules[moduleId] = decomposeModuleEntity(mod);

		const formIds: string[] = [];
		formOrder[moduleId] = formIds;

		for (const form of mod.forms) {
			if (!form.uuid) {
				throw new Error(
					`decomposeBlueprint: form "${form.name}" in module "${mod.name}" missing uuid — run scripts/migrate-module-form-uuids.ts or re-create the app`,
				);
			}
			const formId = form.uuid;
			formIds.push(formId);

			forms[formId] = decomposeFormEntity(form);
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

// ── Assemble (flat maps → tree) ──────────────────────────────────────

/**
 * Convert an NModule entity's camelCase fields back to the wire-format
 * snake_case `BlueprintModule` shape (without the nested `forms` array).
 *
 * Exported so `lib/doc/converter.ts` can reuse the same camel→snake mapping
 * in `toBlueprint`. Omits undefined/null/empty optional fields to produce
 * a clean wire-format object — matching the blueprint schema's `.optional()`
 * semantics where absent keys are preferred over explicit `undefined`.
 */
export function assembleModuleFields(
	mod: NModule,
): Omit<BlueprintModule, "forms"> {
	return {
		uuid: mod.uuid,
		name: mod.name,
		...(mod.caseType != null && { case_type: mod.caseType }),
		...(mod.caseListOnly && { case_list_only: mod.caseListOnly }),
		...(mod.caseListColumns && { case_list_columns: mod.caseListColumns }),
		...(mod.caseDetailColumns !== undefined &&
			mod.caseDetailColumns !== null && {
				case_detail_columns: mod.caseDetailColumns,
			}),
	};
}

/**
 * Convert an NForm entity's camelCase fields back to the wire-format
 * snake_case `BlueprintForm` shape (without the nested `questions` array).
 *
 * Exported so `lib/doc/converter.ts` can reuse the same camel→snake mapping
 * in `toBlueprint`.
 */
export function assembleFormFields(
	form: NForm,
): Omit<BlueprintForm, "questions"> {
	return {
		uuid: form.uuid,
		name: form.name,
		type: form.type,
		...(form.closeCondition && { close_condition: form.closeCondition }),
		...(form.postSubmit && { post_submit: form.postSubmit }),
		...(form.formLinks && { form_links: form.formLinks }),
		...(form.connect && { connect: form.connect }),
	};
}

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
				...assembleModuleFields(mod),
				forms: fIds.map((formId) => {
					const form = data.forms[formId];
					return assembleForm(form, formId, data.questions, data.questionOrder);
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
		...assembleFormFields(form),
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

// ── Shared decompose/assemble helpers ────────────────────────────────
//
// Exported so `lib/doc/converter.ts` can reuse the same snake↔camel field
// mapping that `decomposeBlueprint` and `assembleBlueprint` use. One
// source of truth for module/form entity conversion.

/**
 * Convert a BlueprintModule to an NModule entity (no nested forms).
 *
 * Maps wire-format snake_case fields (`case_type`, `case_list_columns`, etc.)
 * to camelCase entity fields. Mirrors the inline mapping in
 * `decomposeBlueprint` — extracted so `lib/doc/converter.ts` can share it.
 *
 * Reads `mod.uuid` verbatim. Throws if missing — mint sites are
 * `bpAddModule`/`bpSetScaffold` in `blueprintHelpers.ts`, and legacy
 * blueprints get migrated by `scripts/migrate-module-form-uuids.ts`.
 */
export function decomposeModuleEntity(mod: BlueprintModule): NModule {
	if (!mod.uuid) {
		throw new Error(
			`decomposeModuleEntity: module "${mod.name}" missing uuid — run scripts/migrate-module-form-uuids.ts or re-create the app`,
		);
	}
	return {
		uuid: mod.uuid,
		name: mod.name,
		caseType: mod.case_type ?? undefined,
		caseListOnly: mod.case_list_only ?? undefined,
		purpose: undefined,
		caseListColumns: mod.case_list_columns ?? undefined,
		caseDetailColumns: mod.case_detail_columns ?? undefined,
	};
}

/**
 * Convert a BlueprintForm to an NForm entity (no questions).
 *
 * Exported so `lib/doc/converter.ts` can reuse the same snake→camel mapping
 * for its `FormEntity` type (structurally identical to `NForm`).
 *
 * Reads `form.uuid` verbatim. Throws if missing — mint sites are
 * `bpAddForm`/`bpReplaceForm`/`bpSetScaffold` in `blueprintHelpers.ts`,
 * and legacy blueprints get migrated by `scripts/migrate-module-form-uuids.ts`.
 *
 * Migration: old blueprints have `close_case` on followup forms. When present,
 * the form is promoted to type "close" and `close_case` is converted to
 * `closeCondition`. Unconditional close (empty close_case `{}`) maps to
 * closeCondition = undefined (the default for close forms).
 */
export function decomposeFormEntity(form: BlueprintForm): NForm {
	if (!form.uuid) {
		throw new Error(
			`decomposeFormEntity: form "${form.name}" missing uuid — run scripts/migrate-module-form-uuids.ts or re-create the app`,
		);
	}

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
		uuid: form.uuid,
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
