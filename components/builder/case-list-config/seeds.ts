// components/builder/case-list-config/seeds.ts
//
// Smart seeds for the canvases' add affordances. A freshly-added
// thing must WORK the moment it lands: bound to a sensible
// property, labeled in human words, and (for text search) matching
// forgivingly: because a blank/invalid seed is a silent trap: an
// unbound search input matches nothing, and "exact" text match
// reads as "search is broken" to anyone who types a lowercase
// first name.
//
// Search-field creation still chooses a useful initial property because that
// canvas has one concise add action. Display-field creation is different: its
// center-canvas chooser asks which information the author wants, then the
// helpers here build a working column for that explicit property. The widget
// follows the property's data type; text-shaped search properties seed with
// FORGIVING (fuzzy) match: typo-and-case-tolerant on both the wire (CCHQ's
// per-prompt fuzzy flag) and the preview runtime (pg_trgm), with Exact one
// click away in the Match picker.

import { columnAddMutation } from "@/lib/doc/caseListColumnMutations";
import type { ProseProjector } from "@/lib/doc/hooks/useProseProjection";
import type { Mutation, Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type CaseProperty,
	type CaseType,
	type Column,
	calculatedColumn,
	DATE_FORMAT_PRESET_DEFINITIONS,
	dateColumn,
	effectiveDataType,
	fuzzyMode,
	type HiddenSearchInputDef,
	hiddenSearchInputDef,
	plainColumn,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputType,
	type SimpleSearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { literal, now, term } from "@/lib/domain/predicate";
import {
	propertyDisplayLabel,
	propertyFallbackDisplayLabel,
} from "../shared/primitives/propertyDisplay";
import { newUuid } from "./uuid";
import type { CaseDisplaySurface } from "./workspaceProjection";

/**
 * Center-canvas display-field add.
 *
 * The new field lands at the end of the ACTIVE screen and at the end of the
 * other one. Both are required: a column belongs to the Results and Details
 * sequences from birth, and a field added on Results is still a field Details
 * can be asked to show later, at a place it already holds.
 */
export function seededColumnAddMutation(
	moduleUuid: Uuid,
	config: CaseListConfig,
	_surface: CaseDisplaySurface,
	seed: Column,
): Extract<Mutation, { kind: "addColumn" }> {
	return columnAddMutation(moduleUuid, seed, {
		afterInList: config.listColumnOrder.at(-1) ?? null,
		afterInDetail: config.detailColumnOrder.at(-1) ?? null,
	});
}

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

/** Suffix until unique among sibling input names: the wire binds
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
 * and finally the first property even if taken: never unbound.
 * Returns `undefined` only when the case type declares nothing.
 */
export function pickSeedProperty(
	caseType: CaseType | undefined,
	used: ReadonlySet<string>,
): CaseProperty | undefined {
	const props = caseType?.properties ?? [];
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
 * properties use text because Search's final widget vocabulary has no choice
 * list without a fixture-backed option source. */
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
	project: ProseProjector,
): SimpleSearchInputDef | undefined {
	const used = new Set(
		config.searchInputs.flatMap((s) =>
			s.kind === "simple" ? [s.property] : [],
		),
	);
	const property = pickSeedProperty(caseType, used);
	if (property === undefined) return undefined;
	return seedSearchInputForProperty(config, property, project);
}

/**
 * Build a working search field for the case property the author explicitly
 * chose on the Search canvas. The explicit choice owns intent; this helper
 * owns only the mechanical defaults that keep a fresh field useful.
 */
export function seedSearchInputForProperty(
	config: CaseListConfig,
	property: CaseProperty,
	project: ProseProjector,
): SimpleSearchInputDef {
	const type = widgetTypeForProperty(property);
	// Text searches fuzzily by default; date and barcode widgets keep their
	// per-type default. Fuzzy is gated on
	// the property's data type too: a number property also renders as
	// a text widget, but fuzzy is text-only and would seed an invalid row.
	const fuzzyAdmitted =
		SEARCH_MODE_PROPERTY_TYPES.fuzzy?.includes(effectiveDataType(property)) ??
		true;
	return simpleSearchInputDef(
		newUuid(),
		uniqueInputName(xmlNameFromProperty(property.name), config.searchInputs),
		propertyDisplayLabel(property, project),
		type,
		property.name,
		type === "text" && fuzzyAdmitted ? { mode: fuzzyMode() } : {},
	);
}

/**
 * A working hidden value: named uniquely, labeled for the app strings the wire
 * still requires, and seeded with the time the search runs. That is the value
 * a registration offered after an empty search most often wants to keep as
 * provenance, and it is a complete expression the gate accepts as it lands.
 */
export function seedHiddenSearchInput(
	config: CaseListConfig,
): HiddenSearchInputDef {
	return hiddenSearchInputDef(
		newUuid(),
		uniqueInputName("search_time", config.searchInputs),
		"Search time",
		now(),
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
	project: ProseProjector,
	slots?: { visibleInList?: boolean; visibleInDetail?: boolean },
): Column | undefined {
	const used = new Set(
		config.columns.flatMap((c) => (c.kind !== "calculated" ? [c.field] : [])),
	);
	const property = pickSeedProperty(caseType, used);
	if (property === undefined) return undefined;
	return seedColumnForProperty(property, project, slots);
}

/** Build a presentable display field for the property the author explicitly
 * chose in Add information. Unlike `seedColumn`, this never guesses which
 * information they meant. */
export function seedColumnForProperty(
	property: CaseProperty,
	project: ProseProjector,
	slots?: { visibleInList?: boolean; visibleInDetail?: boolean },
): Column {
	const header = propertyDisplayLabel(property, project);
	const dataType = effectiveDataType(property);
	if (dataType === "date" || dataType === "datetime") {
		return dateColumn(
			newUuid(),
			property.name,
			header,
			DATE_FORMAT_PRESET_DEFINITIONS.iso.commCarePattern,
			slots,
		);
	}
	return plainColumn(newUuid(), property.name, header, slots);
}

/** Build the intentionally secondary, property-free display option exposed by
 * Add information. The empty literal is a valid starting expression and the
 * newly selected row opens directly into the inspector, where the author can
 * compose the value. */
export function seedCalculatedColumn(slots?: {
	visibleInList?: boolean;
	visibleInDetail?: boolean;
}): Column {
	return calculatedColumn(
		newUuid(),
		"Calculated value",
		term(literal("")),
		slots,
	);
}

/** Properties that do not already have a display definition. Existing
 * definitions absent from one screen are mixed into the shared Add
 * information chooser by meaning so restoring them preserves formatting
 * without teaching "hidden fields" as a primary concept. */
export function unrepresentedColumnProperties(
	config: CaseListConfig,
	caseType: CaseType | undefined,
): readonly CaseProperty[] {
	const represented = new Set(
		config.columns.flatMap((column) =>
			column.kind !== "calculated" ? [column.field] : [],
		),
	);
	return (caseType?.properties ?? []).filter(
		(property) => !represented.has(property.name),
	);
}

/** Properties already used by at least one display definition. They stay out
 * of the primary Add list, but power the quiet "show another way" path for a
 * second label or format. */
export function representedColumnProperties(
	config: CaseListConfig,
	caseType: CaseType | undefined,
): readonly CaseProperty[] {
	const represented = new Set(
		config.columns.flatMap((column) =>
			column.kind !== "calculated" ? [column.field] : [],
		),
	);
	return (caseType?.properties ?? []).filter((property) =>
		represented.has(property.name),
	);
}
