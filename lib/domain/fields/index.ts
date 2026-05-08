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
	repeatFieldMetadata,
	repeatFieldSchema,
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

/**
 * The three repeat-mode discriminator literals. The repeat kind's schema
 * is a `z.discriminatedUnion("repeat_mode", [...])` over these three
 * variants — each carries its own key set (`repeat_count` for count-
 * bound, `data_source` for query-bound) — and the umbrella
 * `repeatFieldSchema` has no `.shape` of its own.
 */
type RepeatMode = "user_controlled" | "count_bound" | "query_bound";

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
 * a fresh object — never mutates the source.
 */
export function pickByKeys(
	source: Record<string, unknown>,
	allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (allowedKeys.has(key)) picked[key] = value;
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
 *      schema doesn't declare (e.g. `calculate` when going text→secret,
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
 *   - `text` ↔ `secret`: no options, no calculate on secret — validate/
 *     relevant/required/hint/case_property_on carry over.
 *   - Media subkinds (image/audio/video/signature): identity + label +
 *     hint + required + relevant carry over; no calculate, no
 *     case_property_on, no validate (not in media schemas today).
 *   - `group` ↔ `repeat`: container; only identity + label + relevant
 *     carry over. Children are untouched — they stay in `fieldOrder`
 *     under the same parent uuid, which is still a valid container after
 *     the kind swap.
 */
export function reconcileFieldForKind(
	source: Field,
	toKind: FieldKind,
): Field | undefined {
	const candidate: Record<string, unknown> = { ...source, kind: toKind };
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
	text: textFieldSchema.omit({ uuid: true, kind: true }).partial(),
	int: intFieldSchema.omit({ uuid: true, kind: true }).partial(),
	decimal: decimalFieldSchema.omit({ uuid: true, kind: true }).partial(),
	date: dateFieldSchema.omit({ uuid: true, kind: true }).partial(),
	time: timeFieldSchema.omit({ uuid: true, kind: true }).partial(),
	datetime: datetimeFieldSchema.omit({ uuid: true, kind: true }).partial(),
	single_select: singleSelectFieldSchema
		.omit({ uuid: true, kind: true })
		.partial(),
	multi_select: multiSelectFieldSchema
		.omit({ uuid: true, kind: true })
		.partial(),
	geopoint: geopointFieldSchema.omit({ uuid: true, kind: true }).partial(),
	image: imageFieldSchema.omit({ uuid: true, kind: true }).partial(),
	audio: audioFieldSchema.omit({ uuid: true, kind: true }).partial(),
	video: videoFieldSchema.omit({ uuid: true, kind: true }).partial(),
	barcode: barcodeFieldSchema.omit({ uuid: true, kind: true }).partial(),
	signature: signatureFieldSchema.omit({ uuid: true, kind: true }).partial(),
	label: labelFieldSchema.omit({ uuid: true, kind: true }).partial(),
	hidden: hiddenFieldSchema.omit({ uuid: true, kind: true }).partial(),
	secret: secretFieldSchema.omit({ uuid: true, kind: true }).partial(),
	group: groupFieldSchema.omit({ uuid: true, kind: true }).partial(),
	repeat: z.union([
		userControlledRepeatSchema.omit({ uuid: true, kind: true }).partial(),
		countBoundRepeatSchema.omit({ uuid: true, kind: true }).partial(),
		queryBoundRepeatSchema.omit({ uuid: true, kind: true }).partial(),
	]),
} as const satisfies { [K in FieldKind]: z.ZodTypeAny };

export type { SelectOption } from "./base";
// Re-export the shared option shape (used by single_select + multi_select,
// and by the SA tool schema generator for the `options` field on select tools).
export { selectOptionSchema } from "./base";

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
