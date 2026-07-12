// Generates the SA's field-mutation tool inputs directly from the domain's
// `fieldRegistry` + per-kind Zod schemas.
//
// ## One flat shape per tool, kind-gated by refinement
//
// Both field-mutation tools (the addFields item, the editField patch) take
// ONE flat object: every slot is stated once, and `kind` is a described
// enum. Which slots a kind may carry is enforced by a `superRefine` over
// `fieldKindDeclaresKey` — `calculate` on a `single_select`, `options` on a
// `hidden`, are rejected at the tool boundary with a message naming a fix
// the model can express (leave the slot out / pass null), never silently
// dropped or assembled into a broken field. A per-kind
// `discriminatedUnion` would encode the same law structurally, but it
// restates every shared slot's documentation on each of the 19 arms — tens
// of thousands of schema tokens per request, on every request, for
// identical rejection behavior. The refinement carries the law; the docs
// appear once.
//
// ## The wire forces every key — null is the only absence
//
// The provider's constrained tool decoding lists EVERY property as required
// on the wire, so the model cannot omit a key it has no value for (verified
// live: prompted to omit, it fills keys with invented filler; a nullable
// slot gets a clean `null` instead). Every optional slot on every arm is
// therefore `.nullable()`: `null` is the SA's way to say "nothing here",
// and the pipeline collapses it to absence (`stripEmpty` on the add path;
// the edit path treats it as "leave unchanged"). Never design a slot whose
// meaning depends on omitted-vs-null — the model can't express omission.
//
// ## Label policy
//
// `label` is one nullable slot; the kind policy makes it behave per kind:
// required + non-empty on every visible kind, anything on the containers
// (`group` / `repeat` — null/""/absent = transparent / titleless, and
// `contentProcessing.stripEmpty()` collapses the `""` to absence), and
// rejected on `hidden` (which declares no label). No `""` sentinel exists
// on the tool surface.
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
// The `kind` enum's description aggregates every kind's `saDocs` (from
// `fieldRegistry[kind].saDocs`), one line per kind, so the SA reads the
// per-kind guide exactly where it chooses the value. Adding a new kind to
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
		"references (`#<case_type>/prop`, `#form/path`, `#user/prop`) and " +
		"markdown. Do NOT use {curly_brace} template syntax — unsupported. " +
		"On every visible kind (`text`, `int`, `single_select`, etc.) the " +
		"label is required and must be a non-empty human-readable string; " +
		"`hidden` fields carry no label slot at all. The containers treat " +
		'an EXPLICIT "" as a real value, not filler: "" on a `group` makes ' +
		"it transparent at runtime (no chrome, children render at the " +
		"parent's depth) — a residual home for stray hidden fields that " +
		"don't fit a logical group, not a primary disambiguation tool — " +
		'and "" on a `repeat` drops the title text but keeps the chrome ' +
		"and iteration controls (the user still needs them to add/remove " +
		"instances).",
	hint: "Help text rendered below the input.",
	help:
		"Longer-form help text the user taps to expand — for guidance too " +
		"long to sit inline as a hint. Plain text (not an XPath expression). " +
		"Supports hashtag references.",
	required:
		'XPath expression — "true()" for always-required, or a conditional ' +
		'like "#form/age > 0". Pass null for not required. Supports hashtag ' +
		"references.",
	validate:
		"XPath boolean that must hold for the field's value to be accepted, " +
		"checked when the user leaves the field (`.` is the entered value); " +
		"pairs with `validate_msg`, shown when it fails. Write the rule that " +
		"captures the field's actual valid values, using the full XPath " +
		"language to whatever precision the field's meaning calls for. Pass " +
		"null for the whole `validate` object when any value is acceptable. " +
		"Supports hashtag references.",
	validate_msg:
		"Error message displayed when `validate` evaluates to false. Only " +
		"meaningful when `validate` is set.",
	relevant:
		"XPath expression that conditionally shows/hides this field. " +
		'Example: "#form/age >= 18". Supports hashtag references.',
	calculate:
		"XPath that recomputes a HIDDEN field's value whenever a field it " +
		"references changes — it lives in the form's recalculation graph. Use it " +
		"ONLY when the value must track other fields that can change during fill; " +
		"for a value fixed at load (a constant, or a stamp like today()), use " +
		"`default_value` instead so it isn't needlessly recomputed. Only `hidden` " +
		"fields carry a calculate; a computed value on a visible control would " +
		"render read-only, so show one with a `label` field that outputs it " +
		"instead. Supports hashtag references.",
	default_value:
		"XPath evaluated ONCE when the form loads, seeding a value that never " +
		"recomputes (not in the recalculation graph). Prefer this for any value " +
		"fixed for the form's life — a literal constant, or a load-time stamp " +
		"like today(). Use `calculate` instead only when the value must update as " +
		"other fields change. Supports hashtag references.",
	options:
		"Choice list for single_select / multi_select — minimum 2 options. " +
		"Other kinds carry no options slot.",
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

