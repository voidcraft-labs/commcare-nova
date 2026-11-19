/**
 * A condition of a basic case action read into an `Expression`, by the
 * inverse of `lib/domain/basicCaseSlots.ts::stateCondition`. HQ's three
 * operators are `xform.py::XForm.action_relevance`'s three templates: the
 * question alone (`boolean_true`), the question equal to one answer (`=`,
 * also the model's default), and a multi-select holding it (`selected`).
 * The reading is accepted only where `stateCondition` states it back.
 */
import type {
	Expression,
	PlacementIneligibilityReason,
	Uuid,
} from "@/lib/domain";
import { caseSlotFacts, stateCondition } from "@/lib/domain/basicCaseSlots";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { eq, formField, literal, term } from "@/lib/domain/expression/builders";
import { formExpressionFacts } from "@/lib/domain/expression/context";
import { type Claim, defineClaims, refuse } from "../claims";
import type { DraftForm } from "../context";
import { isJsonObject } from "../jsonCursor";
import type { DraftField } from "../xform";

const F = "forms-and-case-writes";

/** A stored `FormActionCondition`'s type, `never` where it holds none. */
export function conditionType(condition: unknown): unknown {
	return isJsonObject(condition) ? (condition.type ?? "never") : "never";
}

export const CONDITION_CLAIMS = defineClaims("caseManagement.conditions", {
	noQuestion: refuse(
		`${F}/update-path-naming-no-question-in-the-form-in-an-active-action`,
		"schema:ConditionalCaseUpdate.question_path",
	),
	ownNotOffered: refuse(
		`${F}/a-basic-form-s-own-case-s-close-or-open-condition-on-another`,
		"schema:FormActionCondition.question",
	),
	childNotOffered: refuse(
		`${F}/a-subcase-or-advanced-action-condition-on-a-question-the-picker`,
		"schema:FormActionCondition.question",
	),
	apostrophe: refuse(
		`${F}/an-open-close-child-case-or-advanced-action-condition-with`,
		"schema:FormActionCondition.answer",
	),
	notYesNo: refuse(
		`${F}/a-child-case-or-advanced-action-condition-boolean-true-on-a`,
		"schema:FormActionCondition.operator",
	),
});

export type ReadCondition =
	| { readonly kind: "always" }
	| { readonly kind: "never" }
	| { readonly kind: "if"; readonly expression: Expression }
	| { readonly kind: "finding"; readonly entry: string };

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The form's data path of `question`, relative to the data root, as
 *  `xform.py::XForm.resolve_path` resolves it; undefined for no path. */
export function conditionQuestionPath(
	form: DraftForm,
	question: string,
): string | undefined {
	const root = form.xform?.parsed.dataRoot.name;
	if (question.startsWith("/")) {
		const [empty, first, ...rest] = question.split("/");
		if (empty !== "" || first !== root || rest.length === 0) return undefined;
		return rest.join("/");
	}
	return question === "" ? undefined : question;
}

/** The question a stored condition names: the field of the form at its path. */
export function conditionField(
	form: DraftForm,
	condition: unknown,
): DraftField | undefined {
	if (!isObject(condition) || typeof condition.question !== "string")
		return undefined;
	const path = conditionQuestionPath(form, condition.question);
	const node = path === undefined ? undefined : form.xform?.nodes.get(path);
	const role = node === undefined ? undefined : form.xform?.roles.get(node);
	return role?.kind === "field" ? role.field : undefined;
}

/** The repeat a stored `repeat_context` names: the repeat at its path, or the
 *  repeat whose rows stand at it (a query repeat's `item`, the path HQ's
 *  build and Nova's emitter both write for a model-iteration repeat). */
export function repeatAtPath(
	form: DraftForm,
	path: string,
): DraftField | undefined {
	const relative = conditionQuestionPath(form, path);
	const node =
		relative === undefined ? undefined : form.xform?.nodes.get(relative);
	const role = node === undefined ? undefined : form.xform?.roles.get(node);
	if (role?.kind === "field") return role.field;
	if (role?.kind === "query-row") return role.repeat;
	return undefined;
}

/** The answer `V`: one of the question's inline choices where the question
 *  is a select that holds them, else the answer as a literal. */
