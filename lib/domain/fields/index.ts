// lib/domain/fields/index.ts
//
// Public barrel: Field discriminated union, ContainerField, fieldKinds
// tuple, fieldRegistry, isContainer type guard.
//
// This file is the ONLY place anything outside lib/domain/ imports from
// the fields/ directory. Individual kind files are private.
//
// Per-kind editor schemas live at
// `components/builder/editor/fieldEditorSchemas.ts` rather than here —
// keeping them out of the domain barrel keeps the kind files free of
// UI imports, which is what makes the `fieldKinds`/`fieldRegistry`
// module graph acyclic with the XPathField/reference provider chain.

import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { type AudioField, audioFieldMetadata, audioFieldSchema } from "./audio";
import {
	type BarcodeField,
	barcodeFieldMetadata,
	barcodeFieldSchema,
} from "./barcode";
import type { SelectOption } from "./base";
import { type DateField, dateFieldMetadata, dateFieldSchema } from "./date";
import {
	type DatetimeField,
	datetimeFieldMetadata,
	datetimeFieldSchema,
} from "./datetime";
import {
	type DecimalField,
	decimalFieldMetadata,
	decimalFieldSchema,
} from "./decimal";
import {
	type GeopointField,
	geopointFieldMetadata,
	geopointFieldSchema,
} from "./geopoint";
import { type GroupField, groupFieldMetadata, groupFieldSchema } from "./group";
import {
	type HiddenField,
	hiddenFieldMetadata,
	hiddenFieldSchema,
} from "./hidden";
import { type ImageField, imageFieldMetadata, imageFieldSchema } from "./image";
import { type IntField, intFieldMetadata, intFieldSchema } from "./int";
import { type LabelField, labelFieldMetadata, labelFieldSchema } from "./label";
import {
	type MultiSelectField,
	multiSelectFieldMetadata,
	multiSelectFieldSchema,
} from "./multiSelect";
import {
	type CountBoundRepeatField,
	countBoundRepeatSchema,
	type QueryBoundRepeatField,
	queryBoundRepeatSchema,
	type RepeatField,
	type RepeatMode,
	repeatFieldMetadata,
	repeatFieldSchema,
	repeatModes,
	type UserControlledRepeatField,
	userControlledRepeatSchema,
} from "./repeat";
import {
	type SecretField,
	secretFieldMetadata,
	secretFieldSchema,
} from "./secret";
import {
	type SignatureField,
	signatureFieldMetadata,
	signatureFieldSchema,
} from "./signature";
import {
	type SingleSelectField,
	singleSelectFieldMetadata,
	singleSelectFieldSchema,
} from "./singleSelect";
import { type TextField, textFieldMetadata, textFieldSchema } from "./text";
import { type TimeField, timeFieldMetadata, timeFieldSchema } from "./time";
import { type VideoField, videoFieldMetadata, videoFieldSchema } from "./video";

// Order here defines iteration order for the type picker + docs.
export const fieldKinds = [
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"audio",
	"video",
	"barcode",
	"signature",
	"label",
	"hidden",
	"secret",
	"group",
	"repeat",
] as const;

export type FieldKind = (typeof fieldKinds)[number];

/**
 * Two-arm union over all field kinds. The first arm is a fast
 * `discriminatedUnion("kind", ...)` over every kind EXCEPT repeat; the
 * second arm is `repeatFieldSchema`, itself a `discriminatedUnion` on
 * `repeat_mode` over the three repeat variants.
 *
 * Why split: `z.discriminatedUnion("kind", ...)` requires each member to
 * carry a unique `kind` literal, but the three repeat variants
 * (`user_controlled`, `count_bound`, `query_bound`) all share
 * `kind: "repeat"`. Splitting into a two-arm `z.union` lets each layer
 * use a true discriminated union: the parent narrows on `kind` for
 * non-repeat fields in O(1); when `kind === "repeat"` the parent falls
 * through to the second arm, which narrows on `repeat_mode`, again
 * O(1). Net cost vs. a flat `discriminatedUnion("kind", ...)` is one
 * extra arm-comparison for repeat fields.
 *
 * **Narrowing is two-tiered for repeats.** `kind === "repeat"` selects
 * `RepeatField` (the union of three variants); `repeat_mode` narrows
 * further within that. A flat `switch (f.kind)` cannot reach the three
 * repeat variants directly — it lands on a single repeat case that
 * still has `repeat_mode` as a sub-discriminator. Consumers that need
 * to dispatch on a specific repeat variant must branch on `repeat_mode`
 * after the kind narrowing.
 */
