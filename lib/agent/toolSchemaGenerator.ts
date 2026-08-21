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
// on the tool surface. Case-writing fields (`caseWrite` set) are the
// one exemption from the label/options floors: those slots inherit from
// the field's catalog record (`applyDefaults` seeds them after parse), so
// omitting them is the normal, instructed shape — stated values are
// overrides.
//
// ## Vocabulary
//
// The SA speaks domain vocabulary end-to-end: `kind`, `validate`,
// `validate_msg`, `caseWrite`. There is no translation layer between
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
	CAPTURE_CASE_WRITE_MODES,
	caseWriteSchema,
	fieldKindDeclaresKey,
	fieldKinds,
	fieldRegistry,
	isCaptureFieldKind,
	lookupOptionsSourceSchema,
	proseTemplateSchema,
	SELECT_OPTION_VALUE_DESCRIPTION,
	SELECT_OPTION_VALUE_PATTERN,
	SELECT_OPTION_VALUE_REJECTION,
	uuidSchema,
	xpathExpressionSchema,
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
			"Field kind — pick the most specific for the data. The per-kind " +
				'guide is the "Field kinds" section of the agent instructions: ' +
				"the system prompt in chat, the get_agent_prompt tool on MCP.",
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
// Field names here are the domain names (`validate`, `caseWrite`,
// …). If we ever flip to per-type tools (one schema per kind), these
// strings still apply — they carry the per-property guidance, not the
// per-kind shape.

const FIELD_DOCS = {
	id:
		"snake_case identifier, letter first. Names this question in the form " +
		"and in friendly XPath such as #form/first_name. It is independent " +
		"from any case property the answer writes.",
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
	optionsSource:
		'Choice source. Use kind "inline" with at least 2 options, or kind ' +
		'"lookup" with stable table/column UUIDs and an optional canonical filter. ' +
		"Each inline option's `value` is the stored answer token, a lowercase " +
		"underscore-joined slug (prefer_not_to_say) with no spaces or quotes; " +
		"its `label` carries the wording.",
	caseWrite:
		"Complete case destination for this answer. `caseType` names the case " +
		"type and `property` names the property on that type. The module's own " +
		"type writes its primary case; a different type creates a child case " +
		"(that child needs a writer whose `property` is `case_name`). The field " +
		"id may differ from the property. Attachment kinds (image, audio, " +
		'video, signature, file) additionally require `mode: "url"`, which ' +
		"saves a link to the attached file, and cannot write `case_name` or " +
		"`external_id`. The link is the only way back to the file: CommCare " +
		"never displays a case attachment inside the app, on either client. " +
		"Every other kind must leave `mode` out.",
	repeat_mode:
		'"user_controlled" — user adds/removes rows at fill. "count_bound" ' +
		'— row count from `count`. "query_bound" — one row per case id ' +
		"from `ids_query`. Counts and queries freeze at form load.",
	repeat_count: "XPath giving the row count (count_bound only).",
	ids_query: "XPath resolving to the case ids to iterate (query_bound only).",
} as const satisfies Record<string, string>;

// ── Reusable Zod field primitives ───────────────────────────────────
//
// Each generic helper returns a fresh Zod schema — never share an instance
// across multiple generator outputs, because downstream consumers
// (e.g. `z.toJSONSchema`) mutate the Zod node's internal cache and a
// shared instance can leak that cache between tools. The one deliberate
// exception is `projectedOptionsSourceSchema`: its machine contract must be one
// exported schema/type across all four field writers, and it is materialized
// once alongside the generated schemas in `toolSchemas.ts`.

const idField = () => z.string().describe(FIELD_DOCS.id);

const fieldUuidField = () =>
	uuidSchema
		.optional()
		.describe(
			"Stable field UUID. Required when another item in this call references this field; otherwise omit to let Nova mint it.",
		);

// Topology is identity-addressed. A same-call parent must be predeclared and
// appear earlier in the list; null/omission means the form root.
const parentUuidField = () =>
	uuidSchema
		.nullable()
		.optional()
		.describe(
			"Stable UUID of the parent group, repeat, or section. Pass null to insert at the form root. A parent created in this call must declare fieldUuid and appear earlier.",
		);

// `label` is nullable on the shape; the kind policy (see the builders
// below) requires a real, non-empty label on every visible kind and
// rejects one on `hidden`. The containers (`group` / `repeat`) accept
// null/""/absent — `stripEmpty` collapses the "" to absent before
// assembly.
const labelField = () =>
	proseTemplateSchema.nullable().optional().describe(FIELD_DOCS.label);

// Optional shape primitives — all NULLABLE, shared by BOTH tool surfaces
// (the shapes are identical; only the null semantics differ, and those
// live in the pipeline/reducer, not the shape): on the add path `null`
// reads exactly like omission ("nothing here"; the pipeline collapses it
// to absence via `stripEmpty`), so arbitrary MCP callers and stray nulls
// are harmless; on the edit patch `null` CLEARS the slot (the reducer
// deletes the key) and omission keeps the current value. `validate` and
// `repeat` are nested objects that group related config (expr+msg,
// mode+count/ids_query) into one field each, keeping the item shape flat
// and easy for the SA to fill.
const requiredField = () =>
	xpathExpressionSchema.nullable().optional().describe(FIELD_DOCS.required);
