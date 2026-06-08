// Generates the SA's field-mutation tool inputs directly from the domain's
// `fieldRegistry` + per-kind Zod schemas.
//
// ## Per-kind discriminated unions
//
// All three tools (addFields batch, addField single, editField patch) take a
// `discriminatedUnion("kind", …)`: an arm exposes ONLY the properties that
// kind's domain schema declares (gated by `fieldKindDeclaresKey`) and is
// `.strict()`. So a property the kind doesn't have — `calculate` on a
// `single_select`, `options` on a `hidden` — isn't a slot on the arm, and an
// explicit attempt is rejected at the tool boundary rather than silently
// dropped or assembled into a broken field. This is the structural reason the
// "wrong property for this kind" error class can't be expressed.
//
// Tool use is NOT grammar-constrained (that's `Output.object` only), so there
// is no per-array-item optional-field compile ceiling here — the arms carry
// as many optionals as the kind declares.
//
// ## Per-kind label policy
//
// On the ADD arms `label` is per kind: omitted on `hidden` (no label slot),
// optional on the containers (`group` / `repeat` — empty = transparent /
// titleless), and required + non-empty (`min(1)`) on every visible kind. The
// per-kind arm is what lets us require a real label without the old `""`
// sentinel. (`required` and `parentId`, where declared, stay plain optionals
// the SA omits when unset.)
//
// The WIDE processing-type sources below — `wideFlatItemSchema` /
// `wideEditUpdatesSchema`, used only to infer `FlatField` / the edit-patch
// type, never as a tool input — DO keep a required-with-sentinel `label`
// (`labelSentinel()`); `contentProcessing.stripEmpty()` collapses that `""`
// to absent. That sentinel lives on the wide type alone, not on any arm.
//
// ## Vocabulary
//
// The SA speaks domain vocabulary end-to-end: `kind`, `validate`,
// `validate_msg`, `case_property_on`. There is no translation layer between
// the LLM and the mutation reducer — tool args flow straight through.
// CommCare wire terms live only at the emission boundary in
// `lib/commcare/` (XForm output). The domain never round-trips
// through a wire shape.
//
// ## Per-kind docs
//
// Each arm's `kind` literal carries that kind's `saDocs` (from
// `fieldRegistry[kind].saDocs`) as its description, so the SA reads a concise
// per-kind summary on the discriminant it's choosing. Adding a new kind to
// `fieldKinds` therefore propagates through the generator automatically — no
// generator edits, no re-hand-rolling of documentation strings.

import { z } from "zod";
import type { FieldKind } from "@/lib/domain";
import {
	fieldKindDeclaresKey,
	fieldKinds,
	fieldRegistry,
	selectOptionSchema,
} from "@/lib/domain";

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
// Field names here are the domain names (`validate`, `case_property_on`,
// …). If we ever flip to per-type tools (one schema per kind), these
// strings still apply — they carry the per-property guidance, not the
// per-kind shape.

