/**
 * Property-centric kind conversion — the plan every conversion surface
 * consults for a case-bound field.
 *
 * A case property has ONE type, derived from its writers (declared
 * `data_type` winning when present), and the commit gate holds that
 * line: `FIELD_KIND_WRITERS_DISAGREE` rejects two typed writers of
 * different kinds, `FIELD_KIND_PROPERTY_TYPE_MISMATCH` rejects a typed
 * writer that contradicts a declared type. So a kind conversion that
 * changes the property's data type can never land one field at a time —
 * the first converted writer disagrees with its unconverted peers, and
 * a declared type can't be corrected by any field edit. The subject of
 * such a conversion is the PROPERTY, and the plan makes that literal:
 *
 *   - every peer writer of the same `(caseType, property)` with the
 *     SAME source kind converts in the same gated batch (a peer already
 *     at the target kind needs nothing; a peer of a DIFFERENT typed
 *     kind is deliberately left alone — the gate then rejects the batch
 *     with the honest disagreement finding, because that property
 *     genuinely holds two shapes and a human has to pick);
 *   - a stale declared `data_type` is re-declared to the target kind's
 *     type via `setCaseProperty` in the same batch (the catalog entry
 *     describes the property; when the property's writers change type,
 *     the description follows), carrying the select options forward as
 *     the declaration's `{value, label}` pairs;
 *   - a conversion to `hidden` — whose writers the agreement rules
 *     exempt (`caseDataTypeForFieldKind` returns undefined) — converts
 *     ONLY the addressed field, and when it was the property's LAST
 *     typed writer on an undeclared entry, PINS the entry's `data_type`
 *     to the source kind's type. Without the pin, the hidden writer's
 *     structural expression inference (a later `today()` calculate)
 *     could silently retype the property under rows whose values are
 *     the old type — the row-poisoning class the string-compatible
 *     conversion tier exists to avoid.
 *
 * Same-batch cascade, computed at the batch-building layer, never a
 * reducer side effect — the `caseTypeRetirement` pattern, and for the
 * same reasons: historical replay reduces old batches to the same docs,
 * and concurrent edits to other entities merge instead of clobbering.
 * Consumed by the SA/MCP `editField` tool and the builder's
 * convert-type gesture (`useBlueprintMutations.convertField`), so the
 * editors cannot drift on what a conversion means.
 */

import {
	type CaseProperty,
	caseDataTypeForFieldKind,
	convertNeedsOptionSeed,
	type Field,
	type FieldKind,
	fieldCasePropertyOn,
	type SelectOption,
} from "@/lib/domain";
import { declarersOf } from "./referenceIndex";
import type { BlueprintDoc, Mutation, Uuid } from "./types";

/** A peer writer field the plan converts alongside the addressed one. */
export interface KindConversionPeer {
	readonly uuid: Uuid;
	readonly id: string;
}

export interface KindConversionPlan {
	/** The whole conversion as one batch: the addressed field's convert,
	 *  every same-kind peer's convert, then the declaration update when
	 *  one is needed. */
	readonly mutations: Mutation[];
	/** Peer writers converted alongside the addressed field (excludes
	 *  it) — consumers name these in their success message. */
	readonly peers: readonly KindConversionPeer[];
	/** True when the plan re-declares the property's `data_type`. */
	readonly redeclared: boolean;
}

/**
 * Build the conversion batch for `field` → `toKind`.
 *
 * `mintOptions` supplies born options for a converted field whose
 * source kind has none (`convertNeedsOptionSeed`) — called once PER
 * converted field so every field gets its own minted option identities
 * (uuid + order), never shared references.
 */
