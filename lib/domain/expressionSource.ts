// lib/domain/expressionSource.ts
//
// The one READ accessor for expression-bearing slots — the xpath and
// prose surfaces of the reference-slot registry. Every consumer of an
// expression's SOURCE TEXT (the deep validator's scans, the preview
// engine's dependency extraction and evaluation, blueprint search,
// the emitters via `lib/commcare/fieldProps.ts::readFieldString`)
// reads through here instead of indexing the entity directly — a
// change to how a slot stores its expression swaps this module's
// implementation, never its call sites.
//
// Slot vocabulary comes from `referenceSlots.ts` — slot ids, key
// paths, and per-kind applicability are the registry's, never a
// second hand-rolled key list. Module-level expression slots are
// deliberately absent: every module slot is already a structured AST
// (`predicate-ast`) or a bare name ref, so there is no expression
// source text to read.
//
// Reads are TOTAL over the stored value: the accessor returns
// whatever string the slot path resolves to (including the empty
// string) and `undefined` for anything else, without consulting
// per-kind applicability — mirroring the direct property reads it
// replaces, so hand-built or partial docs that bypass Zod behave
// exactly as before. Applicability gating lives only in the
// registry-projection iterator (`expressionSurfaceReads`), whose
// callers want "the slots a field of this kind carries".

import type { Field } from "./fields";
import type { Form } from "./forms";
import {
	FIELD_REFERENCE_SLOTS,
	type FieldProseSlotId,
	type FieldReferenceSlot,
	type FieldXPathSlotId,
	FORM_REFERENCE_SLOTS,
	fieldSlotApplies,
	type ReferenceSurfaceKind,
	readSlotStrings,
	type SlotStringEntry,
} from "./referenceSlots";

type FieldSlotEntry = (typeof FIELD_REFERENCE_SLOTS)[number];
type FormSlotEntry = (typeof FORM_REFERENCE_SLOTS)[number];

type FieldExpressionSlotEntry = Extract<
	FieldSlotEntry,
	{ kind: "xpath" | "prose" }
>;
type FormExpressionSlotEntry = Extract<
	FormSlotEntry,
	{ kind: "xpath" | "prose" }
>;

/** A slot path with at least one `[]` fan-out step. */
type FanOutPath = `${string}[]${string}`;
type ScalarEntry<E extends { path: string }> = E extends { path: FanOutPath }
	? never
	: E;

/** Every expression-bearing field slot id (xpath + prose). */
export type FieldExpressionSlotId = FieldExpressionSlotEntry["slot"];

/**
 * Field expression slots that resolve to AT MOST ONE value — every
 * expression slot except the fan-out `option_label`.
 */
export type ScalarFieldExpressionSlotId =
	ScalarEntry<FieldExpressionSlotEntry>["slot"];

/** Every expression-bearing form slot id (all xpath today). */
export type FormExpressionSlotId = FormExpressionSlotEntry["slot"];

/** Scalar form expression slots — the three Connect-block bindings
 *  (the form-link slots fan out per link/datum). */
export type ScalarFormExpressionSlotId =
	ScalarEntry<FormExpressionSlotEntry>["slot"];

/** The surface kinds whose stored value is expression SOURCE TEXT. */
const EXPRESSION_SURFACE_KINDS: ReadonlySet<ReferenceSurfaceKind> = new Set([
	"xpath",
	"prose",
]);

function isFieldExpressionEntry(
	entry: FieldSlotEntry,
): entry is FieldExpressionSlotEntry {
	return EXPRESSION_SURFACE_KINDS.has(entry.kind);
}

function isFormExpressionEntry(
	entry: FormSlotEntry,
): entry is FormExpressionSlotEntry {
	return EXPRESSION_SURFACE_KINDS.has(entry.kind);
}

const FIELD_EXPRESSION_SLOT_ENTRIES: readonly FieldExpressionSlotEntry[] =
	FIELD_REFERENCE_SLOTS.filter(isFieldExpressionEntry);

const FIELD_SLOT_PATHS: Record<FieldExpressionSlotId, string> = (() => {
	const paths = {} as Record<FieldExpressionSlotId, string>;
	for (const entry of FIELD_EXPRESSION_SLOT_ENTRIES) {
		paths[entry.slot] = entry.path;
	}
	return paths;
})();

