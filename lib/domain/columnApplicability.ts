// lib/domain/columnApplicability.ts
//
// Column-kind ↔ property-type compatibility — ONE predicate consumed
// by every surface that answers "may this column kind render this
// property": the builder's kind-replace menu and inline hints, the
// workspace's whole-config verdict (tab dots + preview gate), and the
// validator's `CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH` rule.
// The offered-set can't drift from the accept-set because there is
// only one set (the same principle `slotConstraints.ts` applies to
// the predicate cards).
//
// **Unknown is permissive.** The verdict runs against the EFFECTIVE
// property view (`effectiveCaseTypes.ts`), and a property whose type
// nothing resolves carries `data_type: undefined` — honest unknown,
// not "text". A kind requirement can only reject a property whose
// type is POSITIVELY incompatible; missing metadata never manufactures
// an error (CommCare's wire is stringly — a mistyped display column
// renders poorly, it never crashes — so the type system here biases
// to helpfulness). An absent property (`undefined` — unset field
// slot, or a name the admission set doesn't resolve) is likewise "no
// opinion": existence is `columnReferences`' job, not this one's.

import type { CasePropertyDataType } from "./casePropertyTypes";
import { DATE_DATA_TYPES, TEXT_SHAPED_DATA_TYPES } from "./casePropertyTypes";
import type { ColumnKind } from "./modules";

/**
 * The property-type family a column kind requires, or `null` for the
 * universal kinds:
 *
 *   - **`date-typed`** — Date, Time-Since (interval). Their wire
 *     emitters run calendar arithmetic against the property's value.
 *   - **`text-shaped`** — Phone and Link. The runtime tap-to-call
 *     binding expects a string-shaped value, and a link's address is
 *     text. There is no `url` case-property type and adding one would
 *     ripple through four membership sets to buy nothing the wire can
 *     use, so a link's property is an ordinary text property — which
 *     does mean Phone offers itself for the same property.
 *   - **`null`** — Plain, ID-Mapping, Image-Map render the stored
 *     value / a value-keyed lookup, sound on every type; Calculated
 *     has no `field` slot at all (its expression is the source, and
 *     the predicate type checker owns it).
 */
export type ColumnPropertyRequirement = "date-typed" | "text-shaped" | null;

export function columnKindPropertyRequirement(
	kind: ColumnKind,
): ColumnPropertyRequirement {
	switch (kind) {
		case "date":
		case "interval":
			return "date-typed";
		case "phone":
		case "link":
			return "text-shaped";
		case "plain":
		case "id-mapping":
		case "image-map":
		case "calculated":
			return null;
	}
}

/**
 * May a column of `kind` render a property whose EFFECTIVE type is
 * `dataType`? `undefined` — unknown type, or no property at all —
 * satisfies every requirement (see the module header).
 */
export function columnKindAcceptsPropertyType(
	kind: ColumnKind,
	dataType: CasePropertyDataType | undefined,
): boolean {
	const requirement = columnKindPropertyRequirement(kind);
	if (requirement === null || dataType === undefined) return true;
	return requirement === "date-typed"
		? DATE_DATA_TYPES.has(dataType)
		: TEXT_SHAPED_DATA_TYPES.has(dataType);
}