export const fieldSchema = z.union([
	z.discriminatedUnion("kind", [
		textFieldSchema,
		intFieldSchema,
		decimalFieldSchema,
		dateFieldSchema,
		timeFieldSchema,
		datetimeFieldSchema,
		singleSelectFieldSchema,
		multiSelectFieldSchema,
		geopointFieldSchema,
		imageFieldSchema,
		audioFieldSchema,
		videoFieldSchema,
		barcodeFieldSchema,
		signatureFieldSchema,
		labelFieldSchema,
		hiddenFieldSchema,
		secretFieldSchema,
		groupFieldSchema,
	]),
	repeatFieldSchema,
]);

export type Field = z.infer<typeof fieldSchema>;

export type ContainerField = Extract<Field, { kind: "group" | "repeat" }>;

export const fieldRegistry: { [K in FieldKind]: FieldKindMetadata<K> } = {
	text: textFieldMetadata,
	int: intFieldMetadata,
	decimal: decimalFieldMetadata,
	date: dateFieldMetadata,
	time: timeFieldMetadata,
	datetime: datetimeFieldMetadata,
	single_select: singleSelectFieldMetadata,
	multi_select: multiSelectFieldMetadata,
	geopoint: geopointFieldMetadata,
	image: imageFieldMetadata,
	audio: audioFieldMetadata,
	video: videoFieldMetadata,
	barcode: barcodeFieldMetadata,
	signature: signatureFieldMetadata,
	label: labelFieldMetadata,
	hidden: hiddenFieldMetadata,
	secret: secretFieldMetadata,
	group: groupFieldMetadata,
	repeat: repeatFieldMetadata,
};

export type { RepeatMode };
// `RepeatMode` (the three `repeat_mode` discriminator literals) comes
// from `./repeat`, where the `repeatModes` tuple is declared beside the
// variant schemas it names. The repeat kind's schema is a
// `z.discriminatedUnion("repeat_mode", [...])` over those variants —
// each carries its own key set (`repeat_count` for count-bound,
// `data_source` for query-bound) — and the umbrella `repeatFieldSchema`
// has no `.shape` of its own.
export { repeatModes };

/**
 * Per-kind key sets — every property name the `kind`'s schema declares.
 * Built once at module load by reading `.shape` off each kind's
 * `ZodObject` schema. Repeat is the one kind whose schema is a
 * `discriminatedUnion` (one variant per `repeat_mode`); the umbrella
 * entry holds the union of every variant's keys so a consumer that
 * doesn't know the mode yet still has a complete-enough filter to apply
 * before validation. Per-variant key sets live in
 * `repeatVariantKeySets`.
 *
 * Used by `reconcileFieldForKind` to filter a candidate field-shaped
 * object down to the destination kind's schema keys before parsing —
 * dropping properties the destination kind doesn't declare so the parse
 * step is a real validation step rather than a tolerant strip.
 */
const fieldKindKeySets: Record<FieldKind, ReadonlySet<string>> = {
	text: new Set(Object.keys(textFieldSchema.shape)),
	int: new Set(Object.keys(intFieldSchema.shape)),
	decimal: new Set(Object.keys(decimalFieldSchema.shape)),
	date: new Set(Object.keys(dateFieldSchema.shape)),
	time: new Set(Object.keys(timeFieldSchema.shape)),
	datetime: new Set(Object.keys(datetimeFieldSchema.shape)),
	single_select: new Set(Object.keys(singleSelectFieldSchema.shape)),
	multi_select: new Set(Object.keys(multiSelectFieldSchema.shape)),
	geopoint: new Set(Object.keys(geopointFieldSchema.shape)),
	image: new Set(Object.keys(imageFieldSchema.shape)),
	audio: new Set(Object.keys(audioFieldSchema.shape)),
	video: new Set(Object.keys(videoFieldSchema.shape)),
	barcode: new Set(Object.keys(barcodeFieldSchema.shape)),
	signature: new Set(Object.keys(signatureFieldSchema.shape)),
	label: new Set(Object.keys(labelFieldSchema.shape)),
	hidden: new Set(Object.keys(hiddenFieldSchema.shape)),
	secret: new Set(Object.keys(secretFieldSchema.shape)),
	group: new Set(Object.keys(groupFieldSchema.shape)),
	// Repeat is a discriminated union — its umbrella key set is the union
	// of every variant's keys. Consumers that know the mode use the per-
	// variant key set instead.
	repeat: new Set([
		...Object.keys(userControlledRepeatSchema.shape),
		...Object.keys(countBoundRepeatSchema.shape),
		...Object.keys(queryBoundRepeatSchema.shape),
	]),
};