// `parentId` is optional — null (or omission) inserts at the form's top
// level. Pass a group/repeat id (including one added earlier in the same
// batch) to nest under it.
const parentIdField = () =>
	z
		.string()
		.nullable()
		.optional()
		.describe(
			"Parent group/repeat id (semantic id, not uuid). Pass null to " +
				"insert at the form's top level.",
		);

// `label` is nullable on the shape; the kind policy (see the builders
// below) requires a real, non-empty label on every visible kind and
// rejects one on `hidden`. The containers (`group` / `repeat`) accept
// null/""/absent — `stripEmpty` collapses the "" to absent before
// assembly.
const labelField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.label);

// Optional shape primitives — all NULLABLE: the wire forces every key
// present on a tool call (constrained decoding lists every property as
// required), so `null` is the model's ONLY way to say "nothing here".
// Every optional slot accepts it and the pipeline collapses it to
// absence (`stripEmpty`). `validate` and `repeat` are nested objects
// that group related config (expr+msg, mode+count/ids_query) into one
// field each, keeping the item shape flat and easy for the SA to fill.
const requiredField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.required);
const hintField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.hint);
const relevantField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.relevant);
const calculateField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.calculate);
const defaultValueField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.default_value);
// The SA's option shape omits `media`, `uuid`, and `order`.
// `selectOptionSchema` carries an optional per-option `media` reference, but
// the field-mutation tools expose neither the asset library nor an upload
// affordance, so the agent can't mint or validate an asset id here —
// exposing the slot would only let the model write a dangling reference into
// the doc. Option media is set through the dedicated media tools. `uuid`
// (the option's stable identity) and `order` (its fractional sort key) are
// likewise tool/gesture-computed, never authored: backfill mints the uuid
// from `(field uuid, option index)` and the diff layer computes the key.
const saOptionSchema = selectOptionSchema.omit({
	media: true,
	uuid: true,
	order: true,
});

const optionsField = () =>
	z.array(saOptionSchema).nullable().optional().describe(FIELD_DOCS.options);

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

const casePropertyOnField = () =>
	z.string().nullable().optional().describe(FIELD_DOCS.case_property_on);

// Nullable variants for the edit patch. `null` means "leave this
// property unchanged" — the wire forces every key present on a tool
// call, so null is the model's only way to NOT touch a slot; treating it
// as a clear would wipe every property an edit didn't mention. Clearing
// is EXPLICIT: the `editField` input's `clear` array names the
// properties to unset.
const nullableString = (doc: string) =>
	z.string().nullable().optional().describe(doc);
const nullableOptions = () =>
	z.array(saOptionSchema).nullable().optional().describe(FIELD_DOCS.options);

