/**
 * Field-level validation rules.
 *
 * Each rule inspects a single domain `Field` entity in its form context and
 * returns zero or more `ValidationError` objects. The runner walks the
 * form's rose tree (via `buildFieldTree`) and invokes every rule on every
 * node, recursing through container kinds.
 *
 * All rules operate on the domain shape — `field.kind`, `field.validate`,
 * `field.caseWrite` — never on derived CommCare mappings. The only wire tokens
 * appearing here are the `kind` string literals themselves, which match
 * CommCare's field-kind taxonomy and stay stable.
 */

import {
	isReservedXFormNodeName,
	RESERVED_XFORM_NODE_PREFIX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare";
import { detectUnquotedStringLiteral } from "@/lib/commcare/xpath";
import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";
import {
	expressionInspectionSource,
	fieldRegistry,
	mintSelectOptionPlaceholder,
	projectProseTemplate,
	proseTemplateText,
	repairSelectOptionValue,
	selectOptionValueProblem,
} from "@/lib/domain";
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
 * Read an XPath-bearing slot's TEXT off a Field union member — the
 * shared accessor projects AST-stored slots to their printed form and
 * passes string-stored slots through. Returns the text only when
 * non-empty, keeping the per-rule code free of manual type guards.
 */
function readXPath(
	field: Field,
	key: XPathFieldKey | "repeat_count" | "ids_query",
	ctx: FieldContext,
): string | undefined {
	const value = expressionInspectionSource(field, key, ctx.doc);
	return value !== undefined && value.length > 0 ? value : undefined;
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
	/** The whole doc — AST-stored expression slots print against it. */
	doc: BlueprintDoc;
}

// ── Rules ──────────────────────────────────────────────────────────

function selectNoOptions(field: Field, ctx: FieldContext): ValidationError[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	if (
		field.optionsSource.kind === "lookup" ||
		field.optionsSource.options.length > 0
	) {
		return [];
	}
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

/**
 * A select field with at least one but fewer than two options. `SELECT_NO_OPTIONS`
 * owns the zero-option case (the schema-backed empty state); this rule catches
 * the in-between state a granular `removeOption` can reach in place — the
 * reducer drops an option without re-parsing the field through `fieldSchema`'s
 * `.min(2)`, so the gate, not the schema, is the only layer that sees a select
 * collapse to a single choice.
 */
function selectTooFewOptions(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	if (field.optionsSource.kind === "lookup") return [];
	const count = field.optionsSource.options.length;
	if (count === 0 || count >= 2) return [];
	const typeName =
		field.kind === "single_select" ? "single-select" : "multi-select";
	return [
		validationError(
			"SELECT_TOO_FEW_OPTIONS",
			"field",
			`Field "${field.id}" in "${ctx.formName}" is a ${typeName} field with only one option. A choice field needs at least two options so there's something to choose between. Add another option, or remove the field if a single fixed value is all you need.`,
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

/**
 * A choice's stored VALUE is the answer token, and the wire cannot carry
 * one holding whitespace or a quote: CommCare Android throws on any select
 * value with a space, a multi-select answer is a space-joined token list,
 * and the case list compares the property with `field = 'value'`. An empty
 * value saves nothing, indistinguishable from "unanswered".
 * `lib/domain/selectOptionValue.ts` owns the grammar; this rule applies it
 * to inline options, with `CASE_PROPERTY_OPTION_VALUE_INVALID` (`app.ts`)
 * covering the catalog copy.
 */
function selectOptionValueInvalid(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return [];
	if (field.optionsSource.kind === "lookup") return [];
	const errors: ValidationError[] = [];
	const options = field.optionsSource.options;
	options.forEach((option, index) => {
		const problem = selectOptionValueProblem(option.value);
		if (problem === undefined) return;
		// Two readings of the label: the projection (references resolved to
		// their current names) is what a person sees and so what the message
		// shows; the plain text is the slug input, since a reference has no
		// words worth minting a value from.
		const shownLabel = projectProseTemplate(option.label, ctx.doc).text.trim();
		const position = `Option ${index + 1}${shownLabel ? ` ("${shownLabel}")` : ""} of field "${field.id}" in "${ctx.formName}"`;
		const suggestion = repairSelectOptionValue(
			option.value,
			proseTemplateText(option.label),
			mintSelectOptionPlaceholder(index + 1).value,
			new Set(options.filter((other) => other !== option).map((o) => o.value)),
		);
		const message =
			problem === "empty"
				? `${position} has an empty value. A choice's value is the answer the app stores, so an empty one saves nothing and reads as unanswered. Give it a value such as "${suggestion}": a lowercase slug with words joined by underscores, with the wording kept in the label.`
				: problem === "whitespace"
					? `${position} has the value ${JSON.stringify(option.value)}, which contains a space. A choice's value is the answer the app stores, not the wording, and the device refuses a choice value holding a space (a multi-select answer is a space-separated list of these values). Use "${suggestion}" instead: a lowercase slug with words joined by underscores, with the wording kept in the label.`
					: `${position} has the value ${JSON.stringify(option.value)}, which contains a quote mark. A choice's value is the answer the app stores, and the app compares it inside quotes, so a quote or apostrophe in it breaks that comparison. Use "${suggestion}" instead: a lowercase slug with words joined by underscores, with the wording kept in the label.`;
		errors.push(
			validationError(
				"SELECT_OPTION_VALUE_INVALID",
				"field",
				message,
				{
					moduleUuid: ctx.moduleUuid,
					moduleName: ctx.moduleName,
					formUuid: ctx.formUuid,
					formName: ctx.formName,
					fieldUuid: field.uuid,
					fieldId: field.id,
				},
				{
					optionUuid: option.uuid,
					optionValue: option.value,
					problem,
					suggestedValue: suggestion,
				},
			),
		);
	});
	return errors;
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

/**
 * `required` makes no sense on a hidden field. The field is never shown, so
 * the user can't fill it — if its computed / default value ever resolves
 * empty while marked required, the form blocks submission with no visible
 * input to remedy. CommCare's authoring model forbids it outright: Vellum's
 * DataBindOnly (the Hidden Value type) sets `requiredAttr: notallowed`. The
 * field schema already drops `required` from `hidden`; this rule is the
 * backstop for a value that reaches the doc through a lenient path, so the
 * mistake surfaces as a clear message instead of a silently-dropped bind.
 */
function requiredOnHidden(field: Field, ctx: FieldContext): ValidationError[] {
	if (field.kind !== "hidden") return [];
	const required = readXPath(field, "required", ctx);
	if (!required) return [];
	return [
		validationError(
			"REQUIRED_ON_HIDDEN",
			"field",
			`Field "${field.id}" in "${ctx.formName}" is a hidden field with \`required\` set, but a hidden field is never shown to the user. If its value ever comes out empty the form can't be submitted and there's no input on screen to fix it. Hidden fields can't be required. Clear \`required\`; if someone really must answer this, make it a visible field (change its kind).`,
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

/**
 * `calculate` belongs ONLY on a hidden field. On a visible input it's the
 * read-only-but-looks-editable footgun: the control still renders, but its
 * value is silently overwritten by the recompute, so the user types into a
 * field that ignores them. CommCare's authoring model agrees — Vellum shows
 * the calculate widget only on hidden nodes (`calculateAttr: visible_if_present`,
 * "highly discouraged" on data inputs). The sibling of `requiredOnHidden`:
 * the field schema drops `calculate` from every visible kind, and this rule
 * backstops a value that reaches the doc through a lenient path with a clear
 * message rather than a silently-mishandled bind.
 */
function calculateOnVisibleInput(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	if (field.kind === "hidden") return [];
	const calculate = readXPath(field, "calculate", ctx);
	if (!calculate) return [];
	return [
		validationError(
			"CALCULATE_ON_VISIBLE_INPUT",
			"field",
			`Field "${field.id}" (kind "${field.kind}") in "${ctx.formName}" has a \`calculate\` set, but only a hidden field can carry one. On a visible field a \`calculate\` makes it read-only, the user sees an editable control whose value is silently replaced by the computed result, so their input is ignored. Move the computed value to a hidden field and reference it, or clear \`calculate\` to let the user enter the value.`,
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
		const value = readXPath(field, key, ctx);
		if (!value) continue;
		const bare = detectUnquotedStringLiteral(value);
		if (!bare) continue;
		const desc = FIELD_DESCRIPTIONS[key];
		errors.push(
			validationError(
				"UNQUOTED_STRING_LITERAL",
				"field",
				`Field "${field.id}" in "${ctx.formName}" has ${desc} set to: ${bare}, this looks like a text value, not an XPath expression. If you meant the literal string "${bare}", wrap it in quotes: '${bare}'.`,
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
	const validateExpr = readXPath(field, "validate", ctx);
	const validateMsg = (field as unknown as Record<string, unknown>)
		.validate_msg;
	if (!validateExpr && !validateMsg) return [];
	const reported = validateExpr ? "validate" : "validate_msg";
	return [
		validationError(
			"VALIDATION_ON_NON_INPUT_KIND",
			"field",
			`Field "${field.id}" (kind "${field.kind}") in "${ctx.formName}" has \`${reported}\` set, but ${field.kind} fields can't have validation. Only input kinds (text, int, date, select, etc.) support constraint messages. Structural containers, labels, and hidden/computed fields can't show an error to the user. Clear \`${reported}\`, or change the field's kind.`,
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
		const expr = readXPath(field, "repeat_count", ctx);
		if (expr === undefined || expr.trim().length === 0) {
			errors.push(
				validationError(
					"EMPTY_REPEAT_COUNT",
					"field",
					`Field "${field.id}" in "${ctx.formName}" is a count-bound repeat but has no \`repeat_count\` expression. Set it to an XPath that resolves to the number of iterations, a hashtag reference like \`#form/desired_count\` for a user-supplied count, or a literal like \`5\` for a fixed count.`,
					{ ...loc, field: "repeat_count" },
					{ field: "repeat_count" },
				),
			);
		}
	} else if (field.repeat_mode === "query_bound") {
		const expr = readXPath(field, "ids_query", ctx);
		if (expr === undefined || expr.trim().length === 0) {
			errors.push(
				validationError(
					"EMPTY_IDS_QUERY",
					"field",
					`Field "${field.id}" in "${ctx.formName}" is a query-bound repeat but has no \`data_source.ids_query\` expression. Set it to an XPath that resolves to a list of case ids the runtime should iterate over. Typically a casedb filter like \`instance('casedb')/casedb/case[@case_type='visit'][@status='open']/@case_id\`.`,
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
			`Field "${field.id}" in "${ctx.formName}" starts with "${RESERVED_XFORM_NODE_PREFIX}", which is reserved for nodes Nova generates behind the scenes (for example the hidden counter a fixed-count repeat needs). Pick an id that doesn't start with "${RESERVED_XFORM_NODE_PREFIX}". Anything else, like dropping the leading "${RESERVED_XFORM_NODE_PREFIX}", works.`,
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
	selectTooFewOptions,
	selectOptionValueInvalid,
	hiddenNoValue,
	requiredOnHidden,
	calculateOnVisibleInput,
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
	ctx: Omit<FieldContext, "doc">,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const fullCtx: FieldContext = { ...ctx, doc };
	const tree = buildFieldTree(formUuid, doc.fields, doc.fieldOrder);
	const walk = (nodes: typeof tree): void => {
		for (const node of nodes) {
			for (const rule of FIELD_RULES) {
				errors.push(...rule(node.field, fullCtx));
			}
			if (node.children) walk(node.children);
		}
	};
	walk(tree);
	return errors;
}
