/**
 * Question-level validation rules.
 * Each rule receives a question and its form context.
 * These are run recursively over the question tree.
 */

import type { Question } from "@/lib/schemas/blueprint";
import { supportsValidation } from "@/lib/schemas/blueprint";
import { detectUnquotedStringLiteral } from "../../../hqJsonExpander";
import { XML_ELEMENT_NAME_REGEX } from "../../constants";
import { type ValidationError, validationError } from "../errors";

const XPATH_FIELDS = [
	"relevant",
	"validation",
	"calculate",
	"default_value",
	"required",
] as const;

const FIELD_DESCRIPTIONS: Record<string, string> = {
	relevant: "display condition (relevant)",
	validation: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
};

interface QuestionContext {
	formName: string;
	moduleName: string;
	formIndex: number;
	moduleIndex: number;
}

export function selectNoOptions(
	q: Question,
	ctx: QuestionContext,
): ValidationError[] {
	if (
		(q.type === "single_select" || q.type === "multi_select") &&
		(!q.options || q.options.length === 0)
	) {
		const typeName =
			q.type === "single_select" ? "single-select" : "multi-select";
		return [
			validationError(
				"SELECT_NO_OPTIONS",
				"question",
				`Question "${q.id}" in "${ctx.formName}" is a ${typeName} question but has no options to choose from. Add at least one option with a value and label.`,
				{
					moduleIndex: ctx.moduleIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
					questionId: q.id,
				},
			),
		];
	}
	return [];
}

export function hiddenNoValue(
	q: Question,
	ctx: QuestionContext,
): ValidationError[] {
	if (q.type === "hidden" && !q.calculate && !q.default_value) {
		return [
			validationError(
				"HIDDEN_NO_VALUE",
				"question",
				`Question "${q.id}" in "${ctx.formName}" is a hidden field but has no calculate expression or default_value. Hidden fields are invisible to users, so without a computed or default value they'll always be blank. Add a calculate expression or a default_value.`,
				{
					moduleIndex: ctx.moduleIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
					questionId: q.id,
				},
			),
		];
	}
	return [];
}

export function unquotedStringLiteral(
	q: Question,
	ctx: QuestionContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const field of XPATH_FIELDS) {
		const val = q[field];
		if (typeof val !== "string") continue;
		const bare = detectUnquotedStringLiteral(val);
		if (bare) {
			const desc = FIELD_DESCRIPTIONS[field] || field;
			errors.push(
				validationError(
					"UNQUOTED_STRING_LITERAL",
					"question",
					`Question "${q.id}" in "${ctx.formName}" has ${desc} set to: ${bare} — this looks like a text value, not an XPath expression. If you meant the literal string "${bare}", wrap it in quotes: '${bare}'.`,
					{
						moduleIndex: ctx.moduleIndex,
						moduleName: ctx.moduleName,
						formIndex: ctx.formIndex,
						formName: ctx.formName,
						questionId: q.id,
						field,
					},
					{ bareWord: bare, field },
				),
			);
		}
	}
	return errors;
}

/**
 * Validation (`constraint` + `constraintMsg`) only makes sense on input
 * questions — the user must actually be able to enter a value and see an
 * error. Structural containers, display labels, and computed `hidden`
 * fields can't surface a validation error, so setting `validation` /
 * `validation_msg` on them is a category mistake. We flag either field
 * being set (even without its partner) so typos in the builder or the SA
 * produce a clear message instead of silently being dropped by the XForm
 * emitter.
 */
export function validationOnNonInputType(
	q: Question,
	ctx: QuestionContext,
): ValidationError[] {
	if (supportsValidation(q.type)) return [];
	if (!q.validation && !q.validation_msg) return [];
	const field = q.validation ? "validation" : "validation_msg";
	return [
		validationError(
			"VALIDATION_ON_NON_INPUT_TYPE",
			"question",
			`Question "${q.id}" (type "${q.type}") in "${ctx.formName}" has a ${field} set, but ${q.type} questions can't have validation. Only input questions (text, int, date, select, etc.) support constraint messages — structural containers, labels, and hidden/computed fields can't show an error to the user. Remove the ${field} field, or change the question type.`,
			{
				moduleIndex: ctx.moduleIndex,
				moduleName: ctx.moduleName,
				formIndex: ctx.formIndex,
				formName: ctx.formName,
				questionId: q.id,
				field,
			},
			{ field },
		),
	];
}

export function invalidQuestionId(
	q: Question,
	ctx: QuestionContext,
): ValidationError[] {
	if (!XML_ELEMENT_NAME_REGEX.test(q.id)) {
		return [
			validationError(
				"INVALID_QUESTION_ID",
				"question",
				`Question "${q.id}" in "${ctx.formName}" has an invalid ID. Question IDs become XML element names, so they must start with a letter or underscore and contain only letters, digits, or underscores. No spaces, hyphens, or special characters.`,
				{
					moduleIndex: ctx.moduleIndex,
					moduleName: ctx.moduleName,
					formIndex: ctx.formIndex,
					formName: ctx.formName,
					questionId: q.id,
				},
				{ questionId: q.id },
			),
		];
	}
	return [];
}

const QUESTION_RULES = [
	selectNoOptions,
	hiddenNoValue,
	unquotedStringLiteral,
	invalidQuestionId,
	validationOnNonInputType,
];

export function runQuestionRules(
	questions: Question[],
	ctx: QuestionContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const q of questions) {
		for (const rule of QUESTION_RULES) {
			errors.push(...rule(q, ctx));
		}
		if ((q.type === "group" || q.type === "repeat") && q.children) {
			errors.push(...runQuestionRules(q.children, ctx));
		}
	}
	return errors;
}