// ── Flat tool inputs, kind-gated by refinement ───────────────────────
//
// Each field-mutation tool's input is ONE `.strict()` object whose slots
// appear once, `superRefine`d against `fieldKindDeclaresKey`: a property
// the kind doesn't declare — `calculate` on a `single_select`, `options`
// on `hidden`, `hint` on `repeat` — rejects at the tool-call boundary
// with a message naming the expressible fix (leave it out / pass null),
// exactly the "wrong property for this kind" gate a per-kind union would
// impose structurally, at a fraction of the schema size. The inferred
// type of the add item IS the `FlatField` processing shape the pipeline
// (`stripEmpty` / `applyDefaults` / `flatFieldToField`) types against —
// tool input and processing shape are one.

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
 * Slots whose presence is gated per kind through `fieldKindDeclaresKey`.
 * `id` / `kind` / `parentId` are tool-level (every kind carries them), and
 * `repeat` is gated on `kind === "repeat"` directly — the domain flattens
 * its config into `repeat_mode`/`repeat_count`/`data_source`, so there is
 * no single declared key to ask the registry about.
 */
const ADD_GATED_KEYS = [
	"label",
	"hint",
	"required",
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"options",
	"case_property_on",
] as const;

const EDIT_GATED_KEYS = [...ADD_GATED_KEYS, "help"] as const;

function undeclaredSlotIssue(
	ctx: z.RefinementCtx,
	kind: FieldKind,
	key: string,
): void {
	ctx.addIssue({
		code: "custom",
		path: [key],
		message: `kind "${kind}" carries no \`${key}\` slot — leave ${key} out (or pass null).`,
	});
}

/** Reject a `repeat` config on any non-repeat kind. */
function gateRepeatSlot(
	ctx: z.RefinementCtx,
	kind: FieldKind,
	repeat: unknown,
): void {
	if (kind !== "repeat" && repeat != null) {
		ctx.addIssue({
			code: "custom",
			path: ["repeat"],
			message: `only kind "repeat" carries a \`repeat\` config — leave it out (or pass null).`,
		});
	}
}

/**
 * The `addFields` item shape (also embedded by `createForm` / `createModule`
 * for their `fields` arrays). Each item carries a per-field `parentId` so a
 * batch can place each field precisely (and reference a group added earlier
 * in the same batch). The kind policy enforces per-kind requiredness the
 * flat shape can't state: a non-empty `label` on every visible kind, ≥2
 * `options` on the selects, a `repeat` config on `repeat` — and rejects any
 * slot the kind doesn't declare.
 */
function buildAddFieldsItemSchema(kinds: readonly FieldKind[]) {
	return z
		.object({
			kind: makeKindEnum(kinds),
			id: idField(),
			parentId: parentIdField(),
			label: labelField(),
			hint: hintField(),
			required: requiredField(),
			relevant: relevantField(),
			validate: validateConfigField().nullable().optional(),
			calculate: calculateField(),
			default_value: defaultValueField(),
			options: optionsField(),
			case_property_on: casePropertyOnField(),
			repeat: repeatConfigDiscriminated().nullable().optional(),
			// `.strict()` so a key outside the shape is REJECTED at the boundary —
			// the SA is told and retries, rather than the stray key being
			// silently stripped.
		})
		.strict()
		.superRefine((item, ctx) => {
			for (const key of ADD_GATED_KEYS) {
				if (item[key] != null && !fieldKindDeclaresKey(item.kind, key)) {
					undeclaredSlotIssue(ctx, item.kind, key);
				}
			}
			if (
				fieldKindDeclaresKey(item.kind, "label") &&
				!fieldRegistry[item.kind].isContainer &&
				!item.label
			) {
				ctx.addIssue({
					code: "custom",
					path: ["label"],
					message: `kind "${item.kind}" needs a real \`label\` — the end user reads it. Pass a non-empty string.`,
				});
			}
			if (
				fieldKindDeclaresKey(item.kind, "options") &&
				(item.options == null || item.options.length < 2)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["options"],
					message: `kind "${item.kind}" needs an \`options\` choice list with at least 2 entries.`,
				});
			}
			if (item.kind === "repeat" && item.repeat == null) {
				ctx.addIssue({
					code: "custom",
					path: ["repeat"],
					message:
						'kind "repeat" needs its `repeat` config — pass at least { mode: "user_controlled" }.',
				});
			}
			gateRepeatSlot(ctx, item.kind, item.repeat);
		});
}