const FIELD_DOCS = {
	id:
		"Unique identifier per parent level. Use alphanumeric snake_case " +
		"(must start with a letter). Becomes the XForm node name and the " +
		"CommCare case-property key when `case_property_on` is set.",
	label:
		"Human-friendly label shown to the end user. Supports hashtag " +
		"references (`#case/prop`, `#form/path`, `#user/prop`) and " +
		"markdown. Do NOT use {curly_brace} template syntax — unsupported. " +
		'Pass "" (empty string) for `hidden` fields (which never render). ' +
		'Pass "" for `group` to make the group transparent at runtime ' +
		"(no chrome, children render at the parent's depth) — a residual " +
		"home for stray hidden fields that don't fit a logical group, not " +
		'a primary disambiguation tool. Pass "" for `repeat` to drop the title text but ' +
		"keep the chrome and iteration controls (the user still needs them " +
		"to add/remove instances). For every other kind (`text`, `int`, " +
		"`single_select`, etc.), the label is required and must be a " +
		"non-empty human-readable string.",
	hint: "Help text rendered below the input.",
	help:
		"Longer-form help text the user taps to expand — for guidance too " +
		"long to sit inline as a hint. Plain text (not an XPath expression). " +
		"Supports hashtag references.",
	required:
		'XPath expression — "true()" for always-required, or a conditional ' +
		'like "#form/age > 0". Omit for not required. Supports hashtag ' +
		"references.",
	validate:
		"XPath boolean that must hold for the field's value to be accepted, " +
		"checked when the user leaves the field (`.` is the entered value); " +
		"pairs with `validate_msg`, shown when it fails. Write the rule that " +
		"captures the field's actual valid values, using the full XPath " +
		"language to whatever precision the field's meaning calls for. Pass " +
		'"" when any value is acceptable. Supports hashtag references.',
	validate_msg:
		"Error message displayed when `validate` evaluates to false. Only " +
		"meaningful when `validate` is set.",
	relevant:
		"XPath expression that conditionally shows/hides this field. " +
		'Example: "#form/age >= 18". Supports hashtag references.',
	calculate:
		"XPath that computes a HIDDEN field's value — evaluated on form load and " +
		"whenever its dependencies change. Only `hidden` fields carry a " +
		"calculate; a computed value on a visible control would render read-only, " +
		"so show a computed value with a `label` field that outputs it instead. " +
		"Supports hashtag references.",
	default_value:
		"XPath expression evaluated once on form load to seed an initial " +
		"value. Does not re-run on dependency change — use `calculate` for " +
		"that. Supports hashtag references.",
	options:
		"Choice list for single_select / multi_select — minimum 2 options. " +
		"Omit entirely for other kinds.",
	case_property_on:
		"Case type name this field saves to. When it matches the module's " +
		"case type, the field becomes a normal case property. When " +
		"different, the field implicitly creates a child case of that " +
		'type. The case-name field must always have id "case_name". Must ' +
		"NOT be set on media fields (image, audio, video, signature).",
	// Repeat-specific. These keys live INSIDE the optional nested
	// `repeat: { mode, count?, ids_query? }` object on the SA tools —
	// non-repeat fields simply omit `repeat`. The descriptions describe
	// the inner-key contract; the wrapping `repeat` object's own
	// description handles the "set when kind === repeat" framing.
	repeat_mode:
		'Iteration mode. "user_controlled" — user adds/removes instances ' +
		'at form fill (e.g. household members list). "count_bound" — count ' +
		"comes from another XPath (set `count`); JavaRosa freezes the " +
		'cardinality once at form load and does not recalculate. "query_bound" ' +
		"— iterate over case-database query results (set `ids_query`); same " +
		"one-time evaluation as count_bound.",
	repeat_count:
		"XPath expression that resolves to the desired iteration count, " +
		'e.g. `#form/desired_count`. Set this when `mode === "count_bound"`; ' +
		"omit otherwise. Evaluated once at form load — changes to the " +
		"underlying value do not resize the repeat (JavaRosa spec). " +
		"Supports hashtag references.",
	ids_query:
		"XPath expression that resolves to a list of case ids to iterate " +
		"over, e.g. `instance('casedb')/casedb/case[@case_type='service'][@status='open']/@case_id`. " +
		'Set this when `mode === "query_bound"`; omit otherwise. The runtime ' +
		"materializes one instance per id; each iteration's `@id` resolves " +
		"to the id at the matching position. Supports hashtag references.",
} as const satisfies Record<string, string>;

// ── Reusable Zod field primitives ───────────────────────────────────
//
// Each helper returns a fresh Zod schema — never share an instance
// across multiple generator outputs, because downstream consumers
// (e.g. `z.toJSONSchema`) mutate the Zod node's internal cache and a
// shared instance can leak that cache between tools.

const idField = () => z.string().describe(FIELD_DOCS.id);

// `parentId` is optional — omit it to insert at the form's top level
// (the handler defaults a missing parent to form-level). Pass a
// group/repeat id (including one added earlier in the same batch) to
// nest under it.
const parentIdField = () =>
	z
		.string()
		.optional()
		.describe(
			"Parent group/repeat id (semantic id, not uuid). Omit to insert " +
				"at the form's top level.",
		);

// `label` is required-with-sentinel ("" = no label). Required, not
// optional, as a conscious-choice guard: visible kinds need a real label,
// the empty-label kinds (hidden / transparent group / titleless repeat)
// opt in with "". Not a compiler-budget device — see the header comment.
// `stripEmpty` collapses the "" to absent before assembly.
const labelSentinel = () => z.string().describe(FIELD_DOCS.label);

// Optional shape primitives. `validate` and `repeat` are nested objects
// that group related config (expr+msg, mode+count/ids_query) into one
// field each, keeping the item shape flat and easy for the SA to fill.
const requiredField = () => z.string().optional().describe(FIELD_DOCS.required);
const hintField = () => z.string().optional().describe(FIELD_DOCS.hint);
const relevantField = () => z.string().optional().describe(FIELD_DOCS.relevant);
const calculateField = () =>
	z.string().optional().describe(FIELD_DOCS.calculate);
