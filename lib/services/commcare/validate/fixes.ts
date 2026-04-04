/**
 * Auto-fix registry — maps validation error codes to fix functions.
 *
 * Each fix mutates the blueprint in place and returns true if it made a change.
 * The fix loop dispatches errors to these functions by code instead of regex-matching strings.
 */

import type {
	AppBlueprint,
	BlueprintForm,
	Question,
} from "@/lib/schemas/blueprint";
import { XML_ELEMENT_NAME_REGEX } from "../constants";
import type { ValidationError, ValidationErrorCode } from "./errors";

type FixFn = (error: ValidationError, blueprint: AppBlueprint) => boolean;

// ── Question search helpers ────────────────────────────────────────

function findQuestionById(
	questions: Question[],
	id: string,
): Question | undefined {
	for (const q of questions) {
		if (q.id === id) return q;
		if (q.children) {
			const found = findQuestionById(q.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

function findCaseNameCandidate(questions: Question[]): Question | undefined {
	// First pass: text question with case_property_on that has "name" in its ID
	for (const q of questions) {
		if (q.case_property_on && /name/i.test(q.id) && q.type === "text") return q;
		if (q.children) {
			const found = findCaseNameCandidate(q.children);
			if (found) return found;
		}
	}
	// Second pass: first question with case_property_on
	for (const q of questions) {
		if (q.case_property_on) return q;
		if (q.children) {
			const found = findCaseNameCandidate(q.children);
			if (found) return found;
		}
	}
	return undefined;
}

function renameReservedProperty(
	questions: Question[],
	reserved: string,
): boolean {
	let changed = false;
	for (const q of questions) {
		if (q.id === reserved && q.case_property_on) {
			q.id = `${reserved}_value`;
			changed = true;
		}
		if (q.children && renameReservedProperty(q.children, reserved)) {
			changed = true;
		}
	}
	return changed;
}

function findQuestionByCaseProperty(
	questions: Question[],
	prop: string,
): Question | undefined {
	for (const q of questions) {
		if (q.id === prop && q.case_property_on) return q;
		if (q.children) {
			const found = findQuestionByCaseProperty(q.children, prop);
			if (found) return found;
		}
	}
	return undefined;
}

function sanitizeToXmlName(id: string): string {
	// Strip leading non-letter/underscore chars, replace invalid chars with underscore
	let result = id.replace(/[^a-zA-Z0-9_]/g, "_");
	if (!/^[a-zA-Z_]/.test(result)) result = `q_${result}`;
	return result;
}

// ── Form lookup ────────────────────────────────────────────────────

function findForm(
	blueprint: AppBlueprint,
	error: ValidationError,
): BlueprintForm | undefined {
	const { location: loc } = error;
	if (loc.moduleIndex !== undefined && loc.formIndex !== undefined) {
		return blueprint.modules[loc.moduleIndex]?.forms[loc.formIndex];
	}
	if (loc.formName) {
		for (const mod of blueprint.modules) {
			const form = mod.forms.find((f) => f.name === loc.formName);
			if (form) return form;
		}
	}
	return undefined;
}

function findModuleCaseType(
	blueprint: AppBlueprint,
	error: ValidationError,
): string | undefined {
	const { location: loc } = error;
	if (loc.moduleIndex !== undefined) {
		return blueprint.modules[loc.moduleIndex]?.case_type ?? undefined;
	}
	return undefined;
}

// ── Fix functions ──────────────────────────────────────────────────

const fixNoCaseType: FixFn = (error, blueprint) => {
	const { location: loc } = error;
	if (loc.moduleIndex === undefined) return false;
	const mod = blueprint.modules[loc.moduleIndex];
	if (mod && !mod.case_type) {
		mod.case_type = mod.name.toLowerCase().replace(/\s+/g, "_");
		return true;
	}
	return false;
};

const fixNoCaseNameField: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form) return false;
	const candidate = findCaseNameCandidate(form.questions);
	if (candidate) {
		candidate.id = "case_name";
		const moduleCaseType = findModuleCaseType(blueprint, error);
		if (moduleCaseType) candidate.case_property_on = moduleCaseType;
		return true;
	}
	return false;
};

const fixReservedCaseProperty: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.details?.reservedName) return false;
	return renameReservedProperty(form.questions, error.details.reservedName);
};

const fixMediaCaseProperty: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.details?.property) return false;
	const q = findQuestionByCaseProperty(form.questions, error.details.property);
	if (q) {
		delete q.case_property_on;
		return true;
	}
	return false;
};