const hintField = () =>
	proseTemplateSchema.nullable().optional().describe(FIELD_DOCS.hint);
const helpField = () =>
	proseTemplateSchema.nullable().optional().describe(FIELD_DOCS.help);
const relevantField = () =>
	xpathExpressionSchema.nullable().optional().describe(FIELD_DOCS.relevant);
const calculateField = () =>
	xpathExpressionSchema.nullable().optional().describe(FIELD_DOCS.calculate);
const defaultValueField = () =>
	xpathExpressionSchema
		.nullable()
		.optional()
		.describe(FIELD_DOCS.default_value);
/**
 * The exact machine-authored inline-option projection.
 *
 * Persisted options carry `{ uuid, value, label, media? }`, but machine
 * writers deliberately get only `{ optionUuid?, value, label }`:
 * `optionUuid` is the creation/preservation handle, while `uuid`, `media`,
 * and every historical alias are unknown-key rejections. Dedicated media
 * tools remain the sole owner of option media.
 */
export const projectedSelectOptionSchema = z
	.object({
		optionUuid: uuidSchema
			.optional()
			.describe(
				"Stable UUID for this option. Supply it when preserving an existing option or when another same-call value refers to it; otherwise Nova mints it.",
			),
		value: z
			.string()
			.regex(SELECT_OPTION_VALUE_PATTERN, SELECT_OPTION_VALUE_REJECTION)
			.describe(SELECT_OPTION_VALUE_DESCRIPTION),
		label: proseTemplateSchema.describe(
			"What people read for this choice. Put the wording here, never in `value`.",
		),
	})
	.strict();

/**
 * One canonical projected select-source contract shared by add_fields,
 * create_form, create_module, and edit_field. The lookup arm is the stored
 * canonical identity shape; no table/column UUID aliases are admitted.
 */
export const projectedOptionsSourceSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("inline"),
				options: z.array(projectedSelectOptionSchema).min(2),
			})
			.strict(),
		lookupOptionsSourceSchema,
	])
	.describe(FIELD_DOCS.optionsSource);

export type ProjectedOptionsSource = z.infer<
	typeof projectedOptionsSourceSchema
>;

const optionsSourceField = () => projectedOptionsSourceSchema;

// Nested-object factories — return the bare object so callers wrap it
// with `.optional()` (add tools) or `.nullable().optional()` (edit
// patch). The "never share an instance across generator outputs" rule
// applies: each call returns a fresh schema so downstream JSON-schema
// generation (which mutates Zod node caches) doesn't leak between tools.
const validateConfigField = () =>
	z
		.object({
			expr: xpathExpressionSchema.describe(FIELD_DOCS.validate),
			msg: proseTemplateSchema.optional().describe(FIELD_DOCS.validate_msg),
		})
		.describe(
			"Validation config. `expr` is the XPath that must hold true; " +
				"`msg` is the error message shown when it doesn't. Omit the " +
				"object entirely to skip validation.",
		);

/**
 * One flat case destination covering both domain shapes.
 *
 * `mode` is optional HERE and required by the per-kind rule below, rather
 * than the schema splitting into a union: the flat object is what the
 * provider's strict-mode normalization handles predictably, and per-kind
 * legality is what `superRefine` is for on every other slot in this file.
 * The domain schemas stay strict — an attachment destination without a mode
 * is unrepresentable there — so this boundary refuses the same shapes, it
 * just refuses them with a sentence instead of a union mismatch.
 */
const caseWriteToolSchema = caseWriteSchema
	.extend({
		mode: z.enum(CAPTURE_CASE_WRITE_MODES).optional(),
	})
	.strict();

const caseWriteField = () =>
	caseWriteToolSchema.nullable().optional().describe(FIELD_DOCS.caseWrite);

/**
 * `mode` belongs to exactly the kinds whose answer is a file.
 *
 * An attachment's answer is a server-minted file name, so what reaches the
 * case is a decision the author has to make; every other kind's answer IS
 * the case value and has nothing to decide.
 */
function gateCaseWriteMode(
	ctx: z.RefinementCtx,
	kind: FieldKind,
	caseWrite: { readonly mode?: string } | null | undefined,
): void {
	if (caseWrite == null) return;
	const isCapture = isCaptureFieldKind(kind);
	if (isCapture && caseWrite.mode === undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["caseWrite", "mode"],
			message:
				`kind "${kind}" saves a file, so its case destination needs a ` +
				`\`mode\`: "url" saves a link to the attached file.`,
		});
	}
	if (!isCapture && caseWrite.mode !== undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["caseWrite", "mode"],
			message:
				`kind "${kind}" saves its answer to the case directly, so its ` +
				`case destination carries no \`mode\` — leave it out.`,
		});
	}
}

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
					count: xpathExpressionSchema.describe(FIELD_DOCS.repeat_count),
				})
				.describe("Fixed count from an XPath — provide `count`."),
			z
				.object({
					mode: z.literal("query_bound"),
					ids_query: xpathExpressionSchema.describe(FIELD_DOCS.ids_query),
				})
				.describe("Iterate case-database query results — provide `ids_query`."),
		])
		.describe(FIELD_DOCS.repeat_mode);
}

