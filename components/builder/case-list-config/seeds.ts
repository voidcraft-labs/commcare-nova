// components/builder/case-list-config/seeds.ts
//
// Smart seeds for the canvases' add affordances. A freshly-added
// thing must WORK the moment it lands — bound to a sensible
// property, labeled in human words, and (for text search) matching
// forgivingly — because a blank/invalid seed is a silent trap: an
// unbound search input matches nothing, and "exact" text match
// reads as "search is broken" to anyone who types a lowercase
// first name.
//
// Property choice prefers `case_name` (the property every case
// type has and the one searches use), then any unused text
// property, then any unused property at all. The widget follows the
// property's data type; text-shaped properties seed with FORGIVING
// (fuzzy) match — typo-and-case-tolerant on both the wire (CCHQ's
// per-prompt fuzzy flag) and the preview runtime (pg_trgm) — with
// Exact one click away in the Match picker.

import {
	authorableCaseProperties,
	type CaseListConfig,
	type CaseProperty,
	type CaseType,
	type Column,
	canonicalCasePropertyName,
	dateColumn,
	effectiveDataType,
	fuzzyMode,
	plainColumn,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputType,
	simpleSearchInputDef,
} from "@/lib/domain";
import { walkPropertyRefs } from "@/lib/domain/predicate";
import {
	propertyDisplayLabel,
	propertyFallbackDisplayLabel,
} from "../shared/primitives/propertyDisplay";
import { newUuid } from "./uuid";

// ── Naming helpers ────────────────────────────────────────────────

/** Property name → person-facing label: `rash_onset_date` reads
 *  "Rash onset date". */
export function labelFromProperty(property: string): string {
	return propertyFallbackDisplayLabel(property);
}

/**
 * Property name → a legal search-input wire `name` (XML element
 * vocabulary: leading letter/underscore, then letters/digits/
 * underscores). Properties admit hyphens; names don't.
 */
export function xmlNameFromProperty(property: string): string {
	const cleaned = property.replace(/[^A-Za-z0-9_]/g, "_");
	if (cleaned === "" || /^[0-9]/.test(cleaned)) return `_${cleaned}`;
	return cleaned;
}

/** Suffix until unique among sibling input names — the wire binds
 *  inputs by name, so a duplicate would silently shadow. */
export function uniqueInputName(
	base: string,
	siblings: readonly SearchInputDef[],
): string {
	const taken = new Set(siblings.map((s) => s.name));
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const candidate = `${base}_${i}`;
		if (!taken.has(candidate)) return candidate;
	}
}

// ── Property choice ───────────────────────────────────────────────

/**
 * Pick the property a fresh row should bind: `case_name` first
 * (unused), then any unused text property, any unused property,
 * and finally the first property even if taken — never unbound.
 * Returns `undefined` only when the case type declares nothing.
 */
export function pickSeedProperty(
	caseType: CaseType | undefined,
	used: ReadonlySet<string>,
): CaseProperty | undefined {
	const props = authorableCaseProperties(caseType?.properties ?? []);
	if (props.length === 0) return undefined;
	const unused = props.filter((p) => !used.has(p.name));
	const textUnused = unused.filter((p) => effectiveDataType(p) === "text");
	return (
		textUnused.find((p) => p.name === "case_name") ??
		textUnused[0] ??
		unused[0] ??
		props[0]
	);
}

/** The widget a property's data type naturally renders as. Select-typed
 *  properties render as `text`, NOT `select`: the wire prompt carries no
 *  itemset slot, so a `select` search input is rejected by the commit
 *  gate outright (`searchInputSelectWidgetNotSupported`) — and a seed /
 *  reseed must land working. */
export function widgetTypeForProperty(property: CaseProperty): SearchInputType {
	switch (effectiveDataType(property)) {
		case "date":
		case "datetime":
			return "date";
		default:
			return "text";
	}
}

// ── Seeds ─────────────────────────────────────────────────────────

/**
 * A fully-working search input: bound property, human label, legal
 * unique name, widget matched to the data type, and fuzzy match for
 * text. Returns `undefined` when the case type has no properties to
 * bind (the canvas disables the add affordance in that state).
 */
export function seedSearchInput(
	config: CaseListConfig,
	caseType: CaseType | undefined,
): SearchInputDef | undefined {
	const used = new Set(
		config.searchInputs.flatMap((s) =>
			s.kind === "simple" && s.property !== ""
				? [canonicalCasePropertyName(s.property)]
				: [],
		),
	);
	// A direct always-on filter and a simple self-search on the same property
	// AND-compose to an empty-looking result whenever their values disagree.
	// Treat those directly-filtered properties as occupied for seed choice, so
	// the first Add gesture lands valid whenever any alternative exists. The
	// validator remains the backstop when the case type exposes only the one
	// filtered property.
	if (config.filter !== undefined && caseType !== undefined) {
		walkPropertyRefs(config.filter, (ref) => {
			const selfWalk = ref.via === undefined || ref.via.kind === "self";
			if (selfWalk && ref.caseType === caseType.name) {
				used.add(canonicalCasePropertyName(ref.property));
			}
		});
	}
	const property = pickSeedProperty(caseType, used);
	if (property === undefined) return undefined;

	const type = widgetTypeForProperty(property);
	// Text searches fuzzily by default; date / select widgets
	// keep the per-type default (exact pick-a-value). Fuzzy is gated on
	// the property's data type too — a number property also renders as
	// a text widget, but fuzzy is text-only and would seed an invalid row.
	const fuzzyAdmitted =
		SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(effectiveDataType(property)) ??
		true;
	return simpleSearchInputDef(
		newUuid(),
		uniqueInputName(xmlNameFromProperty(property.name), config.searchInputs),
		propertyDisplayLabel(property),
		type,
		property.name,
		type === "text" && fuzzyAdmitted ? { mode: fuzzyMode() } : {},
	);
}

/**
 * A presentable column: bound to an unused property, headed in human
 * words, and date-formatted when the property is date-shaped.
 * Returns `undefined` when the case type has no properties.
 */
export function seedColumn(
	config: CaseListConfig,
	caseType: CaseType | undefined,
	slots?: { visibleInList?: boolean; visibleInDetail?: boolean },
): Column | undefined {
	const used = new Set(
		config.columns.flatMap((c) =>
			c.kind !== "calculated" && c.field !== ""
				? [canonicalCasePropertyName(c.field)]
				: [],
		),
	);
	const property = pickSeedProperty(caseType, used);
	if (property === undefined) return undefined;

	const header = propertyDisplayLabel(property);
	const dataType = effectiveDataType(property);
	if (dataType === "date" || dataType === "datetime") {
		return dateColumn(newUuid(), property.name, header, "%Y-%m-%d", slots);
	}
	return plainColumn(newUuid(), property.name, header, slots);
}