function comparedTerm(field: DraftField, answer: string) {
	const source = field.field.optionsSource as
		| { kind: string; options?: { value: string; uuid?: Uuid }[] }
		| undefined;
	if (source?.kind === "inline") {
		const option = source.options?.find((one) => one.value === answer);
		if (option?.uuid !== undefined && field.uuid !== undefined)
			return {
				kind: "choice" as const,
				field: field.uuid,
				options: [option.uuid] as [Uuid],
			};
	}
	return literal(answer);
}

/**
 * The inverse of `basicCaseSlots.ts::stateCondition` for one
 * `FormActionCondition`, over the minted fields of `form`. A condition whose
 * question names no question of the form is the finding for that; one
 * `stateCondition` cannot state back is judged by `conditionFinding` once
 * the form's document exists.
 */
export function readActionCondition(
	condition: unknown,
	_scope: { readonly own: boolean; readonly repeat: Uuid | undefined },
	form: DraftForm,
): ReadCondition {
	if (!isObject(condition)) return { kind: "never" };
	const type = condition.type ?? "never";
	if (type === "never") return { kind: "never" };
	if (type === "always") return { kind: "always" };
	const field = conditionField(form, condition);
	if (field?.uuid === undefined)
		return { kind: "finding", entry: CONDITION_CLAIMS.noQuestion.entry };
	const question = term(formField(field.uuid));
	const operator = condition.operator ?? "=";
	const answer = typeof condition.answer === "string" ? condition.answer : "";
	if (operator === "boolean_true") return { kind: "if", expression: question };
	const value = comparedTerm(field, answer);
	if (operator === "selected")
		return {
			kind: "if",
			expression: {
				kind: "multi-select-contains",
				property: question,
				quantifier: "any",
				values: [value],
			},
		};
	return { kind: "if", expression: eq(question, term(value)) };
}

/** Which finding a refusal of `stateCondition` is, for the own case or for a
 *  child case: the first reason in the manifest's row order. */
export function conditionFinding(
	reasons: readonly PlacementIneligibilityReason[],
	own: boolean,
): Claim<"refuse"> | undefined {
	const offered: readonly PlacementIneligibilityReason[] = own
		? [
				"condition-question-kind",
				"condition-question-repeat",
				"condition-quote-boundary",
				"condition-not-a-choice",
			]
		: [
				"condition-question-kind",
				"condition-question-repeat",
				"condition-not-a-choice",
			];
	if (reasons.some((reason) => offered.includes(reason)))
		return own
			? CONDITION_CLAIMS.ownNotOffered
			: CONDITION_CLAIMS.childNotOffered;
	if (reasons.includes("condition-apostrophe"))
		return CONDITION_CLAIMS.apostrophe;
	return undefined;
}

/** The stored condition `stateCondition` states for `expression`, or why not. */
export function statedBack(
	doc: BlueprintDoc,
	formUuid: Uuid,
	expression: Expression | undefined,
	scope: { readonly own: boolean; readonly repeat: Uuid | undefined },
): ReturnType<typeof stateCondition> {
	return stateCondition(caseSlotFacts(doc, formUuid), expression, scope);
}

/**
 * The finding for a case change's condition (a child case's, or an advanced
 * action's) that reads one question alone where CommCare holds no yes or no
 * for it: HQ's `boolean_true` over a select, a label or a Hidden Value
 * calculated as text. Core reads such an answer as true wherever it is not
 * empty (`FunctionUtils.toBoolean`), `0` included, and Nova's record rules
 * take a read alone as a condition only where it holds a yes or no
 * (`lib/domain/expression/ruleSets.ts::recordPositionVerdict`), the fact the
 * gate reads (`formExpressionFacts`' held class). The form's own conditions
 * take Core's coercions and are never this finding.
 */
export function conditionNotYesNo(
	doc: BlueprintDoc,
	formUuid: Uuid,
	expression: Expression,
): Claim<"refuse"> | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "field")
		return undefined;
	const held = formExpressionFacts(doc, formUuid)?.fields.get(
		expression.term.uuid,
	)?.held;
	return held === "boolean" ? undefined : CONDITION_CLAIMS.notYesNo;
}