/**
 * Slots whose presence is gated per kind through `fieldKindDeclaresKey`.
 * `id` / `kind` / `fieldUuid` / `parentUuid` are tool-level, and
 * `repeat` is gated on `kind === "repeat"` directly — the domain flattens
 * its config into `repeat_mode`/`repeat_count`/`data_source`, so there is
 * no single declared key to ask the registry about.
 */
const ADD_GATED_KEYS = [
	"label",
	"hint",
	"help",
	"required",
	"relevant",
	"validate",
	"calculate",
	"default_value",
	"optionsSource",
	"caseWrite",
] as const;

const EDIT_GATED_KEYS = ADD_GATED_KEYS;

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
 * for their `fields` arrays). Each item carries an optional stable `fieldUuid`
 * plus a `parentUuid`, so same-call construction uses the final identity
 * vocabulary. The kind policy enforces per-kind requiredness the
 * flat shape can't state: a non-empty `label` on every visible kind, ≥2
 * `options` on the selects (case-bound fields exempt from both floors —
 * their catalog record seeds canonical label and choice catalog), a `repeat`
 * config on `repeat` —
 * and rejects any slot the kind doesn't declare.
 */
function buildAddFieldsItemSchema(kinds: readonly FieldKind[]) {
	return z
		.object({
			kind: makeKindEnum(kinds),
			id: idField(),
			fieldUuid: fieldUuidField(),
			parentUuid: parentUuidField(),
			label: labelField(),
			hint: hintField(),
			help: helpField(),
			required: requiredField(),
			relevant: relevantField(),
			validate: validateConfigField().nullable().optional(),
			calculate: calculateField(),
			default_value: defaultValueField(),
			optionsSource: optionsSourceField().nullable().optional(),
			caseWrite: caseWriteField(),
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
			// A case-writing field (`caseWrite` set) INHERITS label /
			// optionsSource / validation / required from its catalog record —
			// `applyDefaults` seeds them after this parse, and the prompt
			// teaches stating those slots only to override. Absence is
			// therefore legal exactly when the field is case-bound; a record
			// gap (a select bound to a property recorded without options)
			// still fails the per-kind assembly parse downstream, naming the
			// offending field.
			// An attachment's destination is a URL property this very write
			// creates, so there is no catalog record to inherit a label from.
			const caseBound =
				item.caseWrite != null && !isCaptureFieldKind(item.kind);
			if (
				fieldKindDeclaresKey(item.kind, "label") &&
				!fieldRegistry[item.kind].isContainer &&
				(item.label == null || item.label.parts.length === 0) &&
				!caseBound
			) {
				ctx.addIssue({
					code: "custom",
					path: ["label"],
					message: `kind "${item.kind}" needs a \`label\` ProseTemplate — the end user reads it.`,
				});
			}
			// Missing optionsSource is fine on a case-bound field (the record's
			// list seeds an inline source). A stated inline arm is already
			// structurally required to carry at least two complete options.
			if (
				fieldKindDeclaresKey(item.kind, "optionsSource") &&
				item.optionsSource == null &&
				!caseBound
			) {
				ctx.addIssue({
					code: "custom",
					path: ["optionsSource"],
					message: `kind "${item.kind}" needs an \`optionsSource\` arm.`,
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
			gateCaseWriteMode(ctx, item.kind, item.caseWrite);
			gateRepeatSlot(ctx, item.kind, item.repeat);
		});
}

/**
 * The `editField` patch shape. Every clearable key is
 * `.nullable().optional()` — omitted = keep the current value, a value =
 * set, `null` = CLEAR the property. The edit and creation paths expose the
 * same field-content slots; only their null semantics differ.
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
			label: labelField(),
			hint: hintField(),
			help: helpField(),
			required: requiredField(),
			relevant: relevantField(),
			validate: validateConfigField().nullable().optional(),
			calculate: calculateField(),
			default_value: defaultValueField(),
			// A select source is required state and cannot be cleared. Omission
			// keeps it; a value atomically replaces the complete arm.
			optionsSource: optionsSourceField().optional(),
			caseWrite: caseWriteField(),
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
			gateCaseWriteMode(ctx, patch.kind, patch.caseWrite);
			gateRepeatSlot(ctx, patch.kind, patch.repeat);
		});
}

/**
 * Bundle of generated SA tool schemas. The `addFieldsItemSchema` is the
 * per-item shape used inside `z.array(...)` for the batch-add tool —
 * exposed separately so consumers that wrap it in their own input
 * schema (which adds the canonical module/form UUID address) can reuse the same
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