const defaultValueField = () =>
	z.string().optional().describe(FIELD_DOCS.default_value);
// The SA's option shape omits the `media` slot. `selectOptionSchema`
// carries an optional per-option `media` reference, but the
// field-mutation tools expose neither the asset library nor an upload
// affordance, so the agent can't mint or validate an asset id here —
// exposing the slot would only let the model write a dangling
// reference into the doc. Option media is set through the dedicated
// media tools, not the generic field-mutation tools.
const saOptionSchema = selectOptionSchema.omit({ media: true });

const optionsField = () =>
	z.array(saOptionSchema).optional().describe(FIELD_DOCS.options);

// Nested-object factories — return the bare object so callers wrap it
// with `.optional()` (add tools) or `.nullable().optional()` (edit
// patch). The "never share an instance across generator outputs" rule
// applies: each call returns a fresh schema so downstream JSON-schema
// generation (which mutates Zod node caches) doesn't leak between tools.
const validateConfigField = () =>
	z
		.object({
			expr: z.string().describe(FIELD_DOCS.validate),
			msg: z.string().optional().describe(FIELD_DOCS.validate_msg),
		})
		.describe(
			"Validation config. `expr` is the XPath that must hold true; " +
				"`msg` is the error message shown when it doesn't. Omit the " +
				"object entirely to skip validation.",
		);

const repeatConfigField = () =>
	z
		.object({
			mode: z
				.enum(["user_controlled", "count_bound", "query_bound"])
				.describe(FIELD_DOCS.repeat_mode),
			count: z.string().optional().describe(FIELD_DOCS.repeat_count),
			ids_query: z.string().optional().describe(FIELD_DOCS.ids_query),
		})
		.describe(
			'Repeat-mode config — set only when `kind === "repeat"`. ' +
				"Pick a `mode` and provide the matching mode-specific field " +
				"(`count` for count_bound, `ids_query` for query_bound).",
		);
const casePropertyOnField = () =>
	z.string().optional().describe(FIELD_DOCS.case_property_on);

// Nullable variants for the edit patch. `null` means "clear this
// property" (distinct from "leave unchanged", which is the key absent).
// The `null` is preserved end-to-end — `editField` carries it into the
// `updateField` patch and the reducer deletes the key on a `null` (or
// `undefined`) value, clearing the property without a separate "remove"
// mutation. `null` (unlike `undefined`) survives Firestore, so the clear
// round-trips through the event log.
const nullableString = (doc: string) =>
	z.string().nullable().optional().describe(doc);
const nullableOptions = () =>
	z.array(saOptionSchema).nullable().optional().describe(FIELD_DOCS.options);

/**
 * The WIDE flat item shape — the source of the `FlatField` processing type
 * (`contentProcessing.ts`). It carries every key any kind might use (all
 * optional but `id`/`kind`). The actual tool inputs below are per-kind
 * discriminated unions whose every arm is a structural SUBSET of this shape,
 * so a validated tool item flows through `stripEmpty` / `applyDefaults` /
 * `flatFieldToField` unchanged — those helpers stay typed against this one
 * wide shape rather than a 19-way union.
 */
function buildWideFlatItemSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: idField(),
		kind: makeKindEnum(kinds),
		label: labelSentinel(),
		parentId: parentIdField(),
		required: requiredField(),
		hint: hintField(),
		validate: validateConfigField().optional(),
		relevant: relevantField(),
		calculate: calculateField(),
		default_value: defaultValueField(),
		options: optionsField(),
		case_property_on: casePropertyOnField(),
		repeat: repeatConfigField().optional(),
	});
}

// ── Per-kind discriminated-union tool inputs ─────────────────────────
//
// Each field-mutation tool's input is a `discriminatedUnion("kind", …)`:
// an arm exposes ONLY the properties that kind's domain schema declares
// (gated by `fieldKindDeclaresKey`), so the SA cannot even express an
// invalid combination — `calculate` simply isn't a slot on a
// `single_select` arm, `options` isn't on `hidden`, `hint` isn't on
// `repeat`. The whole class of "wrong property for this kind" errors
// becomes unrepresentable at the tool-call boundary instead of caught
// after assembly. Per-property guidance still comes from `FIELD_DOCS`.

/**
 * Repeat config for the `repeat` arm — discriminated on `mode` so a
 * `count_bound` without `count` (or `query_bound` without `ids_query`) is a
 * tool-input rejection, not a downstream assembly failure.
 */