const repeatVariantKeySets: Record<RepeatMode, ReadonlySet<string>> = {
	user_controlled: new Set(Object.keys(userControlledRepeatSchema.shape)),
	count_bound: new Set(Object.keys(countBoundRepeatSchema.shape)),
	query_bound: new Set(Object.keys(queryBoundRepeatSchema.shape)),
};

/**
 * Project an object down to a precomputed set of allowed keys.
 *
 * Used at the boundary between a runtime shape (a doc-store state, a
 * patched field candidate) and a schema-validated entity, where the
 * runtime shape carries known extras (action methods, indices, stale
 * keys from a kind change) the schema doesn't. Filtering before parsing
 * is the explicit alternative to relying on Zod's strip behavior — strip
 * silently dropped unknowns, strict rejects them. Filtering reduces the
 * parse to a real validation step (asserting the picked shape is valid)
 * rather than a projection trick.
 *
 * Callers precompute `allowedKeys` from `Object.keys(schema.shape)` at
 * module load so this helper is a tight loop on the hot path. Returns
 * a fresh `Partial<T>` — every input key is optional in the output, since
 * the picked subset depends on the runtime allowedKeys set.
 */
export function pickByKeys<T extends Record<string, unknown>>(
	source: T,
	allowedKeys: ReadonlySet<string>,
): Partial<T> {
	const picked: Partial<T> = {};
	for (const [key, value] of Object.entries(source)) {
		if (allowedKeys.has(key)) {
			(picked as Record<string, unknown>)[key] = value;
		}
	}
	return picked;
}

/**
 * Filter a candidate field-shaped object to the keys a target kind's
 * schema declares. For non-repeat kinds the lookup is direct; for repeat
 * the variant is selected by `repeat_mode` if present, falling back to
 * the umbrella (every-variant) key set when the mode hasn't been chosen
 * yet. Returns a fresh object — never mutates the source.
 *
 * Two consumers:
 *   - `reconcileFieldForKind`: projects a field into a different kind's
 *     shape during a `convertField` mutation, dropping source-kind keys
 *     the destination doesn't declare.
 *   - The `updateField` reducer: drops stale mode-specific keys when a
 *     repeat-kind patch switches `repeat_mode`. The type-level patch
 *     guard catches cross-kind misuse at compile time, but it can't
 *     reach into the repeat union's `repeat_mode` discriminator — a
 *     spread `{ ...countBound, repeat_mode: "user_controlled" }`
 *     leaves `repeat_count` behind, which the strict per-variant schema
 *     would reject. Filtering here is the targeted runtime cleanup.
 */
export function pickFieldKeysForKind(
	source: Record<string, unknown>,
	toKind: FieldKind,
): Record<string, unknown> {
	const keys =
		toKind === "repeat"
			? pickRepeatKeySet(source.repeat_mode)
			: fieldKindKeySets[toKind];
	return pickByKeys(source, keys);
}

/**
 * Does the given field kind's schema declare `key`? Reads the precomputed
 * per-kind key set, so it answers from the SCHEMA — not from a particular
 * field instance, where an unset optional slot (e.g. an unattached
 * `label_media`) is absent as an own property even though the kind
 * supports it. That distinction is exactly why the media-attach tools
 * can't use `key in field`: a field with no media yet would falsely read
 * as "doesn't support this slot."
 *
 * For `repeat` it uses the umbrella key set (the union across all three
 * modes), since the caller is asking about kind-level support, not a
 * specific mode's variant keys.
 */
export function fieldKindDeclaresKey(kind: FieldKind, key: string): boolean {
	return fieldKindKeySets[kind].has(key);
}

/**
 * Resolve a repeat key set from a (possibly-unknown) `repeat_mode` value.
 * Falls back to the umbrella set when the mode is missing or unknown so
 * the caller can still produce a candidate object — the subsequent parse
 * step surfaces an invalid mode as a real validation failure rather than
 * a silent key drop.
 */
