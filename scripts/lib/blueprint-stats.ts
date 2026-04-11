/**
 * Blueprint analysis functions for diagnostic scripts.
 *
 * Computes structural metrics, quality indicators, and logic element
 * counts from an AppBlueprint. All functions are pure — they take
 * blueprint data and return computed results. No Firestore access.
 *
 * Used by inspect-app (--stats, --logic, --case-lists) and
 * inspect-compare (side-by-side quality comparison).
 */

import type {
	AppBlueprint,
	BlueprintForm,
	BlueprintModule,
	Question,
} from "./types";

// ── Result types ────────────────────────────────────────────────────

/** Counts of questions grouped by their `type` field. */
export interface QuestionTypeCounts {
	/** e.g. { text: 12, int: 5, single_select: 8, group: 3, hidden: 2 } */
	byType: Record<string, number>;
	/** Total including nested children. */
	total: number;
}

/**
 * Counts of "logic elements" — questions that have XPath expressions.
 *
 * These are the indicators of form sophistication: how much conditional
 * behavior, validation, and computed state the form contains. A form
 * with many logic elements handles edge cases well; one with few is
 * a basic data entry form.
 */
export interface LogicCounts {
	/** Questions with a `calculate` expression (computed fields). */
	calculates: number;
	/** Questions with a `relevant` expression (show-when / skip logic). */
	relevants: number;
	/** Questions with a `default_value` expression. */
	defaults: number;
	/** Questions with a `validation` expression. */
	validations: number;
	/** Questions with a `required` expression set to something other than "false()". */
	requireds: number;
	/** Questions with a `hint` string. */
	hints: number;
	/** Questions of type "label" (display-only, no data capture). */
	labels: number;
	/** Total unique questions with at least one logic element. */
	questionsWithLogic: number;
}

/** Per-form summary statistics. */
export interface FormStats {
	name: string;
	type: string;
	questionCount: number;
	questionTypes: QuestionTypeCounts;
	logic: LogicCounts;
	hasPostSubmit: boolean;
	postSubmitValue: string | undefined;
	hasCloseCase: boolean;
	hasFormLinks: boolean;
	hasConnect: boolean;
	/** Number of case properties saved by this form (questions with case_property_on). */
	casePropertyCount: number;
}

/** Per-module summary statistics. */
export interface ModuleStats {
	name: string;
	caseType: string | undefined;
	caseListOnly: boolean;
	caseListColumns: number;
	caseDetailColumns: number;
	forms: FormStats[];
	totalQuestions: number;
}