function repeatConfigDiscriminated() {
	return z
		.discriminatedUnion("mode", [
			z
				.object({ mode: z.literal("user_controlled") })
				.describe("User adds/removes instances during form fill."),
			z
				.object({
					mode: z.literal("count_bound"),
					count: z.string().describe(FIELD_DOCS.repeat_count),
				})
				.describe("Fixed count from an XPath — provide `count`."),
			z
				.object({
					mode: z.literal("query_bound"),
					ids_query: z.string().describe(FIELD_DOCS.ids_query),
				})
				.describe("Iterate case-database query results — provide `ids_query`."),
		])
		.describe(FIELD_DOCS.repeat_mode);
}

/**
 * The add-tool `label` slot for a kind: omitted for kinds that declare no
 * label (`hidden`), optional for containers (`group` / `repeat` — empty =
 * a transparent/titleless container), required & non-empty (`min(1)`) for
 * every visible kind. Per-kind typing lets us require a real label without
 * the old `""`-sentinel hack.
 */
function addLabelField(kind: FieldKind) {
	return fieldRegistry[kind].isContainer
		? z.string().optional().describe(FIELD_DOCS.label)
		: z.string().min(1).describe(FIELD_DOCS.label);
}

/**
 * One kind's arm for an add tool. `withParentId` is true for the batch
 * item (per-field parent id); the single `addField` tool carries `parentId`
 * as a separate top-level argument, so its arms omit it.
 */
function buildAddArm(kind: FieldKind, withParentId: boolean) {
	const has = (key: string): boolean => fieldKindDeclaresKey(kind, key);
	return z
		.object({
			kind: z.literal(kind).describe(fieldRegistry[kind].saDocs),
			id: idField(),
			...(withParentId ? { parentId: parentIdField() } : {}),
			...(has("label") ? { label: addLabelField(kind) } : {}),
			...(has("hint") ? { hint: hintField() } : {}),
			...(has("required") ? { required: requiredField() } : {}),
			...(has("relevant") ? { relevant: relevantField() } : {}),
			...(has("validate")
				? { validate: validateConfigField().optional() }
				: {}),
			...(has("calculate") ? { calculate: calculateField() } : {}),
			...(has("default_value") ? { default_value: defaultValueField() } : {}),
			...(has("options")
				? {
						options: z
							.array(saOptionSchema)
							.min(2)
							.describe(FIELD_DOCS.options),
					}
				: {}),
			...(has("case_property_on")
				? { case_property_on: casePropertyOnField() }
				: {}),
			...(kind === "repeat" ? { repeat: repeatConfigDiscriminated() } : {}),
			// `.strict()` so a property the kind doesn't declare (e.g. `calculate`
			// on a `single_select`) is REJECTED at the boundary — the SA is told
			// and retries, rather than the stray key being silently stripped.
		})
		.strict();
}

/**
 * `z.discriminatedUnion` wants a non-empty tuple of members; the runtime
 * arm list is built from `fieldKinds`. Every member carries a distinct
 * `kind` literal so the discriminator is well-formed — the cast just
 * satisfies the tuple-arity signature.
 */
type AddArm = ReturnType<typeof buildAddArm>;

function buildAddFieldsItemSchema(kinds: readonly FieldKind[]) {
	const arms = kinds.map((k) => buildAddArm(k, true)) as [AddArm, ...AddArm[]];
	return z.discriminatedUnion("kind", arms);
}

/**
 * Single-insert shape for the `addField` tool — the same per-kind arms as
 * the batch item, minus the per-field `parentId` (the single tool locates
 * the insertion point via separate top-level arguments: `parentId`,
 * `beforeFieldId`, `afterFieldId`).
 */
function buildAddFieldSchema(kinds: readonly FieldKind[]) {
	const arms = kinds.map((k) => buildAddArm(k, false)) as [AddArm, ...AddArm[]];
	return z.discriminatedUnion("kind", arms);
}

/**
 * The WIDE edit-patch shape — the source of the type `editPatchToFieldPatch`
 * (`tools/editField.ts`) consumes. Carries every clearable key
 * (`.nullable().optional()`). The per-kind edit union below is the actual
 * tool input; its arms are structural subsets of this shape, so the patch
 * mapper stays typed against one wide shape rather than a 19-way union.
 */
