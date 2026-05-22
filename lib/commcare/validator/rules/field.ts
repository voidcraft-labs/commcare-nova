/**
 * Field-level validation rules.
 *
 * Each rule inspects a single domain `Field` entity in its form context and
 * returns zero or more `ValidationError` objects. The runner walks the
 * form's rose tree (via `buildFieldTree`) and invokes every rule on every
 * node, recursing through container kinds.
 *
 * All rules operate on the domain shape — `field.kind`, `field.validate`,
 * `field.case_property_on` — never on the legacy wire shape. The only wire
 * tokens appearing here are the `kind` string literals themselves, which
 * match CommCare's field-kind taxonomy and stay stable.
 */

import {
	isReservedXFormNodeName,
	RESERVED_XFORM_NODE_PREFIX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare";
import { detectUnquotedStringLiteral } from "@/lib/commcare/xpath";
import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";
import { fieldRegistry } from "@/lib/domain";
import { buildFieldTree } from "@/lib/preview/engine/fieldTree";
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
interface FieldContext {
	formName: string;
	moduleName: string;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

// ── Rules ──────────────────────────────────────────────────────────

function selectNoOptions(field: Field, ctx: FieldContext): ValidationError[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	if (field.options && field.options.length > 0) return [];
	const typeName =
		field.kind === "single_select" ? "single-select" : "multi-select";
	return [
		validationError(
			"SELECT_NO_OPTIONS",
			"field",
			`Field "${field.id}" in "${ctx.formName}" is a ${typeName} field but has no options to choose from. Add at least one option with a value and label.`,
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

function hiddenNoValue(field: Field, ctx: FieldContext): ValidationError[] {
	if (field.kind !== "hidden") return [];
	if (field.calculate || field.default_value) return [];
	return [
		validationError(
			"HIDDEN_NO_VALUE",
			"field",
			`Field "${field.id}" in "${ctx.formName}" is a hidden field but has no calculate expression or default_value. Hidden fields are invisible to users, so without a computed or default value they'll always be blank. Add a calculate expression or a default_value.`,
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

function unquotedStringLiteral(
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
				"field",
				`Field "${field.id}" in "${ctx.formName}" has ${desc} set to: ${bare} — this looks like a text value, not an XPath expression. If you meant the literal string "${bare}", wrap it in quotes: '${bare}'.`,
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
 * instead of being silently dropped by the XForm emitter.
 */
function validationOnNonInputType(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (supportsValidation(field.kind)) return [];
	const validateExpr = readString(field, "validate");
	const validateMsg = readString(field, "validate_msg");
	if (!validateExpr && !validateMsg) return [];
	const reported = validateExpr ? "validate" : "validate_msg";
	return [
		validationError(
			"VALIDATION_ON_NON_INPUT_KIND",
			"field",
			`Field "${field.id}" (kind "${field.kind}") in "${ctx.formName}" has \`${reported}\` set, but ${field.kind} fields can't have validation. Only input kinds (text, int, date, select, etc.) support constraint messages — structural containers, labels, and hidden/computed fields can't show an error to the user. Clear \`${reported}\`, or change the field's kind.`,
			{
				moduleUuid: ctx.moduleUuid,
				moduleName: ctx.moduleName,
				formUuid: ctx.formUuid,
				formName: ctx.formName,
				fieldUuid: field.uuid,
				fieldId: field.id,
				field: reported,
			},
			{ field: reported },
		),
	];
}

/**
 * Repeat fields in `count_bound` and `query_bound` modes carry an XPath
 * expression that the wire emitter writes into a JavaRosa-parsed
 * attribute (`jr:count` and the `<setvalue value="join(' ', …)">` pair
 * respectively). JavaRosa's XPath parser rejects empty input outright —
 * an empty `jr:count=""` produces "Bad node:
 * org.javarosa.xpath.parser.ast.ASTNodeAbstractExpr", and a malformed
 * `join(' ', )` setvalue is a syntax error. The wire emitter writes
 * these unconditionally, so the only place to catch the configuration
 * error is here.
 *
 * `user_controlled` repeats have no XPath field — the runtime adds
 * iterations via UI — so they're skipped.
 */
function emptyRepeatXPath(field: Field, ctx: FieldContext): ValidationError[] {
	if (field.kind !== "repeat") return [];
	const errors: ValidationError[] = [];
	const loc = {
		moduleUuid: ctx.moduleUuid,
		moduleName: ctx.moduleName,
		formUuid: ctx.formUuid,
		formName: ctx.formName,
		fieldUuid: field.uuid,
		fieldId: field.id,
	};

	if (field.repeat_mode === "count_bound") {
		const expr = field.repeat_count;
		if (typeof expr !== "string" || expr.trim().length === 0) {
			errors.push(
				validationError(
					"EMPTY_REPEAT_COUNT",
					"field",
					`Field "${field.id}" in "${ctx.formName}" is a count-bound repeat but has no \`repeat_count\` expression. Set it to an XPath that resolves to the number of iterations — a hashtag reference like \`#form/desired_count\` for a user-supplied count, or a literal like \`5\` for a fixed count. CommCare HQ rejects builds whose \`jr:count\` attribute parses to an empty XPath, so leaving this blank breaks the upload.`,
					{ ...loc, field: "repeat_count" },
					{ field: "repeat_count" },
				),
			);
		}
	} else if (field.repeat_mode === "query_bound") {
		const expr = field.data_source?.ids_query;
		if (typeof expr !== "string" || expr.trim().length === 0) {
			errors.push(
				validationError(
					"EMPTY_IDS_QUERY",
					"field",
					`Field "${field.id}" in "${ctx.formName}" is a query-bound repeat but has no \`data_source.ids_query\` expression. Set it to an XPath that resolves to a list of case ids the runtime should iterate over — typically a casedb filter like \`instance('casedb')/casedb/case[@case_type='visit'][@status='open']/@case_id\`. CommCare HQ rejects builds with malformed setvalue expressions, so leaving this blank breaks the upload.`,
					{ ...loc, field: "ids_query" },
					{ field: "ids_query" },
				),
			);
		}
	}
	return errors;
}

function invalidFieldId(field: Field, ctx: FieldContext): ValidationError[] {
	if (XML_ELEMENT_NAME_REGEX.test(field.id)) return [];
	return [
		validationError(
			"INVALID_FIELD_ID",
			"field",
			`Field "${field.id}" in "${ctx.formName}" has an invalid ID. Field IDs become XML element names, so they must start with a letter or underscore and contain only letters, digits, or underscores. No spaces, hyphens, or special characters.`,
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

/**
 * The XForm emitter SYNTHESIZES some data nodes under a reserved
 * `__nova_` prefix — currently the hidden node a hoisted `count_bound`
 * repeat's `jr:count` points at (the count is a literal/expression JavaRosa
 * won't accept directly; see `lib/commcare/xform/builder.ts` count_bound arm
 * + `lib/commcare/xform/countReference.ts`). The synthetic node lives at
 * `/data/__nova_count_<fieldId>`. If an author created a field whose id
 * fell under that prefix, the two `<...>` data nodes would collide and the
 * authored field could silently overwrite a sibling repeat's cardinality
 * source. `__nova_` is a legal XML element name, so `invalidFieldId` can't
 * catch this — the reservation is Nova-domain, enforced here. We prefix-
 * match (not equality) because the synthesized name embeds the field id, so
 * the whole namespace must be off-limits.
 */
function reservedFieldIdPrefix(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (!isReservedXFormNodeName(field.id)) return [];
	return [
		validationError(
			"RESERVED_FIELD_ID_PREFIX",
			"field",
			`Field "${field.id}" in "${ctx.formName}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved for nodes CommCare-Nova generates behind the scenes (for example the hidden counter a fixed-count repeat needs). Pick an id that doesn't start with "${RESERVED_XFORM_NODE_PREFIX}" — anything else, like dropping the leading "${RESERVED_XFORM_NODE_PREFIX}", works.`,
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
	invalidFieldId,
	reservedFieldIdPrefix,
	validationOnNonInputType,
	emptyRepeatXPath,
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
