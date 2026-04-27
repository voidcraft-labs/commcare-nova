// Generates the SA's field-mutation tool input schemas directly from the
// domain's `fieldRegistry` + per-kind Zod schemas.
//
// Three tools share this shape: addFields (batch), addField (single),
// editField (patch). Each takes the same per-field property set — the
// difference is wrapping (array vs object), optionality, and whether null
// is accepted as "clear this property" (patch only).
//
// ## The 8-optional ceiling
//
// Anthropic's structured-output schema compiler times out on array-item
// schemas that carry more than ~8 optional fields. The field union
// accepts every kind in one shape (the SA picks `kind` at the top), so
// the full set of optionals is the UNION across all kinds: ~10+. To keep
// the add-batch schema within the 8-optional cap, `label` and `required`
// are promoted to REQUIRED fields and carry sentinel values instead:
//
//   - `label: ""`   means "no label" (used by hidden fields, which have
//     no user-visible label but still need a slot in the shape).
//   - `required: ""` means "not required" (the SA fills an XPath
//     expression or "true()" when it wants a field required).
//
// `contentProcessing.stripEmpty()` collapses these sentinels to
// `undefined` before the mutation mapper builds a `Field` — the domain
// shape never sees an empty string where it expects absence.
//
// ## Vocabulary
//
// The SA speaks domain vocabulary end-to-end: `kind`, `validate`,
// `validate_msg`, `case_property`. There is no translation layer between
// the LLM and the mutation reducer — tool args flow straight through.
// CommCare wire terms live only at the emission boundary in
// `lib/commcare/` (XForm output). The domain never round-trips
// through a wire shape.
//
// ## Per-kind docs
//
// The `kind` enum's description is composed from each kind's `saDocs`
// (in `fieldRegistry[kind].saDocs`) so the SA reads a concise per-kind
// summary instead of a single-line umbrella. Adding a new kind to
// `fieldKinds` therefore propagates through the generator automatically
// — no generator edits, no re-hand-rolling of documentation strings.

import { z } from "zod";
import type { FieldKind } from "@/lib/domain";
import { fieldKinds, fieldRegistry, selectOptionSchema } from "@/lib/domain";

/**
 * The `kind` field's description: a compact per-kind guide the SA reads
 * when choosing which kind to emit. Each entry is one sentence pulled
 * from `fieldRegistry[kind].saDocs`, prefixed with the kind name so the
 * SA sees the discriminant value alongside its meaning.
 */
function buildKindDescription(kinds: readonly FieldKind[]): string {
	const lines = kinds.map((k) => `  - "${k}": ${fieldRegistry[k].saDocs}`);
	return [
		"Field kind — the discriminant that picks which CommCare control and " +
			"data type to emit. Pick the most specific kind for the data being " +
			"captured (e.g. `int` for a count, not `text`).",
		"",
		...lines,
	].join("\n");
}

function makeKindEnum(kinds: readonly FieldKind[]) {
	return z
		.enum(kinds as readonly [FieldKind, ...FieldKind[]])
		.describe(buildKindDescription(kinds));
}

// ── Per-property descriptions (SA-facing docstrings) ─────────────────
//
// These descriptions live in this file — they're LLM-facing guidance
// for tool arguments, not domain-layer metadata. The domain's Zod
// schemas describe the INTERNAL shape (which optional/required),
// whereas these strings describe the EXTERNAL LLM contract (how to
// fill each slot, when to use sentinels, hashtag reference rules, etc.).
//
// Field names here are the domain names (`validate`, `case_property`,
// …). If we ever flip to per-type tools (one schema per kind), these
// strings still apply — they carry the per-property guidance, not the
// per-kind shape.