function pickRepeatKeySet(mode: unknown): ReadonlySet<string> {
	if (typeof mode === "string" && mode in repeatVariantKeySets) {
		return repeatVariantKeySets[mode as RepeatMode];
	}
	return fieldKindKeySets.repeat;
}

/** Type guard for container kinds (group, repeat). Used wherever "can this
 *  field have children?" is asked — add/move field reducers, tree walkers,
 *  drag-drop validity checks. */
export function isContainer(f: Field): f is ContainerField {
	return fieldRegistry[f.kind].isContainer;
}

/**
 * The field kinds a given kind can be converted into.
 *
 * Reads directly from `fieldRegistry[kind].convertTargets`, which is the
 * single source of truth for which logical type swaps are supported.
 * Empty array means the kind has no valid conversion targets (the UI
 * disables the convert affordance for those kinds).
 *
 * The UI gates the convert-type menu on this list, and the reducer
 * enforces the same list as a second, authoritative layer — any caller
 * (agent tools, log replay, tests) that tries to dispatch a
 * `convertField` with a destination kind outside this list is rejected
 * rather than silently corrupting state.
 */
export function getConvertibleTypes(kind: FieldKind): readonly FieldKind[] {
	return fieldRegistry[kind].convertTargets;
}

/**
 * Produce a normalized `Field` of `toKind` seeded from `source`.
 *
 * Reconciliation rules — applied in this order:
 *   1. Start with `{ ...source, kind: toKind }` as the candidate shape.
 *   2. When `toKind === "repeat"` and the source has no `repeat_mode`,
 *      seed `user_controlled` — it's the mode that requires no extra
 *      fields, matches the most common authoring intent (group→repeat),
 *      and lets the user pick a different mode after conversion if
 *      needed.
 *   3. Filter the candidate to the destination kind's known keys via
 *      `pickFieldKeysForKind`, dropping any property the destination
 *      schema doesn't declare (e.g. `validate` when going text→geopoint,
 *      `repeat_mode` when going repeat→group).
 *   4. Validate the filtered candidate against `fieldSchema`. A failure
 *      means the source was missing a key the destination requires
 *      (e.g. converting to a count-bound repeat without `repeat_count`)
 *      — return `undefined`, callers treat that as "abort the
 *      conversion" (reducer logs a warning and no-ops).
 *
 * This function is pure — no side effects, no logging. Callers decide
 * how to handle an `undefined` return (reducer logs and no-ops).
 *
 * **Filter, then validate** — the per-kind key sets (built once from
 * each kind's `ZodObject.shape`) are the single source of truth for
 * which keys each kind accepts. Filtering first means the parse step is
 * a real validation (asserting the picked shape is valid) rather than a
 * tolerant strip. Strict object schemas reject unknown keys outright,
 * so filtering is the explicit alternative.
 *
 * The reducer that calls this gates its input on
 * `fieldRegistry[source.kind].convertTargets` first, which rejects
 * structurally destructive cross-paradigm swaps (container ↔ leaf, media
 * ↔ numeric, etc.) that the schema would accept but leave `fieldOrder`
 * or other doc-level invariants corrupted. By the time execution
 * reaches this function the kind pair has already been approved for
 * reconciliation.
 *
 * Special cases:
 *   - `single_select` ↔ `multi_select`: `options` transfers verbatim.
 *   - `text` ↔ `secret` / `barcode`: no options on any — validate /
 *     relevant / required / hint / default_value / case_property_on
 *     carry over (none carries `calculate`; that's a `hidden`-only slot).
 *   - `text` → `single_select`: the select schemas require `options`
 *     (`.min(2)`) and the source has none, so the caller supplies them
 *     via `seed.options` (the `convertField` mutation's payload) — a
 *     seedless attempt fails the parse and the reducer no-ops.
 *   - `text` → `hidden`: label / hint / required / validate drop (hidden
 *     declares none of them); id / case binding / relevant /
 *     default_value survive. The `HIDDEN_NO_VALUE` validator still wants
 *     a `calculate` or `default_value` on the result — the commit gate
 *     adjudicates that, not this function.
 *   - `single_select` → `text`: `options` drops; everything else carries.
 *   - Media subkinds (image/audio/video/signature): identity + label +
 *     hint + required + relevant carry over; no case_property_on, no
 *     validate (not in media schemas today).
 *   - `group` ↔ `repeat`: container; only identity + label + relevant
 *     carry over. Children are untouched — they stay in `fieldOrder`
 *     under the same parent uuid, which is still a valid container after
 *     the kind swap.
 */