const fixUnquotedStringLiteral: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.details?.bareWord || !error.details?.field) return false;
	const q = error.location.questionId
		? findQuestionById(form.questions, error.location.questionId)
		: undefined;
	if (!q) return false;
	type XPathField =
		| "validation"
		| "relevant"
		| "calculate"
		| "default_value"
		| "required";
	const field = error.details.field as XPathField;
	const val = q[field];
	if (typeof val === "string") {
		q[field] = `'${error.details.bareWord}'`;
		return true;
	}
	return false;
};

const fixSelectNoOptions: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.location.questionId) return false;
	const q = findQuestionById(form.questions, error.location.questionId);
	if (q) {
		q.options = [
			{ value: "option_1", label: "Option 1" },
			{ value: "option_2", label: "Option 2" },
		];
		return true;
	}
	return false;
};

const fixCloseCase: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form) return false;
	delete form.close_case;
	return true;
};

const fixUnknownFunction: FixFn = (error, blueprint) => {
	// Only fix case-mismatched function names (e.g. Today → today)
	const match = error.message.match(
		/Unknown function "(\w[\w-]*)[\w-]*\(\)" — did you mean "(\w[\w-]*)[\w-]*\(\)"/,
	);
	if (!match) return false;
	const [, wrong, correct] = match;
	const form = findForm(blueprint, error);
	if (!form || !error.location.questionId) return false;
	const q = findQuestionById(form.questions, error.location.questionId);
	if (!q) return false;

	type XPathField =
		| "validation"
		| "relevant"
		| "calculate"
		| "default_value"
		| "required";
	const fields: XPathField[] = [
		"validation",
		"relevant",
		"calculate",
		"default_value",
		"required",
	];
	let changed = false;
	for (const field of fields) {
		const val = q[field];
		if (typeof val === "string" && val.includes(`${wrong}(`)) {
			q[field] = val.replaceAll(`${wrong}(`, `${correct}(`);
			changed = true;
		}
	}
	return changed;
};

const fixWrongArity: FixFn = (error, blueprint) => {
	// Only fix round(x, 2) → round(x)
	if (!error.message.includes("round()")) return false;
	const form = findForm(blueprint, error);
	if (!form || !error.location.questionId) return false;
	const q = findQuestionById(form.questions, error.location.questionId);
	if (!q) return false;

	type XPathField =
		| "validation"
		| "relevant"
		| "calculate"
		| "default_value"
		| "required";
	const fields: XPathField[] = [
		"validation",
		"relevant",
		"calculate",
		"default_value",
		"required",
	];
	let changed = false;
	for (const field of fields) {
		const val = q[field];
		if (typeof val === "string") {
			const fixed = val.replace(/round\(([^,)]+),\s*[^)]+\)/g, "round($1)");
			if (fixed !== val) {
				q[field] = fixed;
				changed = true;
			}
		}
	}
	return changed;
};

const fixInvalidQuestionId: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.details?.questionId) return false;
	const q = findQuestionById(form.questions, error.details.questionId);
	if (!q) return false;
	const sanitized = sanitizeToXmlName(q.id);
	if (sanitized !== q.id && XML_ELEMENT_NAME_REGEX.test(sanitized)) {
		q.id = sanitized;
		return true;
	}
	return false;
};

const fixCasePropertyBadFormat: FixFn = (error, blueprint) => {
	const form = findForm(blueprint, error);
	if (!form || !error.details?.property) return false;
	const q = findQuestionByCaseProperty(form.questions, error.details.property);
	if (!q) return false;
	// Sanitize the question ID (which is the case property name)
	const sanitized = sanitizeToXmlName(q.id);
	if (sanitized !== q.id) {
		q.id = sanitized;
		return true;
	}
	return false;
};

// ── Registry ───────────────────────────────────────────────────────

export const FIX_REGISTRY = new Map<ValidationErrorCode, FixFn>([
	["NO_CASE_TYPE", fixNoCaseType],
	["NO_CASE_NAME_FIELD", fixNoCaseNameField],
	["RESERVED_CASE_PROPERTY", fixReservedCaseProperty],
	["MEDIA_CASE_PROPERTY", fixMediaCaseProperty],
	["UNQUOTED_STRING_LITERAL", fixUnquotedStringLiteral],
	["SELECT_NO_OPTIONS", fixSelectNoOptions],
	["CLOSE_CASE_NOT_FOLLOWUP", fixCloseCase],
	["CLOSE_CASE_MISSING_ANSWER", fixCloseCase],
	["CLOSE_CASE_MISSING_QUESTION", fixCloseCase],
	["CLOSE_CASE_QUESTION_NOT_FOUND", fixCloseCase],
	["UNKNOWN_FUNCTION", fixUnknownFunction],
	["WRONG_ARITY", fixWrongArity],
	["INVALID_QUESTION_ID", fixInvalidQuestionId],
	["CASE_PROPERTY_BAD_FORMAT", fixCasePropertyBadFormat],
]);