const FORM_SLOT_PATHS: Record<FormExpressionSlotId, string> = (() => {
	const paths = {} as Record<FormExpressionSlotId, string>;
	for (const entry of FORM_REFERENCE_SLOTS) {
		if (isFormExpressionEntry(entry)) paths[entry.slot] = entry.path;
	}
	return paths;
})();

const SCALAR_FIELD_EXPRESSION_SLOT_IDS: ReadonlySet<string> = new Set(
	FIELD_EXPRESSION_SLOT_ENTRIES.filter((e) => !e.path.includes("[]")).map(
		(e) => e.slot,
	),
);

/**
 * The Connect-block XPath slot ids in registry order — the form-level
 * expression slots the deep validator walks per form.
 */
export const CONNECT_XPATH_SLOT_IDS: readonly ScalarFormExpressionSlotId[] =
	FORM_REFERENCE_SLOTS.filter(
		(entry): entry is Extract<FormSlotEntry, { path: `connect.${string}` }> =>
			entry.path.startsWith("connect."),
	).map((entry) => entry.slot);

/**
 * Is `key` the id of a scalar field expression slot? The narrowing
 * `readFieldString` (the emitters' shared accessor) uses to decide
 * whether a requested key delegates here or stays a plain
 * non-expression property read (`case_property_on`, ids).
 */
export function isScalarFieldExpressionSlotId(
	key: string,
): key is ScalarFieldExpressionSlotId {
	return SCALAR_FIELD_EXPRESSION_SLOT_IDS.has(key);
}

/**
 * The source text stored in a scalar expression slot, or `undefined`
 * when the slot is absent (or holds a non-string). The empty string
 * is a real stored value and is returned as-is — blank-skip policy
 * belongs to callers.
 */
export function expressionSource(
	field: Field,
	slot: ScalarFieldExpressionSlotId,
): string | undefined {
	return readSlotStrings(field, FIELD_SLOT_PATHS[slot])[0]?.text;
}

/**
 * Every source text a field expression slot resolves to, in element
 * order — the fan-out-aware read (`option_label` yields one entry per
 * option, `indices` pairing each text with its option's position).
 * Scalar slots yield zero or one entry.
 */
export function expressionSourceEntries(
	field: Field,
	slot: FieldExpressionSlotId,
): SlotStringEntry[] {
	return readSlotStrings(field, FIELD_SLOT_PATHS[slot]);
}

/**
 * The source text stored in a scalar form expression slot (the
 * Connect-block bindings), or `undefined` when absent.
 */
export function formExpressionSource(
	form: Form,
	slot: ScalarFormExpressionSlotId,
): string | undefined {
	return readSlotStrings(form, FORM_SLOT_PATHS[slot])[0]?.text;
}

/**
 * One expression-source read off a field: which slot it came from and
 * the stored text (plus fan-out `indices` for `option_label`).
 */
export interface ExpressionRead<
	S extends FieldExpressionSlotId = FieldExpressionSlotId,
> {
	readonly slot: S;
	readonly text: string;
	readonly indices: readonly number[];
}

/**
 * Every expression source a field carries on one surface, in registry
 * order — the registry-projection walk the deep validator's per-field
 * scans iterate instead of hand-rolled key lists. Unlike the
 * single-slot reads above, this IS applicability-gated
 * (`fieldSlotApplies`, narrowed by `repeat_mode` for repeats): it
 * answers "the slots a field of this kind carries", so a value parked
 * on a kind whose schema doesn't declare the slot is not reported.
 */
export function expressionSurfaceReads(
	field: Field,
	surface: "xpath",
): ExpressionRead<FieldXPathSlotId>[];
export function expressionSurfaceReads(
	field: Field,
	surface: "prose",
): ExpressionRead<FieldProseSlotId>[];
export function expressionSurfaceReads(
	field: Field,
	surface: "xpath" | "prose",
): ExpressionRead[] {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	const reads: ExpressionRead[] = [];
	for (const entry of FIELD_EXPRESSION_SLOT_ENTRIES) {
		if (entry.kind !== surface) continue;
		// The literal-tuple entries narrow to the declared interface for
		// the applicability check (optional keys are absent on most
		// literal members).
		const slot: FieldReferenceSlot = entry;
		if (!fieldSlotApplies(slot, field.kind, repeatMode)) continue;
		for (const { text, indices } of readSlotStrings(field, entry.path)) {
			reads.push({ slot: entry.slot, text, indices });
		}
	}
	return reads;
}