/**
 * Whether converting `source` into `toKind` must carry a born option
 * seed on the `convertField` mutation: the destination declares an
 * `options` slot (`.min(2)` in the select schemas) and the source kind
 * has none to transfer. The ONE predicate every batch-building surface
 * (the SA's `editField`, the builder's convert gesture) consults, so
 * the two editors can't drift on when a conversion needs options.
 */
export function convertNeedsOptionSeed(
	source: Field,
	toKind: FieldKind,
): boolean {
	return fieldKindDeclaresKey(toKind, "options") && !("options" in source);
}

export function reconcileFieldForKind(
	source: Field,
	toKind: FieldKind,
	seed?: { options?: readonly SelectOption[] },
): Field | undefined {
	const candidate: Record<string, unknown> = { ...source, kind: toKind };
	// A caller-supplied option seed WINS over source options: it exists
	// for conversions INTO a select kind from a kind with no options
	// slot, where the destination schema requires what the source can't
	// carry. The payload arrives with uuids + order keys already minted
	// (the batch-building layer owns identity), so the reducer stays
	// deterministic for replay.
	if (seed?.options !== undefined) {
		candidate.options = seed.options;
	}
	// Repeat is a discriminated union on `repeat_mode`. When converting
	// FROM a non-repeat kind (most commonly group→repeat), the source
	// has no `repeat_mode` and the union has no default to fall back on.
	// Seeding `user_controlled` BEFORE the key filter ensures
	// `pickFieldKeysForKind` sees the mode and selects the correct
	// per-variant key set.
	if (toKind === "repeat" && candidate.repeat_mode === undefined) {
		candidate.repeat_mode = "user_controlled";
	}
	const filtered = pickFieldKeysForKind(candidate, toKind);
	const result = fieldSchema.safeParse(filtered);
	if (!result.success) {
		return undefined;
	}
	return result.data;
}

/**
 * Drop the immutable `uuid` + `kind` slots from a field-kind schema and
 * make every remaining key optional-and-nullable — the patch shape for an
 * `updateField` mutation. Identity and discriminant are fixed for the
 * lifetime of a field entity; everything else is mutable. Used once
 * per non-repeat kind plus once per repeat variant in
 * `fieldPatchSchemaByKind`.
 *
 * Each value is `.nullable().optional()`, encoding the three patch states:
 *   - absent → leave the property unchanged
 *   - `null` → CLEAR the property (the `updateField` reducer deletes the
 *     key). `null` is the on-the-wire representation of a blank: a patch
 *     value of `undefined` cannot survive JSON serialization
 *     (`JSON.stringify` drops `undefined`-valued keys on both the SSE
 *     wire and the persisted jsonb, and a patch that reduces to empty
 *     is omitted entirely), so a clear-only edit must carry an explicit
 *     `null` to round-trip through the event log.
 *   - a value → set the property
 *
 * The generic carries the source schema's full shape so each call site
 * gets a precisely-typed partial — the per-variant key set survives
 * the projection rather than collapsing to `Record<string, never>`.
 */
function partialOf<
	S extends { uuid: z.ZodTypeAny; kind: z.ZodTypeAny } & z.ZodRawShape,
>(
	schema: z.ZodObject<S>,
): z.ZodObject<{
	[K in Exclude<keyof S, "uuid" | "kind">]: z.ZodOptional<z.ZodNullable<S[K]>>;
}> {
	// `S extends { uuid; kind }` guarantees these slots exist; Zod's
	// `omit()` parameter type encodes "every key in `S` must appear in
	// the mask" (`Record<keyof S, never>` for unmasked keys), which the
	// generic constraint can't satisfy structurally. The runtime call
	// is sound, so cast the mask through `unknown`.
	const omitted = schema.omit({
		uuid: true,
		kind: true,
	} as unknown as Parameters<typeof schema.omit>[0]);
	// Make every remaining value nullable BEFORE `.partial()` wraps it in
	// optional, so the final per-key shape is `optional(nullable(T))`. The
	// explicit return type restores the precise per-variant key set that
	// the `Object.fromEntries` round-trip erases to `Record<string, …>`.
	const nullableShape = Object.fromEntries(
		Object.entries(omitted.shape).map(([key, value]) => [
			key,
			(value as z.ZodTypeAny).nullable(),
		]),
	);
	return z.object(nullableShape).partial() as unknown as z.ZodObject<{
		[K in Exclude<keyof S, "uuid" | "kind">]: z.ZodOptional<
			z.ZodNullable<S[K]>
		>;
	}>;
}

