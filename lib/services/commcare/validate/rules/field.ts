/**
 * Field-level validation rules.
 *
 * Each rule inspects a single domain `Field` entity in its form context and
 * returns zero or more `ValidationError` objects. The runner walks the
 * form's rose tree (via `buildFieldTree`) and invokes every rule on every
 * node, recursing through container kinds.
 *
 * All rules operate on the domain shape — `field.kind`, `field.validate`,
 * `field.case_property` — never on the legacy wire shape. The only wire
 * tokens appearing here are the `kind` string literals themselves, which
 * match CommCare's question-type taxonomy and stay stable.
 */

import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";
import { fieldRegistry } from "@/lib/domain";
import { buildFieldTree } from "@/lib/preview/engine/fieldTree";
import { detectUnquotedStringLiteral } from "../../../hqJsonExpander";
import { XML_ELEMENT_NAME_REGEX } from "../../constants";
import { type ValidationError, validationError } from "../errors";

/**
 * Keys on a Field that carry XPath expressions. We read via a helper that
 * tolerates missing keys on variants that don't declare them (e.g. `label`
 * has no `validate`), so the list is a superset of any one variant's
 * property set.
 */
const XPATH_FIELDS = [
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"required",
] as const;

type XPathFieldKey = (typeof XPATH_FIELDS)[number];

/** Map a field key to its human-facing description used in error messages. */
const FIELD_DESCRIPTIONS: Record<XPathFieldKey, string> = {
	relevant: "display condition (relevant)",
	validate: "validation rule",
	calculate: "calculated value",
	default_value: "default value",
	required: "required condition",
};

/**
 * Read an XPath-bearing property off a Field union member. Returns the
 * value only when it is a non-empty string, otherwise `undefined` — keeps
 * the per-rule code free of manual type guards.
 */
function readXPath(field: Field, key: XPathFieldKey): string | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a generic optional string property off a Field variant that may or
 * may not declare it (e.g. `validate_msg` exists on input kinds but not on
 * structural containers).
 */