export function planKindConversion(args: {
	doc: BlueprintDoc;
	field: Field;
	toKind: FieldKind;
	mintOptions?: () => SelectOption[];
}): KindConversionPlan {
	const { doc, field, toKind, mintOptions } = args;

	const convertMutation = (target: Field): Mutation => ({
		kind: "convertField",
		uuid: target.uuid,
		toKind,
		...(convertNeedsOptionSeed(target, toKind) &&
			mintOptions && { options: mintOptions() }),
	});

	const addressedConvert = convertMutation(field);

	const caseType = fieldCasePropertyOn(field);
	if (caseType === undefined || field.id.length === 0) {
		// Not case-bound — a plain single-field conversion.
		return { mutations: [addressedConvert], peers: [], redeclared: false };
	}

	const fromType = caseDataTypeForFieldKind(field.kind);
	const toType = caseDataTypeForFieldKind(toKind);
	const record = doc.caseTypes?.find((ct) => ct.name === caseType);
	const entry = record?.properties.find((p) => p.name === field.id);

	// Peer writers of the same (caseType, property) — via the reference
	// index, never a doc walk. Only fields still at the SOURCE kind
	// convert; the addressed field itself is excluded here.
	const declarers = declarersOf(doc, caseType, field.id)
		.filter((uuid) => uuid !== field.uuid)
		.map((uuid) => doc.fields[uuid as Uuid])
		.filter((f): f is Field => f !== undefined);

	const mutations: Mutation[] = [addressedConvert];
	const peers: KindConversionPeer[] = [];
	let redeclared = false;

	if (toType !== undefined && toType !== fromType) {
		// Typed→typed flip (a select target, or a select→text demotion):
		// carry every same-kind peer writer across in the same batch.
		for (const peer of declarers) {
			if (peer.kind !== field.kind) continue;
			mutations.push(convertMutation(peer));
			peers.push({ uuid: peer.uuid, id: peer.id });
		}
		// A stale declared type is re-declared to match the new writers.
		if (entry?.data_type !== undefined && entry.data_type !== toType) {
			mutations.push(
				redeclareMutation(
					caseType,
					entry,
					toType,
					declarationOptions(field, toKind, addressedConvert),
				),
			);
			redeclared = true;
		}
	} else if (toKind === "hidden" && entry !== undefined) {
		// Hidden writers are exempt from the agreement rules, so no peer
		// converts. But when the addressed field is the property's LAST
		// typed writer and the entry is undeclared, pin the entry to the
		// source kind's type so later expression inference can't retype
		// the property under its existing rows.
		const anotherTypedWriterRemains = declarers.some(
			(f) => caseDataTypeForFieldKind(f.kind) !== undefined,
		);
		if (
			entry.data_type === undefined &&
			fromType !== undefined &&
			!anotherTypedWriterRemains
		) {
			mutations.push(redeclareMutation(caseType, entry, fromType, undefined));
			redeclared = true;
		}
	}

	return { mutations, peers, redeclared };
}

/** The `setCaseProperty` replace carrying the entry forward with its new
 *  `data_type` (and, for select targets, the option pairs). */
function redeclareMutation(
	caseType: string,
	entry: CaseProperty,
	dataType: NonNullable<CaseProperty["data_type"]>,
	options: CaseProperty["options"],
): Mutation {
	const { options: _prior, data_type: _staleType, ...kept } = entry;
	return {
		kind: "setCaseProperty",
		caseType,
		property: {
			...kept,
			data_type: dataType,
			...(options !== undefined && { options }),
		},
	};
}

/** The declaration's option pairs for a select target — the addressed
 *  field's converted options (the seed already minted onto its
 *  `convertField` mutation, or the existing list for single ↔ multi),
 *  stripped to the catalog's `{value, label}` shape. A non-select
 *  target declares none. */
function declarationOptions(
	field: Field,
	toKind: FieldKind,
	addressedConvert: Mutation,
): CaseProperty["options"] {
	if (toKind !== "single_select" && toKind !== "multi_select") {
		return undefined;
	}
	const source =
		addressedConvert.kind === "convertField" &&
		addressedConvert.options !== undefined
			? addressedConvert.options
			: (field as { options?: SelectOption[] }).options;
	return source?.map(({ value, label }) => ({ value, label }));
}
