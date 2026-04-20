/**
 * Blueprint analysis functions for diagnostic scripts.
 *
 * Operates on the normalized `BlueprintDoc` shape persisted in Firestore.
 * Each form is visited in a single DFS pass — the collected `Field[]` is
 * reused across every per-form metric (kind counts, logic counts, case
 * property count, quality flags). This is a deliberate departure from
 * the first draft which made six independent walks per form.
 *
 * Field discriminator is `kind` (not `type`); validation key is
 * `validate` (not `validation`); case linkage is `case_property` (not
 * `case_property_on`). Children live in `fieldOrder[parentUuid]`, not
 * on the field itself.
 */

import { isContainer } from "../../lib/domain";
import type { BlueprintDoc, Field, Form, Module, Uuid } from "./types";

// ── Result types ────────────────────────────────────────────────────

/** Counts of fields grouped by their `kind` discriminator. */
export interface FieldKindCounts {
	/** e.g. { text: 12, int: 5, single_select: 8, group: 3, hidden: 2 } */
	byKind: Record<string, number>;
	/** Total including nested children. */
	total: number;
}

/**
 * Counts of "logic elements" — fields that carry XPath expressions.
 *
 * Indicators of form sophistication: how much conditional behavior,
 * validation, and computed state the form contains.
 */
export interface LogicCounts {
	/** Fields with a `calculate` expression (computed fields). */
	calculates: number;
	/** Fields with a `relevant` expression (show-when / skip logic). */
	relevants: number;
	/** Fields with a `default_value` expression. */
	defaults: number;
	/** Fields with a `validate` expression. */
	validations: number;
	/** Fields with a `required` expression set to something other than "false()". */
	requireds: number;
	/** Fields with a `hint` string. */
	hints: number;
	/** Fields of kind "label" (display-only, no data capture). */
	labels: number;
	/** Total unique fields with at least one logic element. */
	fieldsWithLogic: number;
}

/** Per-form summary statistics. */
export interface FormStats {
	uuid: Uuid;
	name: string;
	type: string;
	fieldCount: number;
	fieldKinds: FieldKindCounts;
	logic: LogicCounts;
	hasPostSubmit: boolean;
	postSubmitValue: string | undefined;
	hasCloseCase: boolean;
	hasFormLinks: boolean;
	hasConnect: boolean;
	/** Number of case properties saved by this form (fields with case_property). */
	casePropertyCount: number;
}

/** Per-module summary statistics. */
export interface ModuleStats {
	uuid: Uuid;
	name: string;
	caseType: string | undefined;
	caseListOnly: boolean;
	caseListColumns: number;
	caseDetailColumns: number;
	forms: FormStats[];
	totalFields: number;
}

/** Top-level blueprint analysis result. */
export interface BlueprintStats {
	appName: string;
	connectType: string | undefined;
	modules: ModuleStats[];
	totals: {
		modules: number;
		forms: number;
		fields: number;
		fieldKinds: FieldKindCounts;
		logic: LogicCounts;
		/** Form count by type, e.g. { registration: 2, followup: 3, survey: 1 }. */
		formsByType: Record<string, number>;
	};
	/** Quality flags — things that might indicate missing configuration. */
	qualityFlags: QualityFlag[];
	/** Case types defined in the doc. */
	caseTypes: Array<{
		name: string;
		propertyCount: number;
		parentType?: string;
	}>;
}

/** A quality concern flagged during analysis. */
export interface QualityFlag {
	severity: "info" | "warn" | "error";
	module?: string;
	form?: string;
	message: string;
}

/**
 * A field with at least one logic element, for the --logic view.
 *
 * Includes the full tree path so a user can locate the field within
 * the doc without having to search for it by id.
 */
export interface LogicField {
	/** Full path: "Module > Form > group_id > field_id" */
	path: string;
	kind: string;
	id: string;
	/** Which logic elements are present. */
	has: Array<
		"calculate" | "relevant" | "default" | "validate" | "required" | "hint"
	>;
	/** The actual expressions, keyed by element name. */
	expressions: Record<string, string>;
}

// ── Core walking helpers ────────────────────────────────────────────

