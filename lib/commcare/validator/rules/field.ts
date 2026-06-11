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
import { detectUnquotedStringLiteral, parser } from "@/lib/commcare/xpath";
import type { BlueprintDoc, Field, FieldKind, Uuid } from "@/lib/domain";
import { expressionSource, fieldRegistry } from "@/lib/domain";
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
	const value = expressionSource(field, key, ctx.doc);
	return value !== undefined && value.length > 0 ? value : undefined;
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
	/** The whole doc — AST-stored expression slots print against it. */
	doc: BlueprintDoc;
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
			`Field "${field.id}" in "${ctx.formName}" is a hidden field with \`required\` set, but a hidden field is never shown to the user — if its value ever comes out empty the form can't be submitted and there's no input on screen to fix it. Hidden fields can't be required. Clear \`required\`; if someone really must answer this, make it a visible field (change its kind).`,
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
			`Field "${field.id}" (kind "${field.kind}") in "${ctx.formName}" has a \`calculate\` set, but only a hidden field can carry one. On a visible field a \`calculate\` makes it read-only — the user sees an editable control whose value is silently replaced by the computed result, so their input is ignored. Move the computed value to a hidden field and reference it, or clear \`calculate\` to let the user enter the value.`,
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
	const validateExpr = readXPath(field, "validate", ctx);
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
		const expr = readXPath(field, "repeat_count", ctx);
		if (expr === undefined || expr.trim().length === 0) {
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
		const expr = readXPath(field, "ids_query", ctx);
		if (expr === undefined || expr.trim().length === 0) {
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

/**
 * The closed set of `instance('<id>')` ids Nova's XForm-level emitter
 * declares as `<model><instance>` elements. A field's XPath surface
 * (`relevant` / `validate` / `calculate` / `default_value` /
 * `required`) is evaluated by JavaRosa against the FORM's instance
 * declarations only — any reference outside this set has no matching
 * `<instance>` on the wire and resolves to nothing at form-init,
 * surfaced on device as "A part of your application is invalid."
 *
 * Source: `lib/commcare/xform/builder.ts::InstanceTracker::toElements`
 * is the single emitter of `<model><instance>` for XForms; it emits
 * `casedb` and/or `commcaresession` and nothing else. Suite-XML-side
 * instances (`results`, `results:inline`, `search-input:results` —
 * declared per-`<remote-request>` block on the suite) are
 * deliberately EXCLUDED from this allowlist: they are not visible to
 * a form's XPath, so referencing them from a field surface is exactly
 * the false-negative this rule must catch.
 *
 * If Nova adds support for a new fixture (lookup tables, saved
 * reports, etc.), the `InstanceTracker` gains a corresponding
 * `<instance>` emission and this set extends in lockstep.
 */
const MODELED_INSTANCE_IDS: ReadonlySet<string> = new Set([
	"casedb",
	"commcaresession",
]);

/** Pre-resolved Lezer node types for the `instance(...)` scan. */
const INSTANCE_NODE_TYPES = (() => {
	const all = parser.nodeSet.types;
	const one = (name: string) => {
		const found = all.find((t) => t.name === name);
		if (!found) throw new Error(`Missing parser node type: ${name}`);
		return found;
	};
	return {
		Invoke: one("Invoke"),
		FunctionName: one("FunctionName"),
		ArgumentList: one("ArgumentList"),
		StringLiteral: one("StringLiteral"),
	};
})();

/**
 * Strip surrounding quotes from an XPath string literal and collapse
 * the doubled-quote escape (XPath 1.0 has no backslash escape; the only
 * way to embed the same quote is to double it).
 */
function unquoteXPathStringLiteral(literal: string): string {
	if (literal.length < 2) return literal;
	const quote = literal[0];
	const inner = literal.slice(1, -1);
	return inner.split(`${quote}${quote}`).join(quote);
}

/**
 * Walk `expr` (an XPath expression) and return every `instance('<id>')`
 * id whose `<id>` is NOT in `MODELED_INSTANCE_IDS`. Each return value
 * is the raw quoted id text the user authored, suitable for quoting
 * back to them in an error message.
 */
function findUnmodeledInstanceIds(expr: string): string[] {
	if (!expr) return [];
	const out: string[] = [];
	const tree = parser.parse(expr);
	tree.iterate({
		enter(node) {
			if (node.type !== INSTANCE_NODE_TYPES.Invoke) return;
			const fnName = node.node.firstChild;
			if (!fnName) return;
			if (fnName.type !== INSTANCE_NODE_TYPES.FunctionName) return;
			if (expr.slice(fnName.from, fnName.to) !== "instance") return;
			const argList = fnName.nextSibling;
			if (!argList || argList.type !== INSTANCE_NODE_TYPES.ArgumentList) return;
			for (
				let child = argList.firstChild;
				child !== null;
				child = child.nextSibling
			) {
				if (child.type !== INSTANCE_NODE_TYPES.StringLiteral) continue;
				const id = unquoteXPathStringLiteral(expr.slice(child.from, child.to));
				if (!MODELED_INSTANCE_IDS.has(id)) {
					out.push(id);
				}
				break;
			}
		},
	});
	return out;
}

/**
 * Reject fields whose XPath surfaces reference an `instance('<id>')`
 * that Nova doesn't model. The wire layer only declares `<instance>`
 * elements for the closed set in `MODELED_INSTANCE_IDS` — a reference
 * to anything else (`item-list:foo`, `commcare:reports`,
 * `commcare-reports:bar`, custom fixtures) compiles to a form whose
 * `instance('...')` call resolves to nothing at form-init, surfaced on
 * device as "A part of your application is invalid."
 *
 * The fix tells the user the canonical alternative for each common
 * fixture: lookup tables → reshape into a select-question option list;
 * saved reports / UCR reports → not supported at all.
 */
function fixtureReferenceNotModeled(
	field: Field,
	ctx: FieldContext,
): ValidationError[] {
	const errors: ValidationError[] = [];

	/** Emit one error per offending instance id on a single XPath surface. */
	const flag = (surfaceDescription: string, expr: string | undefined) => {
		if (!expr) return;
		for (const id of findUnmodeledInstanceIds(expr)) {
			errors.push(
				validationError(
					"FIXTURE_REFERENCE_NOT_MODELED",
					"field",
					`Field "${field.id}" in "${ctx.formName}" references the fixture instance "${id}" in its ${surfaceDescription}. Nova doesn't model that fixture — the emitted form would have no <instance> declaration for "${id}" and would fail at form-init with "A part of your application is invalid." Today Nova supports casedb (case data via "#case/...") and commcaresession (user/session data via "#user/..." or direct refs). For lookup-table data, reshape the data into the form as select options. Saved reports and UCR reports aren't supported.`,
					{
						moduleUuid: ctx.moduleUuid,
						moduleName: ctx.moduleName,
						formUuid: ctx.formUuid,
						formName: ctx.formName,
						fieldUuid: field.uuid,
						fieldId: field.id,
					},
					{ fixtureId: id },
				),
			);
		}
	};

	for (const key of XPATH_FIELDS) {
		flag(FIELD_DESCRIPTIONS[key], readXPath(field, key, ctx));
	}

	// Repeat-cardinality XPath surfaces — both flow through the wire-emit
	// hashtag expander and accumulate instance refs the same way the
	// expression surfaces above do. Without screening them here, an
	// `instance('item-list:foo')` in `repeat_count` or
	// `data_source.ids_query` would slip past the authoring gate and
	// produce a form whose `<instance>` block lacks the matching
	// declaration, surfaced on device as "A part of your application is
	// invalid."
	if (field.kind === "repeat") {
		if (field.repeat_mode === "count_bound") {
			flag("repeat count expression", readXPath(field, "repeat_count", ctx));
		} else if (field.repeat_mode === "query_bound") {
			flag("repeat ids-query expression", readXPath(field, "ids_query", ctx));
		}
	}

	return errors;
}

const FIELD_RULES = [
	selectNoOptions,
	hiddenNoValue,
	requiredOnHidden,
	calculateOnVisibleInput,
	unquotedStringLiteral,
	invalidFieldId,
	reservedFieldIdPrefix,
	validationOnNonInputType,
	emptyRepeatXPath,
	fixtureReferenceNotModeled,
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