/**
 * The `editField` patch shape. Every key is `.nullable().optional()`
 * (`null` or omitted = leave as-is, value = set; clears go through the
 * input's explicit `clear` list), and `help` (longer-form text the add
 * tool omits) is a slot for kinds that declare it.
 *
 * `kind` is REQUIRED: the SA states the field's CURRENT kind to edit in
 * place, or a different convertible kind to convert it. That's what the
 * kind policy validates the patch against — so the SA can't, say, set
 * `calculate` on a `single_select`. The per-kind guide lives on the
 * `addFields` items' `kind`; this one carries the edit framing alone.
 *
 * `repeat` is nullable like the rest (null = keep the current config):
 * a repeat always has a mode, so "clear the repeat config" is meaningless —
 * switch modes by passing a new `repeat` object (the reducer drops the
 * prior mode's mode-specific field).
 */
function buildEditFieldUpdatesSchema(kinds: readonly FieldKind[]) {
	return z
		.object({
			kind: z
				.enum(kinds as readonly [FieldKind, ...FieldKind[]])
				.describe(
					"The field's kind. Pass its CURRENT kind to edit in place, or a " +
						"different convertible kind to convert it — the patch is " +
						"validated against this kind's slots. Kinds are documented on " +
						"the `addFields` items' `kind`.",
				),
			id: idField()
				.nullable()
				.optional()
				.describe("New id to rename to; null keeps the current id."),
			label: nullableString(FIELD_DOCS.label),
			hint: nullableString(FIELD_DOCS.hint),
			help: nullableString(FIELD_DOCS.help),
			required: nullableString(FIELD_DOCS.required),
			relevant: nullableString(FIELD_DOCS.relevant),
			validate: validateConfigField().nullable().optional(),
			calculate: nullableString(FIELD_DOCS.calculate),
			default_value: nullableString(FIELD_DOCS.default_value),
			options: nullableOptions(),
			case_property_on: nullableString(FIELD_DOCS.case_property_on),
			repeat: repeatConfigDiscriminated().nullable().optional(),
			// `.strict()` — same boundary rejection as the add item: a key
			// outside the shape is an error, not a silent strip.
		})
		.strict()
		.superRefine((patch, ctx) => {
			for (const key of EDIT_GATED_KEYS) {
				if (patch[key] != null && !fieldKindDeclaresKey(patch.kind, key)) {
					undeclaredSlotIssue(ctx, patch.kind, key);
				}
			}
			gateRepeatSlot(ctx, patch.kind, patch.repeat);
		});
}

/**
 * Bundle of generated SA tool schemas. The `addFieldsItemSchema` is the
 * per-item shape used inside `z.array(...)` for the batch-add tool —
 * exposed separately so consumers that wrap it in their own input
 * schema (which adds `moduleIndex`/`formIndex`) can reuse the same
 * inferred TS type; its inferred type is also the `FlatField` processing
 * shape the add-path pipeline types against.
 */
export type GeneratedToolSchemas = {
	addFieldsItemSchema: ReturnType<typeof buildAddFieldsItemSchema>;
	editFieldUpdatesSchema: ReturnType<typeof buildEditFieldUpdatesSchema>;
};

/**
 * Generate the SA field-mutation tool schemas from the field registry.
 * `kinds` defaults to the authoritative `fieldKinds` tuple; tests may pass
 * a subset to exercise generator behavior without pulling in the full
 * registry.
 */
export function generateToolSchemas(
	kinds: readonly FieldKind[] = fieldKinds,
): GeneratedToolSchemas {
	return {
		addFieldsItemSchema: buildAddFieldsItemSchema(kinds),
		editFieldUpdatesSchema: buildEditFieldUpdatesSchema(kinds),
	};
}