/**
 * Collect every field uuid under `parentUuid` (recursive, containers
 * included). The parent itself is NOT returned. Safe against dangling
 * uuids in `fieldOrder` — entries whose field has been removed are
 * skipped.
 *
 * Private to this module. Callers that only need a count import
 * `countFieldsUnder` from `@/lib/doc/fieldWalk`; this function exists
 * because every per-form analysis needs the full `Field[]` for
 * kind counts, logic counts, and case-property counts in one pass.
 */
function collectFieldsUnder(doc: BlueprintDoc, parentUuid: Uuid): Field[] {
	const out: Field[] = [];
	const stack: Uuid[] = [...(doc.fieldOrder[parentUuid] ?? [])];
	while (stack.length > 0) {
		const uuid = stack.pop() as Uuid;
		const field = doc.fields[uuid];
		if (!field) continue;
		out.push(field);
		if (isContainer(field)) {
			for (const child of doc.fieldOrder[uuid] ?? []) stack.push(child);
		}
	}
	return out;
}

/**
 * Count fields grouped by `kind` from a pre-collected list. Pure
 * over the list — no walk.
 */
function countKindsFromList(fields: Field[]): FieldKindCounts {
	const byKind: Record<string, number> = {};
	for (const f of fields) {
		byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
	}
	return { byKind, total: fields.length };
}

/**
 * Count logic elements from a pre-collected list. A field "has logic"
 * if it carries at least one of: calculate, relevant, default_value,
 * validate, required (non-false), or hint. Not every field kind carries
 * every key — reads are guarded via `in` because the discriminated
 * union doesn't narrow across per-key access.
 */
function countLogicFromList(fields: Field[]): LogicCounts {
	const counts: LogicCounts = {
		calculates: 0,
		relevants: 0,
		defaults: 0,
		validations: 0,
		requireds: 0,
		hints: 0,
		labels: 0,
		fieldsWithLogic: 0,
	};

	for (const f of fields) {
		let hasAny = false;

		if ("calculate" in f && f.calculate) {
			counts.calculates++;
			hasAny = true;
		}
		if ("relevant" in f && f.relevant) {
			counts.relevants++;
			hasAny = true;
		}
		if ("default_value" in f && f.default_value) {
			counts.defaults++;
			hasAny = true;
		}
		if ("validate" in f && f.validate) {
			counts.validations++;
			hasAny = true;
		}
		/* required = "true()" is meaningful; "false()" is the default / absent. */
		if ("required" in f && f.required && f.required !== "false()") {
			counts.requireds++;
			hasAny = true;
		}
		if ("hint" in f && f.hint) {
			counts.hints++;
			hasAny = true;
		}
		if (f.kind === "label") {
			counts.labels++;
		}

		if (hasAny) counts.fieldsWithLogic++;
	}

	return counts;
}

/**
 * Count fields from a pre-collected list that save to a case property
 * (have `case_property` set).
 */
function countCasePropertiesFromList(fields: Field[]): number {
	let count = 0;
	for (const f of fields) {
		if ("case_property" in f && f.case_property) count++;
	}
	return count;
}

// ── Per-entity analysis ─────────────────────────────────────────────

/** Internal: form stats + the collected field list used to produce them. */
interface FormAnalysis {
	stats: FormStats;
	fields: Field[];
}

/**
 * Compute stats for a single form with exactly one DFS walk. Returns
 * both the stats and the collected field list so the caller
 * (`analyzeBlueprint` → `checkQuality`) can reuse the walk for the
 * quality-flag checks instead of re-traversing.
 */
function analyzeForm(doc: BlueprintDoc, form: Form): FormAnalysis {
	const fields = collectFieldsUnder(doc, form.uuid);
	const stats: FormStats = {
		uuid: form.uuid,
		name: form.name,
		type: form.type,
		fieldCount: fields.length,
		fieldKinds: countKindsFromList(fields),
		logic: countLogicFromList(fields),
		hasPostSubmit: form.postSubmit !== undefined,
		postSubmitValue: form.postSubmit,
		hasCloseCase: form.type === "close",
		hasFormLinks: (form.formLinks?.length ?? 0) > 0,
		hasConnect: form.connect != null,
		casePropertyCount: countCasePropertiesFromList(fields),
	};
	return { stats, fields };
}

/** Internal: module stats + per-form collected fields (keyed by form uuid). */
interface ModuleAnalysis {
	stats: ModuleStats;
	formFields: Map<Uuid, Field[]>;
}