const FIELD_DOCS = {
	id:
		"Unique identifier per parent level. Use alphanumeric snake_case " +
		"(must start with a letter). Becomes the XForm node name and the " +
		"CommCare case-property key when `case_property` is set.",
	label:
		"Human-friendly label shown to the end user. Supports hashtag " +
		"references (`#case/prop`, `#form/path`, `#user/prop`) and " +
		"markdown. Do NOT use {curly_brace} template syntax — unsupported. " +
		'Pass "" (empty string) for `hidden` fields (which never render). ' +
		'Pass "" for `group` to make the group transparent at runtime ' +
		"(no chrome, children render at the parent's depth) — useful for " +
		"disambiguating two hidden fields that share an id by giving them " +
		'distinct parents. Pass "" for `repeat` to drop the title text but ' +
		"keep the chrome and iteration controls (the user still needs them " +
		"to add/remove instances). For every other kind (`text`, `int`, " +
		"`single_select`, etc.), the label is required and must be a " +
		"non-empty human-readable string.",
	hint: "Help text rendered below the input.",
	required:
		'XPath expression — "true()" for always-required, or a conditional ' +
		'like "#form/age > 0". Pass "" for not required. Supports hashtag ' +
		"references.",
	validate:
		"XPath expression evaluated when the user leaves the field. " +
		'Example: ". > 0 and . < 150". Pass "" for no validation. Supports ' +
		"hashtag references.",
	validate_msg:
		"Error message displayed when `validate` evaluates to false. Only " +
		"meaningful when `validate` is set.",
	relevant:
		"XPath expression that conditionally shows/hides this field. " +
		'Example: "#form/age >= 18". Supports hashtag references.',
	calculate:
		"XPath expression evaluated on form load and whenever dependencies " +
		"update. Used for hidden computed values and derived display fields. " +
		"Supports hashtag references.",
	default_value:
		"XPath expression evaluated once on form load to seed an initial " +
		"value. Does not re-run on dependency change — use `calculate` for " +
		"that. Supports hashtag references.",
	options:
		"Choice list for single_select / multi_select — minimum 2 options. " +
		"Omit entirely for other kinds.",
	case_property:
		"Case type name this field saves to. When it matches the module's " +
		"case type, the field becomes a normal case property. When " +
		"different, the field implicitly creates a child case of that " +
		'type. The case-name field must always have id "case_name". Must ' +
		"NOT be set on media fields (image, audio, video, signature).",
} as const satisfies Record<string, string>;

// ── Reusable Zod field primitives ───────────────────────────────────
//
// Each helper returns a fresh Zod schema — never share an instance
// across multiple generator outputs, because downstream consumers
// (e.g. `z.toJSONSchema`) mutate the Zod node's internal cache and a
// shared instance can leak that cache between tools.

const idField = () => z.string().describe(FIELD_DOCS.id);
const parentIdField = () =>
	z
		.string()
		.describe(
			'Parent group/repeat id (semantic id, not uuid). Pass "" to ' +
				"insert at the form's top level.",
		);

// Sentinel-carrying required fields. Empty string = "not set"; the
// mutation mapper drops them via `stripEmpty`. Required here so the
// Anthropic compiler counts them as NON-optional, leaving the 8-slot
// optional budget free for the real optionals.
const labelSentinel = () => z.string().describe(FIELD_DOCS.label);
const requiredSentinel = () => z.string().describe(FIELD_DOCS.required);

// Optional shape primitives — these DO count against the 8-optional
// ceiling on the batch-item schema.
const hintField = () => z.string().optional().describe(FIELD_DOCS.hint);
const validateField = () => z.string().optional().describe(FIELD_DOCS.validate);
const validateMsgField = () =>
	z.string().optional().describe(FIELD_DOCS.validate_msg);
const relevantField = () => z.string().optional().describe(FIELD_DOCS.relevant);
const calculateField = () =>
	z.string().optional().describe(FIELD_DOCS.calculate);
const defaultValueField = () =>
	z.string().optional().describe(FIELD_DOCS.default_value);
const optionsField = () =>
	z.array(selectOptionSchema).optional().describe(FIELD_DOCS.options);
const casePropertyField = () =>
	z.string().optional().describe(FIELD_DOCS.case_property);

// Nullable variants for the edit patch. `null` means "clear this
// property" (distinct from "leave unchanged", which is the key absent).
// Every clearable edit-patch key uses these — the tool handler maps
// `null → undefined` before dispatch, and Immer's `Object.assign` drops
// keys set to `undefined`, which is how the reducer clears a property
// without needing a separate "remove" mutation.
const nullableString = (doc: string) =>
	z.string().nullable().optional().describe(doc);
const nullableOptions = () =>
	z
		.array(selectOptionSchema)
		.nullable()
		.optional()
		.describe(FIELD_DOCS.options);

/**
 * Batch-add item shape. Lives inside `z.array(...)` as the per-item
 * schema for `addFields`. Eight optional fields exactly — `label` and
 * `required` are promoted to sentinel-required to stay under the
 * Anthropic compiler limit.
 */
function buildAddFieldsItemSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: idField(),
		kind: makeKindEnum(kinds),
		parentId: parentIdField(),
		// Required sentinels (don't count against the 8-optional cap).
		label: labelSentinel(),
		required: requiredSentinel(),
		// Eight optionals — the maximum the Anthropic compiler handles per
		// array item without timing out. Adding a ninth would push the
		// batch-add tool into compile failures.
		hint: hintField(),
		validate: validateField(),
		validate_msg: validateMsgField(),
		relevant: relevantField(),
		calculate: calculateField(),
		default_value: defaultValueField(),
		options: optionsField(),
		case_property: casePropertyField(),
	});
}

/**
 * Single-insert shape used by the `addField` tool. Only `id` and
 * `kind` are required — the handler already located the insertion
 * point via separate tool arguments (`parentId`, `beforeFieldId`,
 * `afterFieldId`). Everything else is genuinely optional: this
 * schema is NOT inside an array and therefore isn't subject to the
 * 8-optional ceiling, so no sentinels are needed.
 */
function buildAddFieldSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: idField(),
		kind: makeKindEnum(kinds),
		label: z.string().optional().describe(FIELD_DOCS.label),
		hint: hintField(),
		required: z.string().optional().describe(FIELD_DOCS.required),
		validate: validateField(),
		validate_msg: validateMsgField(),
		relevant: relevantField(),
		calculate: calculateField(),
		default_value: defaultValueField(),
		options: optionsField(),
		case_property: casePropertyField(),
	});
}

/**
 * Edit-patch shape. Every key is optional (omitted = "leave as-is").
 * Every clearable key is nullable (null = "clear this property"). The
 * tool handler maps null→undefined before dispatch so the reducer's
 * Object.assign drops the key and the field goes back to its default.
 *
 * `id` and `kind` are also optional but NOT nullable: both are required
 * identity/structural properties that have no meaningful "cleared"
 * state. `id` routes through `renameField` before this patch runs;
 * `kind` routes through `convertField`. Neither reaches the scalar-
 * patch reducer.
 */
function buildEditFieldUpdatesSchema(kinds: readonly FieldKind[]) {
	return z
		.object({
			id: idField().optional(),
			kind: makeKindEnum(kinds).optional(),
			label: nullableString(FIELD_DOCS.label),
			hint: nullableString(FIELD_DOCS.hint),
			required: nullableString(FIELD_DOCS.required),
			validate: nullableString(FIELD_DOCS.validate),
			validate_msg: nullableString(FIELD_DOCS.validate_msg),
			relevant: nullableString(FIELD_DOCS.relevant),
			calculate: nullableString(FIELD_DOCS.calculate),
			default_value: nullableString(FIELD_DOCS.default_value),
			options: nullableOptions(),
			case_property: nullableString(FIELD_DOCS.case_property),
		})
		.describe(
			"Properties to update. Omit a key to leave it unchanged; pass " +
				"`null` on any clearable key to reset it to default. `id` and " +
				"`kind` changes are structural (rename / convert) — pass the " +
				"new value directly, no null-clearing needed.",
		);
}

/**
 * Bundle of generated SA tool schemas. The `addFieldsItemSchema` is the
 * per-item shape used inside `z.array(...)` for the batch-add tool —
 * exposed separately so consumers that wrap it in their own input
 * schema (which adds `moduleIndex`/`formIndex`) can reuse the same
 * inferred TS type.
 */
export type GeneratedToolSchemas = {
	addFieldsItemSchema: ReturnType<typeof buildAddFieldsItemSchema>;
	addFieldSchema: ReturnType<typeof buildAddFieldSchema>;
	editFieldUpdatesSchema: ReturnType<typeof buildEditFieldUpdatesSchema>;
};

/**
 * Generate the three SA field-mutation tool schemas from the field
 * registry. `kinds` defaults to the authoritative `fieldKinds` tuple;
 * tests may pass a subset to exercise generator behavior without pulling
 * in the full registry.
 */
export function generateToolSchemas(
	kinds: readonly FieldKind[] = fieldKinds,
): GeneratedToolSchemas {
	return {
		addFieldsItemSchema: buildAddFieldsItemSchema(kinds),
		addFieldSchema: buildAddFieldSchema(kinds),
		editFieldUpdatesSchema: buildEditFieldUpdatesSchema(kinds),
	};
}