function readString(field: Field, key: string): string | undefined {
	const value = (field as unknown as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * A field kind supports validation (constraint + constraint message) if the
 * user can actually see the error. Structural containers (group, repeat),
 * display-only labels, and computed hidden fields cannot — setting
 * `validate` / `validate_msg` on them is a category mistake. Derived from
 * the registry metadata so adding a new kind doesn't require touching this
 * check.
 */
const KINDS_SUPPORTING_VALIDATION: ReadonlySet<FieldKind> = (() => {
	const kinds = new Set<FieldKind>();
	for (const kind of Object.keys(fieldRegistry) as FieldKind[]) {
		const meta = fieldRegistry[kind];
		if (meta.isStructural) continue;
		if (kind === "hidden") continue;
		kinds.add(kind);
	}
	return kinds;
})();

function supportsValidation(kind: FieldKind): boolean {
	return KINDS_SUPPORTING_VALIDATION.has(kind);
}

/** Context passed to each per-field rule so errors carry full provenance. */
export interface FieldContext {
	formName: string;
	moduleName: string;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

// ── Rules ──────────────────────────────────────────────────────────

export function selectNoOptions(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	if (field.options && field.options.length > 0) return [];
	const typeName =
		field.kind === "single_select" ? "single-select" : "multi-select";
	return [
		validationError(
			"SELECT_NO_OPTIONS",
			"question",
			`Question "${field.id}" in "${ctx.formName}" is a ${typeName} question but has no options to choose from. Add at least one option with a value and label.`,
			{
				moduleUuid: ctx.moduleUuid,
				moduleName: ctx.moduleName,
				formUuid: ctx.formUuid,
				formName: ctx.formName,
				fieldUuid: field.uuid,
				fieldId: field.id,
			},
		),
	];
}

export function hiddenNoValue(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (field.kind !== "hidden") return [];
	if (field.calculate || field.default_value) return [];
	return [
		validationError(
			"HIDDEN_NO_VALUE",
			"question",
			`Question "${field.id}" in "${ctx.formName}" is a hidden field but has no calculate expression or default_value. Hidden fields are invisible to users, so without a computed or default value they'll always be blank. Add a calculate expression or a default_value.`,
			{
				moduleUuid: ctx.moduleUuid,
				moduleName: ctx.moduleName,
				formUuid: ctx.formUuid,
				formName: ctx.formName,
				fieldUuid: field.uuid,
				fieldId: field.id,
			},
		),
	];
}

export function unquotedStringLiteral(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const key of XPATH_FIELDS) {
		const value = readXPath(field, key);
		if (!value) continue;
		const bare = detectUnquotedStringLiteral(value);
		if (!bare) continue;
		const desc = FIELD_DESCRIPTIONS[key];
		errors.push(
			validationError(
				"UNQUOTED_STRING_LITERAL",
				"question",
				`Question "${field.id}" in "${ctx.formName}" has ${desc} set to: ${bare} — this looks like a text value, not an XPath expression. If you meant the literal string "${bare}", wrap it in quotes: '${bare}'.`,
				{
					moduleUuid: ctx.moduleUuid,
					moduleName: ctx.moduleName,
					formUuid: ctx.formUuid,
					formName: ctx.formName,
					fieldUuid: field.uuid,
					fieldId: field.id,
					field: key,
				},
				{ bareWord: bare, field: key },
			),
		);
	}
	return errors;
}

/**
 * Validation (`validate` + `validate_msg`) only makes sense on input
 * fields — the user must enter a value AND see an error. We flag either
 * key being set on a non-input kind so typos produce a clear message
 * instead of being silently dropped by the XForm emitter. The reported
 * field name in the error message preserves the wire-facing naming
 * ("validation" / "validation_msg") since that is what the user sees in
 * tools and docs.
 */
export function validationOnNonInputType(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (supportsValidation(field.kind)) return [];
	const validateExpr = readString(field, "validate");
	const validateMsg = readString(field, "validate_msg");
	if (!validateExpr && !validateMsg) return [];
	const reported = validateExpr ? "validation" : "validation_msg";
	const internal = validateExpr ? "validate" : "validate_msg";
	return [
		validationError(
			"VALIDATION_ON_NON_INPUT_TYPE",
			"question",
			`Question "${field.id}" (type "${field.kind}") in "${ctx.formName}" has a ${reported} set, but ${field.kind} questions can't have validation. Only input questions (text, int, date, select, etc.) support constraint messages — structural containers, labels, and hidden/computed fields can't show an error to the user. Remove the ${reported} field, or change the question type.`,
			{
				moduleUuid: ctx.moduleUuid,
				moduleName: ctx.moduleName,
				formUuid: ctx.formUuid,
				formName: ctx.formName,
				fieldUuid: field.uuid,
				fieldId: field.id,
				field: internal,
			},
			{ field: internal },
		),
	];
}

export function invalidQuestionId(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (XML_ELEMENT_NAME_REGEX.test(field.id)) return [];
	return [
		validationError(
			"INVALID_QUESTION_ID",
			"question",
			`Question "${field.id}" in "${ctx.formName}" has an invalid ID. Question IDs become XML element names, so they must start with a letter or underscore and contain only letters, digits, or underscores. No spaces, hyphens, or special characters.`,
			{
				moduleUuid: ctx.moduleUuid,
				moduleName: ctx.moduleName,
				formUuid: ctx.formUuid,
				formName: ctx.formName,
				fieldUuid: field.uuid,
				fieldId: field.id,
			},
			{ fieldUuid: field.uuid },
		),
	];
}

const FIELD_RULES = [
	selectNoOptions,
	hiddenNoValue,
	unquotedStringLiteral,
	invalidQuestionId,
	validationOnNonInputType,
];

/**
 * Run every field-level rule on every field under `formUuid`, recursing
 * through container fields. Uses `buildFieldTree` so the structure walked
 * matches the engine's canonical traversal shape.
 */
export function runFieldRules(
	doc: BlueprintDoc,
	formUuid: Uuid,
	ctx: FieldContext,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
	const walk = (nodes: typeof tree): void => {
		for (const node of nodes) {
			for (const rule of FIELD_RULES) {
				errors.push(...rule(node.field, ctx));
			}
			if (node.children) walk(node.children);
		}
	};
	walk(tree);
	return errors;
}