/** Top-level blueprint analysis result. */
export interface BlueprintStats {
	appName: string;
	connectType: string | undefined;
	modules: ModuleStats[];
	totals: {
		modules: number;
		forms: number;
		questions: number;
		questionTypes: QuestionTypeCounts;
		logic: LogicCounts;
		/** Form count by type, e.g. { registration: 2, followup: 3, survey: 1 }. */
		formsByType: Record<string, number>;
	};
	/** Quality flags — things that might indicate missing configuration. */
	qualityFlags: QualityFlag[];
	/** Case types defined in the blueprint. */
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
 * A question with at least one logic element, for the --logic view.
 *
 * Includes the full tree path so a user can locate the question within
 * the blueprint without having to search for it by ID.
 */
export interface LogicQuestion {
	/** Full path: "Module > Form > group_id > question_id" */
	path: string;
	type: string;
	id: string;
	/** Which logic elements are present. */
	has: Array<
		"calculate" | "relevant" | "default" | "validation" | "required" | "hint"
	>;
	/** The actual expressions, keyed by element name. */
	expressions: Record<string, string>;
}

// ── Core counting functions ─────────────────────────────────────────

/** Recursively count all questions (including children in groups/repeats). */
export function countQuestions(questions: Question[]): number {
	let count = 0;
	for (const q of questions) {
		count++;
		if (q.children?.length) {
			count += countQuestions(q.children);
		}
	}
	return count;
}

/** Count questions grouped by type, recursively through children. */
export function countQuestionTypes(questions: Question[]): QuestionTypeCounts {
	const byType: Record<string, number> = {};
	let total = 0;

	function walk(qs: Question[]) {
		for (const q of qs) {
			const t = q.type ?? "unknown";
			byType[t] = (byType[t] ?? 0) + 1;
			total++;
			if (q.children?.length) walk(q.children);
		}
	}

	walk(questions);
	return { byType, total };
}

/**
 * Count logic elements across all questions, recursively.
 *
 * A question "has logic" if it has at least one of: calculate, relevant,
 * default_value, validation, required (non-false), or hint.
 */
export function countLogicElements(questions: Question[]): LogicCounts {
	const counts: LogicCounts = {
		calculates: 0,
		relevants: 0,
		defaults: 0,
		validations: 0,
		requireds: 0,
		hints: 0,
		labels: 0,
		questionsWithLogic: 0,
	};

	function walk(qs: Question[]) {
		for (const q of qs) {
			let hasAny = false;

			if (q.calculate) {
				counts.calculates++;
				hasAny = true;
			}
			if (q.relevant) {
				counts.relevants++;
				hasAny = true;
			}
			if (q.default_value) {
				counts.defaults++;
				hasAny = true;
			}
			if (q.validation) {
				counts.validations++;
				hasAny = true;
			}
			/* required = "true()" is meaningful; "false()" is the default / absent. */
			if (q.required && q.required !== "false()") {
				counts.requireds++;
				hasAny = true;
			}
			if (q.hint) {
				counts.hints++;
				hasAny = true;
			}
			if (q.type === "label") {
				counts.labels++;
			}

			if (hasAny) counts.questionsWithLogic++;

			if (q.children?.length) walk(q.children);
		}
	}

	walk(questions);
	return counts;
}

/**
 * Count questions that save to a case property (have case_property_on set).
 * Recurses through children in groups/repeats.
 */
function countCaseProperties(questions: Question[]): number {
	let count = 0;
	function walk(qs: Question[]) {
		for (const q of qs) {
			if (q.case_property_on) count++;
			if (q.children?.length) walk(q.children);
		}
	}
	walk(questions);
	return count;
}

// ── Per-entity analysis ─────────────────────────────────────────────

/** Compute full stats for a single form. */
export function analyzeForm(form: BlueprintForm): FormStats {
	const questions = form.questions ?? [];
	return {
		name: form.name,
		type: form.type,
		questionCount: countQuestions(questions),
		questionTypes: countQuestionTypes(questions),
		logic: countLogicElements(questions),
		hasPostSubmit: form.post_submit !== undefined,
		postSubmitValue: form.post_submit,
		hasCloseCase: form.type === "close",
		hasFormLinks: (form.form_links?.length ?? 0) > 0,
		hasConnect: form.connect !== undefined,
		casePropertyCount: countCaseProperties(questions),
	};
}

/** Compute full stats for a single module. */
export function analyzeModule(mod: BlueprintModule): ModuleStats {
	const forms = (mod.forms ?? []).map(analyzeForm);
	return {
		name: mod.name,
		caseType: mod.case_type,
		caseListOnly: mod.case_list_only ?? false,
		caseListColumns: mod.case_list_columns?.length ?? 0,
		caseDetailColumns: mod.case_detail_columns?.length ?? 0,
		forms,
		totalQuestions: forms.reduce((sum, f) => sum + f.questionCount, 0),
	};
}

// ── Aggregate logic helpers ─────────────────────────────────────────

/** Merge two LogicCounts by summing every field. */
function mergeLogicCounts(a: LogicCounts, b: LogicCounts): LogicCounts {
	return {
		calculates: a.calculates + b.calculates,
		relevants: a.relevants + b.relevants,
		defaults: a.defaults + b.defaults,
		validations: a.validations + b.validations,
		requireds: a.requireds + b.requireds,
		hints: a.hints + b.hints,
		labels: a.labels + b.labels,
		questionsWithLogic: a.questionsWithLogic + b.questionsWithLogic,
	};
}

/** Merge two QuestionTypeCounts by summing every key. */
function mergeQuestionTypes(
	a: QuestionTypeCounts,
	b: QuestionTypeCounts,
): QuestionTypeCounts {
	const merged: Record<string, number> = { ...a.byType };
	for (const [type, count] of Object.entries(b.byType)) {
		merged[type] = (merged[type] ?? 0) + count;
	}
	return { byType: merged, total: a.total + b.total };
}

/** Zero-valued LogicCounts for use as an accumulator seed. */
const EMPTY_LOGIC: LogicCounts = {
	calculates: 0,
	relevants: 0,
	defaults: 0,
	validations: 0,
	requireds: 0,
	hints: 0,
	labels: 0,
	questionsWithLogic: 0,
};

/** Zero-valued QuestionTypeCounts for use as an accumulator seed. */
const EMPTY_TYPES: QuestionTypeCounts = { byType: {}, total: 0 };

// ── Main entry point ────────────────────────────────────────────────

/**
 * Compute comprehensive blueprint statistics.
 *
 * Analyzes the entire blueprint and returns structured stats suitable
 * for display (--stats), comparison (inspect-compare), and quality flagging.
 */
export function analyzeBlueprint(bp: AppBlueprint): BlueprintStats {
	const modules = (bp.modules ?? []).map(analyzeModule);

	/* Aggregate totals across all modules. */
	const totalForms = modules.reduce((sum, m) => sum + m.forms.length, 0);
	const totalQuestions = modules.reduce((sum, m) => sum + m.totalQuestions, 0);

	const totalLogic = modules.reduce(
		(acc, m) => m.forms.reduce((a, f) => mergeLogicCounts(a, f.logic), acc),
		EMPTY_LOGIC,
	);

	const totalTypes = modules.reduce(
		(acc, m) =>
			m.forms.reduce((a, f) => mergeQuestionTypes(a, f.questionTypes), acc),
		EMPTY_TYPES,
	);

	/* Count forms by type (registration, followup, survey). */
	const formsByType: Record<string, number> = {};
	for (const m of modules) {
		for (const f of m.forms) {
			formsByType[f.type] = (formsByType[f.type] ?? 0) + 1;
		}
	}

	/* Extract case type summary. */
	const caseTypes = (bp.case_types ?? []).map((ct) => ({
		name: ct.name,
		propertyCount: ct.properties?.length ?? 0,
		parentType: ct.parent_type,
	}));

	return {
		appName: bp.app_name,
		connectType: bp.connect_type,
		modules,
		totals: {
			modules: modules.length,
			forms: totalForms,
			questions: totalQuestions,
			questionTypes: totalTypes,
			logic: totalLogic,
			formsByType,
		},
		qualityFlags: checkQuality(bp, modules),
		caseTypes,
	};
}

// ── Logic question extraction ───────────────────────────────────────

/**
 * Extract all questions with logic elements, with full tree paths.
 *
 * Returns a flat list of "smart" questions — those with at least one
 * calculate, relevant, default_value, validation, required, or hint.
 * Used by the --logic flag to show only the logic-bearing questions.
 */
export function extractLogicQuestions(bp: AppBlueprint): LogicQuestion[] {
	const results: LogicQuestion[] = [];

	for (const mod of bp.modules ?? []) {
		for (const form of mod.forms ?? []) {
			walkForLogic(results, mod.name, form.name, "", form.questions ?? []);
		}
	}

	return results;
}

/** Recursive walker that collects questions with logic into `out`. */
function walkForLogic(
	out: LogicQuestion[],
	moduleName: string,
	formName: string,
	parentPath: string,
	questions: Question[],
) {
	for (const q of questions) {
		const path = parentPath
			? `${parentPath}/${q.id}`
			: `${moduleName} > ${formName} > ${q.id}`;

		const has: LogicQuestion["has"] = [];
		const expressions: Record<string, string> = {};

		if (q.calculate) {
			has.push("calculate");
			expressions.calculate = q.calculate;
		}
		if (q.relevant) {
			has.push("relevant");
			expressions.relevant = q.relevant;
		}
		if (q.default_value) {
			has.push("default");
			expressions.default = q.default_value;
		}
		if (q.validation) {
			has.push("validation");
			expressions.validation = q.validation;
		}
		if (q.required && q.required !== "false()") {
			has.push("required");
			expressions.required = q.required;
		}
		if (q.hint) {
			has.push("hint");
			expressions.hint = q.hint;
		}

		if (has.length > 0) {
			out.push({ path, type: q.type, id: q.id, has, expressions });
		}

		if (q.children?.length) {
			walkForLogic(out, moduleName, formName, path, q.children);
		}
	}
}

// ── Quality checks ──────────────────────────────────────────────────

/**
 * Run quality checks and return flags.
 *
 * Identifies common configuration oversights:
 *   - Registration forms without a case_name question (case has no name)
 *   - Modules with case_type but no case_list_columns (invisible columns)
 *   - Hidden questions without calculate (orphaned, always blank)
 *   - Forms with zero case_property_on questions (form saves nothing)
 *
 * NOTE: post_submit is NOT flagged. The system applies form-type defaults
 * automatically ("previous" for followup, "app_home" for registration/survey),
 * so omitting post_submit is correct behavior — the SA shouldn't set them.
 */
function checkQuality(bp: AppBlueprint, modules: ModuleStats[]): QualityFlag[] {
	const flags: QualityFlag[] = [];

	for (const mod of modules) {
		/* Modules with a case type should have case list columns configured. */
		if (mod.caseType && !mod.caseListOnly && mod.caseListColumns === 0) {
			flags.push({
				severity: "warn",
				module: mod.name,
				message: `Module has case_type "${mod.caseType}" but no case_list_columns`,
			});
		}

		for (const form of mod.forms) {
			/* Registration forms need a case_name question. */
			if (form.type === "registration") {
				const hasCaseName = hasCaseNameQuestion(bp, mod, form);
				if (!hasCaseName) {
					flags.push({
						severity: "error",
						module: mod.name,
						form: form.name,
						message:
							"Registration form has no case_name question — case will have no name",
					});
				}
			}

			/* Forms with case_type but no case properties saved are suspicious. */
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
						"Form has no questions with case_property_on — saves nothing to the case",
				});
			}
		}
	}

	/* Check for orphaned hidden questions (hidden without calculate). */
	for (const mod of bp.modules ?? []) {
		for (const form of mod.forms ?? []) {
			checkOrphanedHiddens(flags, mod.name, form.name, form.questions ?? []);
		}
	}

	return flags;
}