function analyzeModule(doc: BlueprintDoc, mod: Module): ModuleAnalysis {
	const formUuids = doc.formOrder[mod.uuid] ?? [];
	const analyses = formUuids
		.map((uuid) => doc.forms[uuid])
		.filter((f): f is Form => f !== undefined)
		.map((f) => analyzeForm(doc, f));

	const formFields = new Map<Uuid, Field[]>();
	for (const { stats, fields } of analyses) {
		formFields.set(stats.uuid, fields);
	}

	const stats: ModuleStats = {
		uuid: mod.uuid,
		name: mod.name,
		caseType: mod.caseType,
		caseListOnly: mod.caseListOnly ?? false,
		caseListColumns: mod.caseListColumns?.length ?? 0,
		caseDetailColumns: mod.caseDetailColumns?.length ?? 0,
		forms: analyses.map((a) => a.stats),
		totalFields: analyses.reduce((sum, a) => sum + a.stats.fieldCount, 0),
	};
	return { stats, formFields };
}

// ── Aggregate helpers ───────────────────────────────────────────────

function mergeLogicCounts(a: LogicCounts, b: LogicCounts): LogicCounts {
	return {
		calculates: a.calculates + b.calculates,
		relevants: a.relevants + b.relevants,
		defaults: a.defaults + b.defaults,
		validations: a.validations + b.validations,
		requireds: a.requireds + b.requireds,
		hints: a.hints + b.hints,
		labels: a.labels + b.labels,
		fieldsWithLogic: a.fieldsWithLogic + b.fieldsWithLogic,
	};
}

function mergeFieldKinds(
	a: FieldKindCounts,
	b: FieldKindCounts,
): FieldKindCounts {
	const merged: Record<string, number> = { ...a.byKind };
	for (const [kind, count] of Object.entries(b.byKind)) {
		merged[kind] = (merged[kind] ?? 0) + count;
	}
	return { byKind: merged, total: a.total + b.total };
}

const EMPTY_LOGIC: LogicCounts = {
	calculates: 0,
	relevants: 0,
	defaults: 0,
	validations: 0,
	requireds: 0,
	hints: 0,
	labels: 0,
	fieldsWithLogic: 0,
};

const EMPTY_KINDS: FieldKindCounts = { byKind: {}, total: 0 };

// ── Main entry point ────────────────────────────────────────────────

/**
 * Compute comprehensive blueprint statistics.
 *
 * Walks the normalized doc in `moduleOrder` / `formOrder` order so the
 * output matches the user's visual mental model. Each form is DFS-walked
 * exactly once; the collected field lists feed both the per-form
 * analysis and the quality-flag checks.
 */
export function analyzeBlueprint(doc: BlueprintDoc): BlueprintStats {
	const moduleAnalyses = doc.moduleOrder
		.map((uuid) => doc.modules[uuid])
		.filter((m): m is Module => m !== undefined)
		.map((m) => analyzeModule(doc, m));

	const modules = moduleAnalyses.map((a) => a.stats);
	const totalForms = modules.reduce((sum, m) => sum + m.forms.length, 0);
	const totalFields = modules.reduce((sum, m) => sum + m.totalFields, 0);

	const totalLogic = modules.reduce(
		(acc, m) => m.forms.reduce((a, f) => mergeLogicCounts(a, f.logic), acc),
		EMPTY_LOGIC,
	);

	const totalKinds = modules.reduce(
		(acc, m) => m.forms.reduce((a, f) => mergeFieldKinds(a, f.fieldKinds), acc),
		EMPTY_KINDS,
	);

	const formsByType: Record<string, number> = {};
	for (const m of modules) {
		for (const f of m.forms) {
			formsByType[f.type] = (formsByType[f.type] ?? 0) + 1;
		}
	}

	const caseTypes = (doc.caseTypes ?? []).map((ct) => ({
		name: ct.name,
		propertyCount: ct.properties?.length ?? 0,
		parentType: ct.parent_type,
	}));

	return {
		appName: doc.appName,
		connectType: doc.connectType ?? undefined,
		modules,
		totals: {
			modules: modules.length,
			forms: totalForms,
			fields: totalFields,
			fieldKinds: totalKinds,
			logic: totalLogic,
			formsByType,
		},
		qualityFlags: checkQuality(doc, moduleAnalyses),
		caseTypes,
	};
}

