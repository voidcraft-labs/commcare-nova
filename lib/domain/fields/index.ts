// lib/domain/fields/index.ts
//
// Public barrel: Field discriminated union, ContainerField, fieldKinds
// tuple, fieldRegistry, fieldEditorSchemas, isContainer type guard.
//
// This file is the ONLY place anything outside lib/domain/ imports from
// the fields/ directory. Individual kind files are private.

import { z } from "zod";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import {
	type AudioField,
	audioFieldEditorSchema,
	audioFieldMetadata,
	audioFieldSchema,
} from "./audio";
import {
	type BarcodeField,
	barcodeFieldEditorSchema,
	barcodeFieldMetadata,
	barcodeFieldSchema,
} from "./barcode";
import {
	type DateField,
	dateFieldEditorSchema,
	dateFieldMetadata,
	dateFieldSchema,
} from "./date";
import {
	type DatetimeField,
	datetimeFieldEditorSchema,
	datetimeFieldMetadata,
	datetimeFieldSchema,
} from "./datetime";
import {
	type DecimalField,
	decimalFieldEditorSchema,
	decimalFieldMetadata,
	decimalFieldSchema,
} from "./decimal";
import {
	type GeopointField,
	geopointFieldEditorSchema,
	geopointFieldMetadata,
	geopointFieldSchema,
} from "./geopoint";
import {
	type GroupField,
	groupFieldEditorSchema,
	groupFieldMetadata,
	groupFieldSchema,
} from "./group";
import {
	type HiddenField,
	hiddenFieldEditorSchema,
	hiddenFieldMetadata,
	hiddenFieldSchema,
} from "./hidden";
import {
	type ImageField,
	imageFieldEditorSchema,
	imageFieldMetadata,
	imageFieldSchema,
} from "./image";
import {
	type IntField,
	intFieldEditorSchema,
	intFieldMetadata,
	intFieldSchema,
} from "./int";
import {
	type LabelField,
	labelFieldEditorSchema,
	labelFieldMetadata,
	labelFieldSchema,
} from "./label";
import {
	type MultiSelectField,
	multiSelectFieldEditorSchema,
	multiSelectFieldMetadata,
	multiSelectFieldSchema,
} from "./multiSelect";
import {
	type RepeatField,
	repeatFieldEditorSchema,
	repeatFieldMetadata,
	repeatFieldSchema,
} from "./repeat";
import {
	type SecretField,
	secretFieldEditorSchema,
	secretFieldMetadata,
	secretFieldSchema,
} from "./secret";
import {
	type SignatureField,
	signatureFieldEditorSchema,
	signatureFieldMetadata,
	signatureFieldSchema,
} from "./signature";
import {
	type SingleSelectField,
	singleSelectFieldEditorSchema,
	singleSelectFieldMetadata,
	singleSelectFieldSchema,
} from "./singleSelect";
import {
	type TextField,
	textFieldEditorSchema,
	textFieldMetadata,
	textFieldSchema,
} from "./text";
import {
	type TimeField,
	timeFieldEditorSchema,
	timeFieldMetadata,
	timeFieldSchema,
} from "./time";
import {
	type VideoField,
	videoFieldEditorSchema,
	videoFieldMetadata,
	videoFieldSchema,
} from "./video";

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