/** Check if a registration form has a case_name question (recursive). */
function hasCaseNameQuestion(
	_bp: AppBlueprint,
	_mod: ModuleStats,
	_form: FormStats,
): boolean {
	/* Walk the original blueprint form to find the question. The FormStats
	 * doesn't carry individual question IDs — we need the raw blueprint. */
	const origMod = (_bp.modules ?? []).find((m) => m.name === _mod.name);
	const origForm = (origMod?.forms ?? []).find((f) => f.name === _form.name);
	if (!origForm) return false;

	function findCaseName(qs: Question[]): boolean {
		for (const q of qs) {
			if (q.id === "case_name") return true;
			if (q.children?.length && findCaseName(q.children)) return true;
		}
		return false;
	}

	return findCaseName(origForm.questions ?? []);
}

/**
 * Flag hidden questions that have no calculate expression.
 * These are likely orphaned — they'll always be blank unless populated
 * by some external mechanism not visible in the blueprint.
 */
function checkOrphanedHiddens(
	flags: QualityFlag[],
	moduleName: string,
	formName: string,
	questions: Question[],
) {
	for (const q of questions) {
		if (q.type === "hidden" && !q.calculate && !q.default_value) {
			flags.push({
				severity: "info",
				module: moduleName,
				form: formName,
				message: `Hidden question "${q.id}" has no calculate or default_value`,
			});
		}
		if (q.children?.length) {
			checkOrphanedHiddens(flags, moduleName, formName, q.children);
		}
	}
}
