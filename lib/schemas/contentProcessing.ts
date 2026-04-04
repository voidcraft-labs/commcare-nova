/**
 * Content post-processing utilities for structured output from form generation.
 *
 * Converts flat questions (parentId-based) to nested trees, strips empty sentinel
 * values from structured output, and merges data model defaults from case types.
 */
import type { CaseType, BlueprintForm, Question } from "./blueprint";

type CaseTypes = CaseType[] | null;

// ── XPath utilities ──────────────────────────────────────────────────

const XPATH_FIELDS = [
	"validation",
	"relevant",
	"calculate",
	"default_value",
	"required",
] as const;

/** Unescape HTML entities that LLMs sometimes emit in XPath strings. */
function unescapeXPath(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

// ── Types ───────────────────────────────────────────────────────────

/** The flat question shape as it comes from structured output (before tree conversion). */
export interface FlatQuestion {
	id: string;
	type: string;
	parentId: string;
	label?: string;
	hint?: string;
	required?: string;
	validation?: string;
	validation_msg?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	case_property_on?: string;
	options?: Array<{ value: string; label: string }>;
}

/** Content output for a single form (structured output shape). */
export interface FormContentOutput {
	formIndex: number;
	questions: FlatQuestion[];
	close_case?: { question: string; answer: string };
}

// ── Strip empty sentinel values ─────────────────────────────────────

/** Convert empty strings to undefined, empty arrays to undefined, false booleans to undefined.
 *  With optional schema fields, values may already be undefined — pass through as-is. */
export function stripEmpty(q: FlatQuestion): Partial<FlatQuestion> {
	const result: any = {};
	for (const [k, v] of Object.entries(q)) {
		if (v === undefined) continue;
		if (v === "") continue;
		if (v === false) continue;
		if (Array.isArray(v) && v.length === 0) continue;
		result[k] = v;
	}
	// parentId: empty string → null for tree building
	if (result.parentId === undefined) result.parentId = null;
	else if (result.parentId === "") result.parentId = null;
	return result;
}

// ── Flat → nested tree conversion ───────────────────────────────────

/**
 * Convert flat questions (parentId) to a nested tree (children arrays).
 * Array order is preserved — questions appear in the order they were generated.
 */
export function buildQuestionTree(
	flat: Array<Partial<FlatQuestion>>,
): Question[] {
	const byParent = new Map<string | null, Array<Partial<FlatQuestion>>>();
	for (const q of flat) {
		const parent = q.parentId || null;
		if (!byParent.has(parent)) byParent.set(parent, []);
		byParent.get(parent)!.push(q);
	}

	function buildLevel(parentId: string | null): Question[] {
		const children = byParent.get(parentId) ?? [];
		return children.map((q) => {
			const { parentId: _, ...rest } = q;
			const nested = buildLevel(q.id!);
			if (nested.length > 0) {
				return { ...rest, children: nested } as Question;
			}
			return rest as Question;
		});
	}

	return buildLevel(null);
}

// ── Data model defaults + XPath sanitization ────────────────────────

/**
 * Apply data model defaults from case type metadata and sanitize XPath.
 * Looks up the case type by the question's case_property_on value.
 *
 * When formType is 'followup' and a question is a primary case property
 * (case_property_on matches moduleCaseType), auto-sets default_value to
 * `#case/{id}` so the value is visible in the UI and exported as a <setvalue>.
 */
export function applyDefaults(
	q: Partial<FlatQuestion>,
	caseTypes: CaseTypes,
	formType?: "registration" | "followup" | "survey",
	moduleCaseType?: string,
): Partial<FlatQuestion> {
	const result = { ...q };

	// Unescape HTML entities in XPath fields
	for (const f of XPATH_FIELDS) {
		const val = result[f as keyof FlatQuestion];
		if (typeof val === "string") {
			(result as any)[f] = unescapeXPath(val);
		}
	}

	// Merge data model defaults from case type (question id = property name)
	if (result.case_property_on && caseTypes) {
		const ct = caseTypes.find((c) => c.name === result.case_property_on);
		const prop = ct?.properties.find((p) => p.name === result.id);
		if (prop) {
			result.type ??= (prop.data_type ?? "text") as any;
			result.label ??= prop.label;
			result.hint ??= prop.hint;
			result.required ??= prop.required;
			result.validation ??= prop.validation;
			result.validation_msg ??= prop.validation_msg;
			result.options ??= prop.options;
		}
	}

	// Auto-set default_value for primary case properties in follow-up forms.
	// Mirrors the case_preload logic in deriveCaseConfig: primary props (excluding
	// case_name) get preloaded from the case. Setting default_value here makes the
	// preload visible in the UI and exports it as a <setvalue>.
	if (
		formType === "followup" &&
		result.case_property_on &&
		result.case_property_on === moduleCaseType &&
		result.id !== "case_name" &&
		!result.default_value &&
		!result.calculate
	) {
		result.default_value = `#case/${result.id}`;
	}

	return result;
}

// ── Nested → flat conversion ─────────────────────────────────────────

/** Convert nested Question[] (with children) back to flat FlatQuestion[] (with parentId). */
export function flattenToFlat(
	questions: Question[],
	parentId: string = "",
): FlatQuestion[] {
	const result: FlatQuestion[] = [];
	for (const q of questions) {
		const { children, ...rest } = q;
		result.push({ ...rest, parentId } as FlatQuestion);
		if (children?.length) result.push(...flattenToFlat(children, q.id));
	}
	return result;
}

// ── Single form processing ──────────────────────────────────────────

/**
 * Process a single form's flat questions into a BlueprintForm.
 * Strips empty sentinels, applies data model defaults, converts to nested tree.
 */
export function processSingleFormOutput(
	formOutput: FormContentOutput,
	formName: string,
	formType: "registration" | "followup" | "survey",
	caseTypes: CaseTypes,
	moduleCaseType?: string,
): BlueprintForm {
	const stripped = formOutput.questions.map((q) => stripEmpty(q));
	const withDefaults = stripped.map((q) =>
		applyDefaults(q, caseTypes, formType, moduleCaseType),
	);
	const nestedQuestions = buildQuestionTree(withDefaults);

	const hasCloseCase =
		formOutput.close_case?.question || formOutput.close_case?.answer;
	const closeCase = hasCloseCase
		? {
				...(formOutput.close_case?.question && {
					question: formOutput.close_case.question,
				}),
				...(formOutput.close_case?.answer && {
					answer: formOutput.close_case.answer,
				}),
			}
		: undefined;

	return {
		name: formName,
		type: formType,
		questions: nestedQuestions,
		...(closeCase && { close_case: closeCase }),
	};
}
