// components/builder/case-list-config/searchInputResolution.ts
//
// Pure per-row resolution for `SearchInputDef` lists — the single
// source of truth for "is this search input structurally sound".
// Three consumers read it:
//
//   - the search canvas (error badges on worker-true input rows)
//   - the search-input inspector (inline diagnostics next to the
//     offending control)
//   - the workspace's config-validity derivation (gates the live
//     preview so a malformed config never reaches the case-store
//     compiler)
//
// Display chrome and validity propagation share one derivation so
// they can't drift.

import type { IconifyIcon } from "@iconify/react/offline";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSelect from "@iconify-icons/tabler/select";
import {
	applicableSearchModes,
	type CaseProperty,
	type CaseType,
	DEFAULT_SEARCH_MODE_KIND,
	effectiveDataType,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	type MultiSelectQuantifier,
	multiSelectContainsMode,
	phoneticMode,
	rangeMode,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	type SimpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	literal,
	type RelationPath,
	type ResolvedType,
	type SearchInputDecl,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";

// ── Display labels ────────────────────────────────────────────────

export const SEARCH_INPUT_TYPE_LABELS: Record<SearchInputType, string> = {
	text: "Text",
	select: "Select",
	date: "Date",
	"date-range": "Date range",
	barcode: "Barcode",
};

export const SEARCH_INPUT_TYPE_ICONS: Record<SearchInputType, IconifyIcon> = {
	text: tablerSearch,
	select: tablerSelect,
	date: tablerCalendar,
	"date-range": tablerCalendarStats,
	barcode: tablerBarcode,
};

/** Plain-words explanation per widget type — what the worker gets.
 *  Shown in the Type picker's menu beside each label. */
export const SEARCH_INPUT_TYPE_DESCRIPTIONS: Record<SearchInputType, string> = {
	text: "Free-typed text box.",
	select: "Pick from the property's options.",
	date: "Calendar picker for a single date.",
	"date-range": "From / to pair searching a date span.",
	barcode: "Scan a barcode instead of typing.",
};

/**
 * Authoring-layer mode names — plain words over search-engine
 * vocabulary ("fuzzy", "phonetic"), because the author choosing
 * between them is rarely a search engineer. The wire layer keeps
 * its own vocabulary; these labels never leave the builder UI.
 */
export const SEARCH_MODE_LABELS: Record<SearchInputMode["kind"], string> = {
	exact: "Exact",
	fuzzy: "Forgiving",
	"starts-with": "Starts with",
	phonetic: "Sounds like",
	"fuzzy-date": "Forgiving date",
	range: "Range",
	"multi-select-contains": "Contains",
};

/**
 * Plain-words explanation per match mode — what the worker's typed
 * value has to look like to hit. Shown in the Match picker's menu
 * AND as the chosen mode's hint, because the difference between
 * "Exact" and "Forgiving" is the difference between "search looks
 * broken" and "search works": exact is letter-for-letter and
 * case-sensitive, which surprises everyone the first time.
 */
export const SEARCH_MODE_DESCRIPTIONS: Record<SearchInputMode["kind"], string> =
	{
		exact: "Letter-for-letter, including capitalization.",
		fuzzy: "Tolerates typos, partial words, and capitalization.",
		"starts-with": "Matches values that begin with the typed text.",
		phonetic: "Matches names that sound alike when spoken.",
		"fuzzy-date": "Tolerates day/month digit swaps in a typed date.",
		range: "Worker picks a from / to range.",
		"multi-select-contains": "Matches cases containing the chosen tokens.",
	};

/** The mode a row actually runs with — its explicit mode, or the
 *  per-type default when the slot is absent. */
export function effectiveModeKind(
	input: SearchInputDef,
): SearchInputMode["kind"] {
	if (input.kind === "advanced") return "exact";
	return input.mode?.kind ?? DEFAULT_SEARCH_MODE_KIND[input.type];
}

// ── Per-mode builder lookup ───────────────────────────────────────

export function buildMode(
	kind: SearchInputMode["kind"],
	previousQuantifier: MultiSelectQuantifier = "any",
): SearchInputMode {
	switch (kind) {
		case "exact":
			return exactMode();
		case "fuzzy":
			return fuzzyMode();
		case "starts-with":
			return startsWithMode();
		case "phonetic":
			return phoneticMode();
		case "fuzzy-date":
			return fuzzyDateMode();
		case "range":
			return rangeMode();
		case "multi-select-contains":
			return multiSelectContainsMode(previousQuantifier);
	}
}

// ── Row resolution — single source of truth ───────────────────────

export type NameState =
	/** Non-empty + unique among siblings. */
	| { kind: "ok" }
	/** Empty string — the user hasn't named the input yet. */
	| { kind: "empty" }
	/** Duplicate against an earlier index — first occurrence wins.
	 *  The wire layer binds inputs by name, so duplicates would
	 *  silently overwrite. */
	| { kind: "duplicate"; firstIndex: number };

export type PropertyState =
	/** Bound and resolvable (or advanced arm — the predicate AST owns
	 *  property resolution). */
	| { kind: "ok" }
	/** Simple arm with `property: ""` — an unbound input matches
	 *  NOTHING at runtime, which reads as "search is broken". */
	| { kind: "empty" }
	/** Simple arm naming a property the destination case type doesn't
	 *  declare (renamed or removed since) — also matches nothing. */
	| { kind: "dangling"; destination: string };

export interface ResolvedRow {
	readonly nameState: NameState;
	readonly labelEmpty: boolean;
	readonly propertyState: PropertyState;
	/** Type-coupling diagnostics — empty when the picked
	 *  `(type, mode)` pair is admissible against the targeted
	 *  property's `data_type`. Always empty for `kind: "advanced"`
	 *  (the predicate AST owns property resolution). */
	readonly typeCouplingErrors: readonly string[];
}

/**
 * Resolve every row's status against the sibling list + the editor's
 * `caseTypes` + `currentCaseType` context. Builds the
 * `firstIndexByName` map up-front so the per-row pass stays O(n).
 */
export function resolveRows(
	value: readonly SearchInputDef[],
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): readonly ResolvedRow[] {
	const firstIndexByName = new Map<string, number>();
	for (let i = 0; i < value.length; i++) {
		const name = value[i]?.name;
		if (name === undefined || name === "") continue;
		if (!firstIndexByName.has(name)) {
			firstIndexByName.set(name, i);
		}
	}
	return value.map((row, i) => {
		let nameState: NameState;
		if (row.name === "") {
			nameState = { kind: "empty" };
		} else {
			const firstIndex = firstIndexByName.get(row.name);
			if (firstIndex !== undefined && firstIndex < i) {
				nameState = { kind: "duplicate", firstIndex };
			} else {
				nameState = { kind: "ok" };
			}
		}

		// Advanced arm bypasses type-coupling — the predicate AST owns
		// property resolution + has its own type checker.
		let propertyState: PropertyState = { kind: "ok" };
		let typeCouplingErrors: readonly string[] = [];
		if (row.kind === "simple") {
			const property = resolveProperty(caseTypes, row, currentCaseType);
			if (row.property === "") {
				propertyState = { kind: "empty" };
			} else if (property === undefined) {
				propertyState = {
					kind: "dangling",
					destination: resolveDestinationCaseType(
						caseTypes,
						row.via,
						currentCaseType,
					),
				};
			}
			typeCouplingErrors = computeTypeCouplingErrors(row, property);
		}

		return {
			nameState,
			labelEmpty: row.label === "",
			propertyState,
			typeCouplingErrors,
		};
	});
}

/**
 * Resolve the targeted property reference against the `caseTypes`
 * graph. Only the simple arm carries a `property`; the advanced arm
 * encodes property references inside its `predicate` AST.
 */
export function resolveProperty(
	caseTypes: readonly CaseType[],
	row: SimpleSearchInputDef,
	currentCaseType: string,
): CaseProperty | undefined {
	if (row.property === "") return undefined;
	const destinationCaseType = resolveDestinationCaseType(
		caseTypes,
		row.via,
		currentCaseType,
	);
	const ct = caseTypes.find((c) => c.name === destinationCaseType);
	return ct?.properties.find((p) => p.name === row.property);
}

/**
 * Resolve a relation walk's destination case type. Mirrors the
 * predicate editor's destination resolution: `self` stays at the
 * row's anchor, `ancestor` walks one parent step, `subcase` /
 * `any-relation` fall back to the row's anchor (the editor's
 * single-step `RelationPathBuilder` doesn't surface destination
 * qualifiers; the wire layer's per-mode property-type gate is the
 * runtime authority for stricter resolution).
 */
export function resolveDestinationCaseType(
	caseTypes: readonly CaseType[],
	via: RelationPath | undefined,
	currentCaseType: string,
): string {
	if (via === undefined) return currentCaseType;
	switch (via.kind) {
		case "self":
			return currentCaseType;
		case "ancestor": {
			const ct = caseTypes.find((c) => c.name === currentCaseType);
			return ct?.parent_type ?? currentCaseType;
		}
		case "subcase":
			return currentCaseType;
		case "any-relation":
			return currentCaseType;
	}
}

/**
 * Compute the type-coupling diagnostics for a single simple-arm row
 * given the targeted property's `CaseProperty` (when resolvable).
 * Three orthogonal checks combine: widget-kind vs property data-type,
 * mode vs property data-type, mode vs widget-kind (covers persisted
 * docs that drifted past the editor's own picker filtering).
 */
export function computeTypeCouplingErrors(
	row: SimpleSearchInputDef,
	property: CaseProperty | undefined,
): readonly string[] {
	const errors: string[] = [];

	// Mode vs widget-kind gate.
	if (row.mode !== undefined) {
		const modeKind = row.mode.kind;
		const applicable = applicableSearchModes(row.type);
		if (!applicable.includes(modeKind)) {
			const allowedLabels = applicable
				.map((m) => SEARCH_MODE_LABELS[m])
				.join(", ");
			errors.push(
				`${SEARCH_MODE_LABELS[modeKind]} mode is not valid for ${SEARCH_INPUT_TYPE_LABELS[row.type]} inputs; pick ${allowedLabels}.`,
			);
		}
	}

	// Property-anchored gates. Skip when property is unresolved.
	if (property === undefined) return errors;
	const dataType = effectiveDataType(property);

	const typeAllowList = SEARCH_INPUT_TYPE_PROPERTY_TYPES[row.type];
	if (typeAllowList !== undefined && !typeAllowList.includes(dataType)) {
		errors.push(
			`${SEARCH_INPUT_TYPE_LABELS[row.type]} input is not valid for ${dataType} property "${row.property}"; pick a ${typeAllowList.join(" / ")} property.`,
		);
	}

	if (row.mode !== undefined) {
		const modeAllowList = SEARCH_MODE_PROPERTY_TYPES[row.mode.kind];
		if (modeAllowList !== undefined && !modeAllowList.includes(dataType)) {
			errors.push(
				`${SEARCH_MODE_LABELS[row.mode.kind]} mode is not valid for ${dataType} property "${row.property}"; pick a ${modeAllowList.join(" / ")} property.`,
			);
		}
	}

	return errors;
}

export function rowHasStructuralError(resolved: ResolvedRow): boolean {
	if (resolved.nameState.kind !== "ok") return true;
	if (resolved.labelEmpty) return true;
	if (resolved.propertyState.kind !== "ok") return true;
	if (resolved.typeCouplingErrors.length > 0) return true;
	return false;
}

// ── knownInputs derivation ────────────────────────────────────────
//
// Each row's inner editor sees the SIBLING rows' search-input
// declarations. Lets a row's `default` / advanced predicate
// reference any other input via `input("other_name")` without the
// type checker rejecting the reference. Self-references are
// excluded so a row authoring its own name doesn't see spurious
// "input not declared" errors during the per-keystroke draft phase.

export function deriveSearchInputDecl(
	row: SearchInputDef,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): SearchInputDecl {
	switch (row.type) {
		case "text":
		case "barcode":
			return { name: row.name, data_type: "text" };
		case "date":
		case "date-range":
			return { name: row.name, data_type: "date" };
		case "select": {
			// Selects derive the declared `data_type` from the targeted
			// property when resolvable; falls back to `text`. Only the
			// simple arm has a property to consult; advanced rows fall
			// straight through to text.
			if (row.kind !== "simple") {
				return { name: row.name, data_type: "text" };
			}
			const property = resolveProperty(caseTypes, row, currentCaseType);
			if (property === undefined) {
				return { name: row.name, data_type: "text" };
			}
			const dataType = effectiveDataType(property);
			if (dataType === "single_select" || dataType === "multi_select") {
				return { name: row.name, data_type: dataType };
			}
			return { name: row.name, data_type: "text" };
		}
	}
}

export function computeKnownInputsForRow(
	rows: readonly SearchInputDef[],
	rowIndex: number,
	caseTypes: readonly CaseType[],
	currentCaseType: string,
): readonly SearchInputDecl[] {
	const decls: SearchInputDecl[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (i === rowIndex) continue;
		const sibling = rows[i];
		if (sibling === undefined || sibling.name === "") continue;
		decls.push(deriveSearchInputDecl(sibling, caseTypes, currentCaseType));
	}
	return decls;
}

// ── Default-value expectedType + seed ─────────────────────────────

export function expectedTypeForDefault(
	type: SearchInputType,
): ResolvedType | undefined {
	switch (type) {
		case "text":
		case "barcode":
			return "text";
		case "date":
		case "date-range":
			return "date";
		case "select":
			return undefined;
	}
}

export function seedDefaultExpression(type: SearchInputType): ValueExpression {
	switch (type) {
		case "date":
		case "date-range":
			return today();
		case "text":
		case "barcode":
		case "select":
			return term(literal(""));
	}
}