export const fieldSchema = z.discriminatedUnion("kind", [
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

export const fieldEditorSchemas: {
	[K in FieldKind]: FieldEditorSchema<Extract<Field, { kind: K }>>;
} = {
	text: textFieldEditorSchema,
	int: intFieldEditorSchema,
	decimal: decimalFieldEditorSchema,
	date: dateFieldEditorSchema,
	time: timeFieldEditorSchema,
	datetime: datetimeFieldEditorSchema,
	single_select: singleSelectFieldEditorSchema,
	multi_select: multiSelectFieldEditorSchema,
	geopoint: geopointFieldEditorSchema,
	image: imageFieldEditorSchema,
	audio: audioFieldEditorSchema,
	video: videoFieldEditorSchema,
	barcode: barcodeFieldEditorSchema,
	signature: signatureFieldEditorSchema,
	label: labelFieldEditorSchema,
	hidden: hiddenFieldEditorSchema,
	secret: secretFieldEditorSchema,
	group: groupFieldEditorSchema,
	repeat: repeatFieldEditorSchema,
};

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
 *   1. Start with the source field's shared identity (`uuid`, `id`, `label`).
 *   2. Carry over any property whose key exists on BOTH kinds (validation,
 *      relevancy, required, case_property, calculate, default_value, hint
 *      — depending on what the destination kind accepts).
 *   3. Stamp the new `kind` discriminator.
 *   4. Run the result through `fieldSchema.safeParse` to strip keys the
 *      destination kind doesn't recognize and validate values.
 *   5. If parsing fails (e.g. destination kind requires a key the source
 *      doesn't have), return `undefined`. Callers treat that as "abort
 *      the conversion" (reducer logs a warning and no-ops).
 *
 * This function is pure — no side effects, no logging. Callers decide
 * how to handle an `undefined` return (reducer logs and no-ops).
 *
 * Why `fieldSchema.safeParse` instead of a hand-rolled per-kind table:
 * the Zod schemas are already the single source of truth for which keys
 * each kind accepts. A parallel table here would drift. The schema's
 * default behavior (strip unknowns, reject invalid types) is exactly the
 * reconciliation policy we want.
 *
 * The reducer that calls this gates its input on
 * `fieldRegistry[source.kind].convertTargets` first, which rejects
 * structurally destructive cross-paradigm swaps (container ↔ leaf, media
 * ↔ numeric, etc.) that Zod would accept but leave `fieldOrder` or other
 * doc-level invariants corrupted. By the time execution reaches this
 * function the kind pair has already been approved for reconciliation.
 *
 * Special cases:
 *   - `single_select` ↔ `multi_select`: `options` transfers verbatim.
 *   - `text` ↔ `secret`: no options, no calculate on secret — validate/
 *     relevant/required/hint/case_property carry over.
 *   - Media subkinds (image/audio/video/signature): identity + label +
 *     hint + required + relevant carry over; no calculate, no
 *     case_property, no validate (not in media schemas today).
 *   - `group` ↔ `repeat`: container; only identity + label + relevant
 *     carry over. Children are untouched — they stay in `fieldOrder`
 *     under the same parent uuid, which is still a valid container after
 *     the kind swap.
 */
export function reconcileFieldForKind(
	source: Field,
	toKind: FieldKind,
): Field | undefined {
	// Build a candidate object from the source with the new discriminant.
	// Spread source first so its keys populate; override `kind` last.
	// Zod's default strip behavior will drop any keys the target kind
	// doesn't recognize, and reject the whole parse if required keys are
	// absent — which is the reconciliation policy we want.
	const candidate = { ...source, kind: toKind };
	const result = fieldSchema.safeParse(candidate);
	if (!result.success) {
		return undefined;
	}
	return result.data;
}

/**
 * Union-wide patch type for field entities.
 *
 * `Partial<Omit<Field, "uuid">>` is intuitive but useless here: because
 * `Field` is a discriminated union where different variants carry different
 * properties (e.g. `HiddenField` has no `label`), a plain object literal
 * like `{ label: "..." }` fails to satisfy `Partial<HiddenField>`, and TS
 * rejects the patch even though `Object.assign` handles it fine at runtime.
 *
 * `FieldPatch` resolves this by taking the union of every variant's partial
 * shape. A literal that matches ANY variant's partial will satisfy the
 * union, which is exactly the contract the reducer enforces (it never
 * changes `kind`, only merges known scalar properties).
 *
 * The `uuid` and `kind` fields are excluded — identity and discriminant are
 * immutable for the lifetime of a field entity.
 */
export type FieldPatch = {
	[K in FieldKind]: Partial<Omit<Extract<Field, { kind: K }>, "uuid" | "kind">>;
}[FieldKind];

// Re-export the shared option shape (used by single_select + multi_select).
export type { SelectOption } from "./base";

// Re-export individual kind types for downstream switch blocks.
export type {
	AudioField,
	BarcodeField,
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
	RepeatField,
	SecretField,
	SignatureField,
	SingleSelectField,
	TextField,
	TimeField,
	VideoField,
};
