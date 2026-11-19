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
import type { DraftForm, ReadContext } from "../context";
import { isJsonObject, pointerToken } from "../jsonCursor";
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

/** The keys of a case action that hold a `FormActionCondition`, basic and advanced. */
const CONDITION_KEYS = new Set([
	"condition",
	"close_condition",
	"open_condition",
]);

/** The keys of a case action a stored null of which Nova writes as a new action holds them. */
const NULL_RESPELLED = new Set(["name_update", "product_program"]);

/** A basic form's `PreloadAction`s, each of which Nova writes with its condition `never`
 *  (`hqShells.ts::emptyFormActions`). */
const PRELOAD_ACTIONS = ["case_preload", "usercase_preload", "load_from_form"];

/** The entry a preload action's condition stands under: no build reads it
 *  (`models/form_actions.py::PreloadAction.is_active` reads the preload alone). */
const PRELOAD_CONDITION_ENTRY = `${F}/preload-action-condition`;

/**
 * Records under `case-settings-respelled` each stored condition spelling of a
 * form's `actions` that the first publish writes another way with nothing a
 * build reads changed:
 *
 * - an `operator` stored null, which HQ's Case Management pages write on every
 *   condition that is not `if` (`forms/case_config_ui.js::cleanCondition`,
 *   `advanced/actions.js::actionBase.clean_condition`) and which
 *   `xform.py::XForm.action_relevance` reads as `=`. Nova writes `=`, the value
 *   a form HQ creates holds (`models/form_actions.py::FormActionCondition.operator`),
 *   or the operator `stateCondition` states for an `if`, and a source read
 *   serves no null for a condition Nova leaves out;
 * - a preload action's condition stored other than `never` (the Case
 *   Management page saves `case_preload` as `always` with or without a preload),
 *   which Nova writes as `never`, recorded at the condition whole;
 * - a value of an action stored null where Nova writes the value a new action
 *   holds, which every reader reads alike: a `name_update` (Nova writes a
 *   `ConditionalCaseUpdate`, `casePlacementPlan.ts::planFormCaseWire`, whose
 *   `question_path` HQ reads only where the action opens a case,
 *   `xform.py::XFormCaseBlock.add_create_block`), an advanced action's
 *   `product_program` (Nova writes `""`, which
 *   `suite_xml/sections/entries.py::EntriesHelper` reads as it reads null, by
 *   its truth) and its `case_index`'s `tag` (Nova writes `""`, which
 *   `models/form_actions.py::LoadUpdateAction.case_indices` reads as it reads
 *   null, by its truth), each recorded at its key.
 *
 * `actions` is the stored value at `pointer`; `entry` is the entry the form's
 * actions are claimed under.
 */
export function recordRespelledConditions(
	ctx: ReadContext,
	actions: unknown,
	pointer: string,
	entry: string,
): void {
	if (!isObject(actions)) return;
	const whole = new Set<string>();
	for (const key of PRELOAD_ACTIONS) {
		const action = actions[key];
		if (!isObject(action) || !isObject(action.condition)) continue;
		if (conditionType(action.condition) === "never") continue;
		const at = `${pointer}/${key}/condition`;
		whole.add(at);
		ctx.facts.sameStateRewrites.push({
			entry: PRELOAD_CONDITION_ENTRY,
			path: at,
			register: "case-settings-respelled",
		});
	}
	const visit = (value: unknown, at: string): void => {
		if (Array.isArray(value)) {
			value.forEach((inner, index) => {
				visit(inner, `${at}/${index}`);
			});
			return;
		}
		if (!isObject(value)) return;
		for (const [key, inner] of Object.entries(value)) {
			const child = `${at}/${pointerToken(key)}`;
			const respelled =
				inner === null && NULL_RESPELLED.has(key)
					? child
					: key === "case_index" && isObject(inner) && inner.tag === null
						? `${child}/tag`
						: undefined;
			if (respelled !== undefined)
				ctx.facts.sameStateRewrites.push({
					entry,
					path: respelled,
					register: "case-settings-respelled",
				});
			if (!CONDITION_KEYS.has(key) || !isObject(inner)) {
				visit(inner, child);
				continue;
			}
			if (whole.has(child) || !("operator" in inner) || inner.operator !== null)
				continue;
			ctx.facts.sameStateRewrites.push({
				entry,
				path: `${child}/operator`,
				register: "case-settings-respelled",
			});
		}
	};
	visit(actions, pointer);
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