function buildWideEditUpdatesSchema(kinds: readonly FieldKind[]) {
	return z.object({
		id: idField().optional(),
		kind: makeKindEnum(kinds).optional(),
		label: nullableString(FIELD_DOCS.label),
		hint: nullableString(FIELD_DOCS.hint),
		help: nullableString(FIELD_DOCS.help),
		required: nullableString(FIELD_DOCS.required),
		validate: validateConfigField().nullable().optional(),
		relevant: nullableString(FIELD_DOCS.relevant),
		calculate: nullableString(FIELD_DOCS.calculate),
		default_value: nullableString(FIELD_DOCS.default_value),
		options: nullableOptions(),
		case_property_on: nullableString(FIELD_DOCS.case_property_on),
		repeat: repeatConfigField().optional(),
	});
}

/**
 * One kind's arm for the `editField` tool. Like the add arms it exposes
 * only the kind's declared keys — but every clearable key is
 * `.nullable().optional()` (omit = leave as-is, `null` = clear, value =
 * set), and `help` (longer-form text the add tools omit) appears for kinds
 * that declare it.
 *
 * `kind` is REQUIRED here because it's the union discriminator: the SA
 * states the field's CURRENT kind to edit in place, or a different
 * convertible kind to convert it. That's what lets the patch be validated
 * against the right kind's property set — so the SA can't, say, set
 * `calculate` on a `single_select` (the slot isn't on that arm).
 *
 * `repeat` is optional-not-nullable: a repeat always has a mode, so
 * "clear the repeat config" is meaningless — switch modes by passing a new
 * `repeat` object (the reducer drops the prior mode's mode-specific field).
 */
function buildEditArm(kind: FieldKind) {
	const has = (key: string): boolean => fieldKindDeclaresKey(kind, key);
	return z
		.object({
			kind: z
				.literal(kind)
				.describe(
					"The field's kind. Pass its CURRENT kind to edit in place, or a " +
						"different convertible kind to convert it — required so the patch " +
						"is validated against this kind's properties.",
				),
			id: idField()
				.optional()
				.describe("New id to rename to; omit to keep it."),
			...(has("label") ? { label: nullableString(FIELD_DOCS.label) } : {}),
			...(has("hint") ? { hint: nullableString(FIELD_DOCS.hint) } : {}),
			...(has("help") ? { help: nullableString(FIELD_DOCS.help) } : {}),
			...(has("required")
				? { required: nullableString(FIELD_DOCS.required) }
				: {}),
			...(has("relevant")
				? { relevant: nullableString(FIELD_DOCS.relevant) }
				: {}),
			...(has("validate")
				? { validate: validateConfigField().nullable().optional() }
				: {}),
			...(has("calculate")
				? { calculate: nullableString(FIELD_DOCS.calculate) }
				: {}),
			...(has("default_value")
				? { default_value: nullableString(FIELD_DOCS.default_value) }
				: {}),
			...(has("options") ? { options: nullableOptions() } : {}),
			...(has("case_property_on")
				? { case_property_on: nullableString(FIELD_DOCS.case_property_on) }
				: {}),
			...(kind === "repeat"
				? { repeat: repeatConfigDiscriminated().optional() }
				: {}),
			// `.strict()` — same boundary rejection as the add arms: a property
			// this kind doesn't declare is an error, not a silent strip.
		})
		.strict();
}

type EditArm = ReturnType<typeof buildEditArm>;

function buildEditFieldUpdatesSchema(kinds: readonly FieldKind[]) {
	const arms = kinds.map(buildEditArm) as [EditArm, ...EditArm[]];
	return z.discriminatedUnion("kind", arms);
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
	/** Wide processing-type sources (NOT tool inputs) — see the builders. */
	wideFlatItemSchema: ReturnType<typeof buildWideFlatItemSchema>;
	wideEditUpdatesSchema: ReturnType<typeof buildWideEditUpdatesSchema>;
};

/**
 * Generate the SA field-mutation tool schemas from the field registry.
 * `kinds` defaults to the authoritative `fieldKinds` tuple; tests may pass
 * a subset to exercise generator behavior without pulling in the full
 * registry. The three `*Schema` outputs are the per-kind discriminated-union
 * TOOL inputs; the two `wide*` outputs are the wide processing-type sources
 * the downstream pipeline types against.
 */
export function generateToolSchemas(
	kinds: readonly FieldKind[] = fieldKinds,
): GeneratedToolSchemas {
	return {
		addFieldsItemSchema: buildAddFieldsItemSchema(kinds),
		addFieldSchema: buildAddFieldSchema(kinds),
		editFieldUpdatesSchema: buildEditFieldUpdatesSchema(kinds),
		wideFlatItemSchema: buildWideFlatItemSchema(kinds),
		wideEditUpdatesSchema: buildWideEditUpdatesSchema(kinds),
	};
}
