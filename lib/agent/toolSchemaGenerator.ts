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
// ## Omission keeps, null clears
//
// Tool calls run non-strict (`strict: false` in the SA wrappers), so the
// model omits any slot it isn't touching. On the ADD item, `null` is the
// same as omission — "nothing here" — collapsed to absence by the
// pipeline (`stripEmpty`). On the EDIT patch the two differ: an omitted
// slot keeps its current value; an explicit `null` CLEARS it (the
// reducer deletes the key). Slots that cannot be cleared (`id`, `kind`,
// `repeat` — a repeat always has a mode) are not nullable on the edit
// patch, so a stray null there is a parse rejection, never a wipe. The
// prompt and every slot description teach the same contract.
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
 * The per-kind guide — one line per kind from `fieldRegistry[kind].saDocs`
 * — stated ONCE in the system prompt ("Field kinds"); the tool schemas'
 * `kind` enums carry a pointer, not the guide. Adding a new kind to
 * `fieldKinds` propagates automatically.
 */
export function fieldKindGuide(): string {
	return fieldKinds
		.map((k) => `- \`${k}\`: ${fieldRegistry[k].saDocs}`)
		.join("\n");
}

function makeKindEnum(kinds: readonly FieldKind[]) {
	return z
		.enum(kinds as readonly [FieldKind, ...FieldKind[]])
		.describe(
			"Field kind — pick the most specific for the data (the guide: " +
				'"Field kinds" in your instructions).',
		);
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
		"snake_case identifier, letter first. Becomes the XForm node name " +
		"and (with case_property_on) the case-property key.",
	label:
		"User-facing label — markdown and hashtag references OK, never " +
		'{curly} templates. An explicit "" makes a group transparent and a ' +
		"repeat titleless.",
	hint: "Short helper text under the input.",
	help: "Longer tap-to-expand guidance. Plain text.",
	required: 'XPath condition making an answer mandatory — "true()" for always.',
	validate:
		"XPath rule the answer must satisfy (`.` is the answer), checked " +
		"when the user leaves the field. Write the real rule for the " +
		"field's meaning.",
	validate_msg: "Error shown when `validate` fails.",
	relevant: "XPath condition that shows/hides the field.",
	calculate:
		"XPath recomputed whenever a referenced field changes. hidden " +
		"fields only — for a value fixed at load, use default_value.",
	default_value:
		"XPath evaluated ONCE at form load, never recomputed. For values " +
		"that must track other fields, use calculate.",
	options: "The choice list — at least 2 options.",
	case_property_on:
		"Case type this field saves to. The module's own type = a normal " +
		"case property; a different type creates a child case (its " +
		'case-name writer must have id "case_name"). Never on media kinds.',
	repeat_mode:
		'"user_controlled" — user adds/removes rows at fill. "count_bound" ' +
		'— row count from `count`. "query_bound" — one row per case id ' +
		"from `ids_query`. Counts and queries freeze at form load.",
	repeat_count: "XPath giving the row count (count_bound only).",
	ids_query: "XPath resolving to the case ids to iterate (query_bound only).",
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

// Optional shape primitives — all NULLABLE, and on the add path `null`
// reads exactly like omission ("nothing here"; the pipeline collapses it
// to absence via `stripEmpty`), so arbitrary MCP callers and stray nulls
// are harmless. `validate` and `repeat` are nested objects
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

// Nullable variants for the edit patch: a value sets the property,
// `null` CLEARS it (the reducer deletes the key), omission keeps the
// current value.
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
		message: `kind "${kind}" carries no \`${key}\` slot — leave ${key} out.`,
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
			message: `only kind "repeat" carries a \`repeat\` config — leave it out.`,
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
 * The `editField` patch shape. Every clearable key is
 * `.nullable().optional()` — omitted = keep the current value, a value =
 * set, `null` = CLEAR the property — and `help` (longer-form text the
 * add tool omits) is a slot for kinds that declare it.
 *
 * `kind` is REQUIRED: the SA states the field's CURRENT kind to edit in
 * place, or a different convertible kind to convert it. That's what the
 * kind policy validates the patch against — so the SA can't, say, set
 * `calculate` on a `single_select`. The per-kind guide lives on the
 * `addFields` items' `kind`; this one carries the edit framing alone.
 *
 * `id` and `repeat` are NOT nullable: an id can't be cleared (leave it
 * out to keep it), and a repeat always has a mode — "clear the repeat
 * config" is meaningless; switch modes by passing a new `repeat` object
 * (the reducer drops the prior mode's mode-specific field).
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
				.optional()
				.describe("New id to rename to; leave it out to keep the current id."),
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
			repeat: repeatConfigDiscriminated().optional(),
			// `.strict()` — same boundary rejection as the add item: a key
			// outside the shape is an error, not a silent strip.
		})
		.strict()
		.superRefine((patch, ctx) => {
			for (const key of EDIT_GATED_KEYS) {
				// Any PRESENT value — null included — on a slot the kind
				// doesn't declare rejects: there's nothing there to set OR
				// clear, and a stray null must never read as intent.
				if (
					patch[key] !== undefined &&
					!fieldKindDeclaresKey(patch.kind, key)
				) {
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
