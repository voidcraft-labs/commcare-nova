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
// Reads are TOTAL over the stored value and SHAPE-DRIVEN. XPath slots
// accept only `XPathExpression`; prose slots accept only
// `ProseTemplate`. Each prints its current source projection —
// identity leaves resolve against the doc at read time, which is how
// a renamed field's new name reaches every expression with no slot
// rewrite. Any other stored shape reads as absent, so a hand-built
// string can never become a second live expression representation.
// Applicability gating lives only in the registry-projection iterator
// (`expressionSurfaceReads`), whose callers want "the slots a field
// of this kind carries".

import type { Field } from "./fields";
import type { Form } from "./forms";
import {
	isProseTemplate,
	type ProseTemplate,
	printProseTemplate,
	projectProseTemplate,
} from "./prose";
import {
	FIELD_REFERENCE_SLOTS,
	type FieldProseSlotId,
	type FieldReferenceSlot,
	type FieldXPathSlotId,
	FORM_REFERENCE_SLOTS,
	type FormLinkXPathSlotId,
	fieldSlotApplies,
	type ReferenceSurfaceKind,
	readSlotValues,
	type SlotStringEntry,
} from "./referenceSlots";
import { isXPathExpression, type XPathExpression } from "./xpath/ast";
import {
	printXPath,
	projectXPath,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "./xpath/print";

type FieldSlotEntry = (typeof FIELD_REFERENCE_SLOTS)[number];
type FormSlotEntry = (typeof FORM_REFERENCE_SLOTS)[number];

type FieldExpressionSlotEntry = Extract<
	FieldSlotEntry,
	{ kind: "xpath-ast" | "prose" }
>;
type FormExpressionSlotEntry = Extract<
	FormSlotEntry,
	{ kind: "xpath-ast" | "prose" }
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

/** The surface kinds whose read projection is expression SOURCE TEXT
 *  — AST-stored slots printed, prose verbatim. */
const EXPRESSION_SURFACE_KINDS: ReadonlySet<ReferenceSurfaceKind> = new Set([
	"xpath-ast",
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

const FIELD_SLOT_ENTRIES: Record<
	FieldExpressionSlotId,
	FieldExpressionSlotEntry
> = (() => {
	const entries = {} as Record<FieldExpressionSlotId, FieldExpressionSlotEntry>;
	for (const entry of FIELD_EXPRESSION_SLOT_ENTRIES) {
		entries[entry.slot] = entry;
	}
	return entries;
})();

const FORM_SLOT_ENTRIES: Record<FormExpressionSlotId, FormExpressionSlotEntry> =
	(() => {
		const entries = {} as Record<FormExpressionSlotId, FormExpressionSlotEntry>;
		for (const entry of FORM_REFERENCE_SLOTS) {
			if (isFormExpressionEntry(entry)) entries[entry.slot] = entry;
		}
		return entries;
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

/** Form-link XPath slots in registry order. Unlike Connect slots, these fan
 * out through link and datum arrays and therefore use source-entry reads. */
export const FORM_LINK_XPATH_SLOT_IDS: readonly FormLinkXPathSlotId[] =
	FORM_REFERENCE_SLOTS.filter(
		(
			entry,
		): entry is Extract<
			FormSlotEntry,
			{ kind: "xpath-ast"; path: `formLinks[]${string}` }
		> => entry.kind === "xpath-ast" && entry.path.startsWith("formLinks[]"),
	).map((entry) => entry.slot);

/**
 * Is `key` the id of a scalar field expression slot? The narrowing
 * `readFieldString` (the emitters' shared accessor) uses to decide
 * whether a requested key delegates here or stays a plain
 * non-expression property read (`caseWrite`, ids).
 */
export function isScalarFieldExpressionSlotId(
	key: string,
): key is ScalarFieldExpressionSlotId {
	return SCALAR_FIELD_EXPRESSION_SLOT_IDS.has(key);
}

/** Project one canonical stored slot value to source text. Expression slots
 * are AST-only; an unexpected non-AST shape is absent rather than becoming a
 * second live string representation. */
function projectSlotValue(
	value: unknown,
	doc: XPathPrintableDoc,
	kind: FieldExpressionSlotEntry["kind"],
): string | undefined {
	if (kind === "prose" && isProseTemplate(value)) {
		return printProseTemplate(value, doc);
	}
	if (kind === "xpath-ast" && isXPathExpression(value)) {
		return printXPath(value, xpathPrintContext(doc));
	}
	return undefined;
}

/** Human/validator projection of one slot. Unlike the strict runtime/wire
 * accessor above, an unresolved identity returns ephemeral repair text so the
 * editor and validator can identify the dangling carrier. That text is never
 * stored or emitted. */
function projectSlotValueForInspection(
	value: unknown,
	doc: XPathPrintableDoc,
	kind: FieldExpressionSlotEntry["kind"],
): string | undefined {
	if (kind === "prose" && isProseTemplate(value)) {
		return projectProseTemplate(value, doc).text;
	}
	if (kind === "xpath-ast" && isXPathExpression(value)) {
		return projectXPath(value, xpathPrintContext(doc)).text;
	}
	return undefined;
}

/**
 * The source text a scalar expression slot reads as, or `undefined`
 * when the slot is absent. AST slots print against `doc` (identity
 * leaves resolve to current names).
 * The empty string / empty expression is a real stored value and is
 * returned as-is — blank-skip policy belongs to callers.
 */
export function expressionSource(
	field: Field,
	slot: ScalarFieldExpressionSlotId,
	doc: XPathPrintableDoc,
): string | undefined {
	const entry = FIELD_SLOT_ENTRIES[slot];
	const value = readSlotValues(field, entry.path)[0]?.value;
	return projectSlotValue(value, doc, entry.kind);
}

/** Inspection-only twin of {@link expressionSource}. Wire/runtime consumers
 * must use the strict accessor; validators and editors use this total
 * projection to surface a repair state. */
export function expressionInspectionSource(
	field: Field,
	slot: ScalarFieldExpressionSlotId,
	doc: XPathPrintableDoc,
): string | undefined {
	const entry = FIELD_SLOT_ENTRIES[slot];
	const value = readSlotValues(field, entry.path)[0]?.value;
	return projectSlotValueForInspection(value, doc, entry.kind);
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
	doc: XPathPrintableDoc,
): SlotStringEntry[] {
	const entries: SlotStringEntry[] = [];
	for (const { indices, value } of readSlotValues(
		field,
		FIELD_SLOT_ENTRIES[slot].path,
	)) {
		const text = projectSlotValue(value, doc, FIELD_SLOT_ENTRIES[slot].kind);
		if (text !== undefined) entries.push({ indices, text });
	}
	return entries;
}

/** The canonical stored template behind a scalar prose slot. */
export function fieldProseTemplate(
	field: Field,
	slot: Exclude<FieldProseSlotId, "option_label">,
): ProseTemplate | undefined {
	const value = readSlotValues(field, FIELD_SLOT_ENTRIES[slot].path)[0]?.value;
	return isProseTemplate(value) ? value : undefined;
}

/**
 * The source text a scalar form expression slot (the Connect-block
 * bindings) reads as, or `undefined` when absent. Stored AST values
 * print against `doc`.
 */
export function formExpressionSource(
	form: Form,
	slot: ScalarFormExpressionSlotId,
	doc: XPathPrintableDoc,
): string | undefined {
	const entry = FORM_SLOT_ENTRIES[slot];
	const value = readSlotValues(form, entry.path)[0]?.value;
	return projectSlotValue(value, doc, entry.kind);
}

/**
 * The stored expression AST behind a scalar form expression slot, when
 * the slot is AST-stored — the structural twin of
 * `formExpressionSource` for consumers that classify the stored shape
 * (the deep validator's stored-reference diagnosis). A prose slot has
 * no XPath AST and reads as `undefined`.
 */
export function formExpressionValue(
	form: Form,
	slot: ScalarFormExpressionSlotId,
): XPathExpression | undefined {
	const value = readSlotValues(form, FORM_SLOT_ENTRIES[slot].path)[0]?.value;
	return isXPathExpression(value) ? value : undefined;
}

/** One fan-out-aware expression read from a form carrier. */
export interface FormExpressionRead<
	S extends FormExpressionSlotId = FormExpressionSlotId,
> {
	readonly slot: S;
	readonly text: string;
	readonly indices: readonly number[];
	readonly expr?: XPathExpression;
}

/**
 * Every source projection for a form expression slot, preserving array
 * indices so validators can identify the exact link or datum that failed.
 */
export function formExpressionSourceEntries<S extends FormExpressionSlotId>(
	form: Form,
	slot: S,
	doc: XPathPrintableDoc,
): FormExpressionRead<S>[] {
	const entry = FORM_SLOT_ENTRIES[slot];
	const reads: FormExpressionRead<S>[] = [];
	for (const { indices, value } of readSlotValues(form, entry.path)) {
		const text = projectSlotValue(value, doc, entry.kind);
		if (text === undefined) continue;
		reads.push({
			slot,
			text,
			indices,
			...(isXPathExpression(value) ? { expr: value } : {}),
		});
	}
	return reads;
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
	/**
	 * The stored expression AST when the slot is AST-stored — `text` is
	 * its printed projection. Absent for prose slots. Consumers that classify
	 * how a reference is STORED (the deep validator's stored-reference
	 * diagnosis) read this; text-only consumers ignore it.
	 */
	readonly expr?: XPathExpression;
	/** The canonical stored template for a prose slot. */
	readonly template?: ProseTemplate;
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
	doc: XPathPrintableDoc,
): ExpressionRead<FieldXPathSlotId>[];
export function expressionSurfaceReads(
	field: Field,
	surface: "prose",
	doc: XPathPrintableDoc,
): ExpressionRead<FieldProseSlotId>[];
export function expressionSurfaceReads(
	field: Field,
	surface: "xpath" | "prose",
	doc: XPathPrintableDoc,
): ExpressionRead[] {
	const repeatMode = field.kind === "repeat" ? field.repeat_mode : undefined;
	const reads: ExpressionRead[] = [];
	for (const entry of FIELD_EXPRESSION_SLOT_ENTRIES) {
		// The "xpath" surface name is the validator's vocabulary; its
		// storage is the AST, and the read is the printed text.
		const matches =
			surface === "xpath" ? entry.kind === "xpath-ast" : entry.kind === "prose";
		if (!matches) continue;
		// The literal-tuple entries narrow to the declared interface for
		// the applicability check (optional keys are absent on most
		// literal members).
		const slot: FieldReferenceSlot = entry;
		if (!fieldSlotApplies(slot, field.kind, repeatMode)) continue;
		for (const { value, indices } of readSlotValues(field, entry.path)) {
			const text =
				entry.kind === "xpath-ast" && isXPathExpression(value)
					? projectXPath(value, xpathPrintContext(doc)).text
					: entry.kind === "prose" && isProseTemplate(value)
						? projectProseTemplate(value, doc).text
						: undefined;
			if (text !== undefined) {
				reads.push({
					slot: entry.slot,
					text,
					indices,
					...(entry.kind === "xpath-ast" &&
						isXPathExpression(value) && { expr: value }),
					...(entry.kind === "prose" &&
						isProseTemplate(value) && { template: value }),
				});
			}
		}
	}
	return reads;
}