/**
 * Per-kind partial-patch schemas, keyed by `FieldKind`.
 *
 * Each entry validates the `patch` slot of a kind-discriminated
 * `updateField` mutation: any subset of the kind's schema-declared
 * properties, with `uuid` and `kind` forbidden (identity and
 * discriminant are immutable for the lifetime of a field entity).
 * The reducer reads `mut.targetKind` to pick the matching schema —
 * a patch with a key the target kind doesn't declare is rejected at
 * compile time by the discriminated `UpdateFieldMutation` shape, and
 * the runtime parse here is a defense-in-depth check on event-log
 * replay where the producer might be a different version of the app.
 *
 * Repeat is the one kind whose schema is a `discriminatedUnion` over
 * `repeat_mode`; we union the three variants' partial shapes so a
 * patch can carry any mode-specific key (`repeat_count`,
 * `data_source`) alongside the optional `repeat_mode` discriminator.
 * The reducer merges the patch onto the existing repeat field and
 * lets the full `fieldSchema.safeParse` enforce mode-vs-keys
 * coherence (a patch that switches mode without supplying the new
 * mode's required keys surfaces as a parse failure rather than a
 * stray-key drop).
 */
export const fieldPatchSchemaByKind = {
	text: partialOf(textFieldSchema),
	int: partialOf(intFieldSchema),
	decimal: partialOf(decimalFieldSchema),
	date: partialOf(dateFieldSchema),
	time: partialOf(timeFieldSchema),
	datetime: partialOf(datetimeFieldSchema),
	single_select: partialOf(singleSelectFieldSchema),
	multi_select: partialOf(multiSelectFieldSchema),
	geopoint: partialOf(geopointFieldSchema),
	image: partialOf(imageFieldSchema),
	audio: partialOf(audioFieldSchema),
	video: partialOf(videoFieldSchema),
	barcode: partialOf(barcodeFieldSchema),
	signature: partialOf(signatureFieldSchema),
	label: partialOf(labelFieldSchema),
	hidden: partialOf(hiddenFieldSchema),
	secret: partialOf(secretFieldSchema),
	group: partialOf(groupFieldSchema),
	repeat: z.union([
		partialOf(userControlledRepeatSchema),
		partialOf(countBoundRepeatSchema),
		partialOf(queryBoundRepeatSchema),
	]),
} as const satisfies { [K in FieldKind]: z.ZodTypeAny };

/**
 * Type-level shape of an `updateField` mutation's `patch` slot for a
 * field of kind `K` — the mutable, schema-declared properties of the
 * variant minus the immutable identity (`uuid`) and discriminant
 * (`kind`). Pairs with `fieldPatchSchemaByKind` (the runtime Zod
 * schema for the same shape).
 *
 * Every property is optional and `| null`: absent leaves it unchanged,
 * `null` clears it (the reducer deletes the key), a value sets it. `null`
 * is the wire representation of a blank — see `partialOf` for why a clear
 * cannot be carried as `undefined` through the event log.
 *
 * Distributes over a wider `K` to give a union of per-variant
 * partials, so callers can write `FieldPatchFor<F["kind"]>` against
 * a generic field whose kind is narrowed downstream.
 */
export type FieldPatchFor<K extends FieldKind> = {
	[P in keyof Omit<Extract<Field, { kind: K }>, "uuid" | "kind">]?:
		| Omit<Extract<Field, { kind: K }>, "uuid" | "kind">[P]
		| null;
};

export type { SelectOption } from "./base";
// Re-export the shared option shape (used by single_select + multi_select,
// and by the SA tool schema generator for the `options` field on select tools).
export { DEFAULT_SELECT_OPTIONS, selectOptionSchema } from "./base";

// Re-export individual kind types for downstream switch blocks.
export type {
	AudioField,
	BarcodeField,
	CountBoundRepeatField,
	DateField,
	DatetimeField,
	DecimalField,
	GeopointField,
	GroupField,
	HiddenField,
	ImageField,
	IntField,
	LabelField,
	MultiSelectField,
	QueryBoundRepeatField,
	RepeatField,
	SecretField,
	SignatureField,
	SingleSelectField,
	TextField,
	TimeField,
	UserControlledRepeatField,
	VideoField,
};