// ── Logic field extraction ──────────────────────────────────────────

/**
 * Extract all fields with logic elements, with full tree paths.
 *
 * Walks the ordered tree (not the flat entity table) so paths reflect
 * actual containment.
 */
export function extractLogicFields(doc: BlueprintDoc): LogicField[] {
	const results: LogicField[] = [];

	for (const modUuid of doc.moduleOrder) {
		const mod = doc.modules[modUuid];
		if (!mod) continue;
		for (const formUuid of doc.formOrder[modUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			walkForLogic(doc, results, mod.name, form.name, "", form.uuid);
		}
	}

	return results;
}

/** Recursive walker that collects fields with logic into `out`. */
function walkForLogic(
	doc: BlueprintDoc,
	out: LogicField[],
	moduleName: string,
	formName: string,
	parentPath: string,
	parentUuid: Uuid,
) {
	const childUuids = doc.fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const f = doc.fields[uuid];
		if (!f) continue;

		const path = parentPath
			? `${parentPath}/${f.id}`
			: `${moduleName} > ${formName} > ${f.id}`;

		const has: LogicField["has"] = [];
		const expressions: Record<string, string> = {};

		if ("calculate" in f && f.calculate) {
			has.push("calculate");
			expressions.calculate = f.calculate;
		}
		if ("relevant" in f && f.relevant) {
			has.push("relevant");
			expressions.relevant = f.relevant;
		}
		if ("default_value" in f && f.default_value) {
			has.push("default");
			expressions.default = f.default_value;
		}
		if ("validate" in f && f.validate) {
			has.push("validate");
			expressions.validate = f.validate;
		}
		if ("required" in f && f.required && f.required !== "false()") {
			has.push("required");
			expressions.required = f.required;
		}
		if ("hint" in f && f.hint) {
			has.push("hint");
			expressions.hint = f.hint;
		}

		if (has.length > 0) {
			out.push({ path, kind: f.kind, id: f.id, has, expressions });
		}

		if (isContainer(f)) {
			walkForLogic(doc, out, moduleName, formName, path, f.uuid);
		}
	}
}

// ── Quality checks ──────────────────────────────────────────────────

/**
 * Run quality checks against pre-computed module analyses. Consumes the
 * already-collected per-form field lists — no additional walks.
 *
 * Checks:
 *   - Registration forms without a case_name field (case has no name)
 *   - Modules with caseType but no caseListColumns (invisible columns)
 *   - Hidden fields without calculate/default (orphaned, always blank)
 *   - Forms with zero case_property fields (form saves nothing)
 *
 * NOTE: post_submit is NOT flagged. The system applies form-type
 * defaults automatically, so omitting it is correct behavior.
 */
function checkQuality(
	_doc: BlueprintDoc,
	moduleAnalyses: ModuleAnalysis[],
): QualityFlag[] {
	const flags: QualityFlag[] = [];

	for (const { stats: mod, formFields } of moduleAnalyses) {
		if (mod.caseType && !mod.caseListOnly && mod.caseListColumns === 0) {
			flags.push({
				severity: "warn",
				module: mod.name,
				message: `Module has caseType "${mod.caseType}" but no caseListColumns`,
			});
		}

		for (const form of mod.forms) {
			const fields = formFields.get(form.uuid) ?? [];

			if (form.type === "registration") {
				if (!fields.some((f) => f.id === "case_name")) {
					flags.push({
						severity: "error",
						module: mod.name,
						form: form.name,
						message:
							"Registration form has no case_name field — case will have no name",
					});
				}
			}

			if (
				mod.caseType &&
				!mod.caseListOnly &&
				form.type !== "survey" &&
				form.casePropertyCount === 0
			) {
				flags.push({
					severity: "warn",
					module: mod.name,
					form: form.name,
					message:
						"Form has no fields with case_property — saves nothing to the case",
				});
			}

			/* Orphaned hidden fields: hidden kind without calculate. */
			for (const f of fields) {
				if (
					f.kind === "hidden" &&
					!("calculate" in f && f.calculate) &&
					!("default_value" in f && f.default_value)
				) {
					flags.push({
						severity: "info",
						module: mod.name,
						form: form.name,
						message: `Hidden field "${f.id}" has no calculate or default_value`,
					});
				}
			}
		}
	}

	return flags;
}
