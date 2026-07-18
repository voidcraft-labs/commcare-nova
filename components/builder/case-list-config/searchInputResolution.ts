// components/builder/case-list-config/searchInputResolution.ts
//
// Pure per-row resolution for `SearchInputDef` lists — the single
// source of truth for "is this search input structurally sound".
// Three consumers read it:
//
//   - the search canvas (error badges on app-true field rows)
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
import { propertyDisplayLabel } from "@/components/builder/shared/primitives/propertyDisplay";
import {
	applicableSearchModes,
	authorableCaseProperties,
	type CaseProperty,
	type CasePropertyDataType,
	type CaseType,
	canonicalCasePropertyName,
	effectiveDataType,
	effectiveSimpleSearchModeKind,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	type MultiSelectQuantifier,
	multiSelectContainsMode,
	phoneticMode,
	rangeMode,
	SEARCH_INPUT_RUNTIME_VALUE_TYPES,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	type SimpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	ANY_CONSTRAINT,
	compatibleTypesFor,
	eq,
	input,
	literal,
	match,
	matchAll,
	type Predicate,
	prop,
	type RelationPath,
	type ResolvedType,
	type SearchInputDecl,
	type SlotConstraint,
	term,
	today,
	type ValueExpression,
	whenInput,
} from "@/lib/domain/predicate";
import type { EditorSearchInputDecl } from "../shared/searchInputPresentation";

// ── Forbids-input-ref slots ───────────────────────────────────────

/**
 * The known-inputs list handed to an editor whose slot runs BEFORE the
 * search screen opens — default values, calculated columns, and the
 * search-button "show when" condition. Those slots resolve an
 * `input(...)` ref to the empty string, so the gate
 * (`CASE_LIST_BARE_SEARCH_INPUT_REF`, forbids-input-ref) rejects one
 * with no valid resolution; offering "Search Field" as a value source
 * there would only lead the author into a guaranteed rejection.
 * Session / user-data fields stay available — they're bound at that
 * time.
 *
 * A frozen module-level constant so the empty list keeps a stable
 * identity across renders: the editors memoize their type-check
 * context on `knownInputs`, and a fresh `[]` each render would thrash
 * those memos.
 */
export const NO_SEARCH_INPUTS: readonly SearchInputDecl[] = Object.freeze([]);

// ── Display labels ────────────────────────────────────────────────

export const SEARCH_INPUT_TYPE_LABELS: Record<SearchInputType, string> = {
	text: "Text box",
	select: "Choice list",
	date: "Date picker",
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

/** Plain-words explanation per field type — what the field looks
 *  like in the running app. Shown in the picker beside each label. */
export const SEARCH_INPUT_TYPE_DESCRIPTIONS: Record<SearchInputType, string> = {
	text: "A box to type into",
	select: "Choose another field type before Preview can run",
	date: "A calendar for one date",
	"date-range": "Two calendars for a start and end date",
	barcode: "A field for scanning a barcode",
};

/**
 * Outcome-first names for match behavior. Storage keeps its exact mode names,
 * but the authoring surface describes what people can expect from each choice.
 */
export const SEARCH_MODE_LABELS: Record<SearchInputMode["kind"], string> = {
	exact: "Exact value",
	fuzzy: "Similar spelling",
	"starts-with": "Begins with",
	phonetic: "Sounds like",
	"fuzzy-date": "Flexible date",
	range: "Between dates",
	"multi-select-contains": "Includes options",
};

/**
 * Per-mode explanation, shown in the Match picker and as the chosen
 * mode's hint. These are exact behavioral claims, not vibes — each
 * one states what CommCare's search actually does with the typed
 * value, because the gap between "Exact" and "Fuzzy" is the gap
 * between "search looks broken" and "search works": exact is
 * letter-for-letter including capitalization, which surprises
 * everyone the first time.
 *
 * Behavioral ground truth (mirrored by the case store's Postgres
 * compiler and CommCare HQ's Elasticsearch layer):
 *   - exact: whole-value term match, case-sensitive.
 *   - fuzzy: per-word — a word matches if it equals a word of the
 *     value (ignoring case), or sits within 1 edit (words of 3–5
 *     letters) / 2 edits (6+) of one sharing its first two letters.
 *     It does NOT match partial words: "bo" never finds "bob".
 *   - starts-with: prefix of the whole value, case-sensitive.
 *   - phonetic: Soundex per word — same spoken shape, any spelling.
 *   - fuzzy-date: the typed date plus its digit-permutation set
 *     (swapped day/month, reversed digit pairs).
 */
export const SEARCH_MODE_DESCRIPTIONS: Record<SearchInputMode["kind"], string> =
	{
		exact: "Finds only the same complete value, including capitalization",
		fuzzy:
			"Finds words with small spelling differences and ignores capitalization",
		"starts-with":
			"Finds values beginning the same way, including capitalization",
		phonetic: "Finds names that sound alike, such as Smith and Smyth",
		"fuzzy-date": "Allows a swapped day and month or a small typing mistake",
		range: "Finds dates between the From and To values",
		"multi-select-contains": "Finds cases that include the selected options",
	};

const PROPERTY_TYPE_NAMES: Record<CasePropertyDataType, string> = {
	text: "text",
	int: "number",
	decimal: "number",
	date: "date",
	time: "time",
	datetime: "date and time",
	single_select: "single-choice",
	multi_select: "multiple-choice",
	geopoint: "location",
};

function friendlyPropertyTypes(types: readonly CasePropertyDataType[]): string {
	return [...new Set(types.map((type) => PROPERTY_TYPE_NAMES[type]))].join(
		" or ",
	);
}

/** The mode a row actually runs with — its explicit mode, or the
 *  per-type default when the slot is absent. */
export function effectiveModeKind(
	input: SearchInputDef,
): SearchInputMode["kind"] {
	if (input.kind === "advanced") return "exact";
	return effectiveSimpleSearchModeKind(input);
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
	const propertyName = canonicalCasePropertyName(row.property);
	return authorableCaseProperties(ct?.properties ?? []).find(
		(property) => property.name === propertyName,
	);
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
				.join(" or ");
			errors.push(
				`“${SEARCH_MODE_LABELS[modeKind]}” doesn’t work with ${SEARCH_INPUT_TYPE_LABELS[row.type]}. Choose ${allowedLabels}.`,
			);
		}
	}

	// Property-anchored gates. Skip when property is unresolved.
	if (property === undefined) return errors;
	const dataType = effectiveDataType(property);

	const typeAllowList = SEARCH_INPUT_TYPE_PROPERTY_TYPES[row.type];
	if (typeAllowList !== undefined && !typeAllowList.includes(dataType)) {
		errors.push(
			`${SEARCH_INPUT_TYPE_LABELS[row.type]} can’t search ${propertyDisplayLabel(property)}. Choose ${friendlyPropertyTypes(typeAllowList)} information.`,
		);
	}

	if (row.mode !== undefined) {
		const modeAllowList = SEARCH_MODE_PROPERTY_TYPES[row.mode.kind];
		if (modeAllowList !== undefined && !modeAllowList.includes(dataType)) {
			errors.push(
				`“${SEARCH_MODE_LABELS[row.mode.kind]}” can’t match ${propertyDisplayLabel(property)}. Choose ${friendlyPropertyTypes(modeAllowList)} information.`,
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
// The search inputs in scope for a row's advanced-predicate / type-
// check editor are EVERY named row — the edited row INCLUDED. A search
// input's custom condition is keyed to its OWN input through the
// `when-input-present(input(name), …)` envelope that both
// `seedCustomCondition` and the wire-emit `deriveSimpleArmPredicate`
// produce, so a row referencing its own input is the canonical shape,
// not a self-reference to forbid. This mirrors the validator's
// `moduleTypeContext`, which builds `knownInputs` from the full
// `caseListConfig.searchInputs` list — editor, preview gate, commit
// gate, and wire emitter all resolve `input(...)` against ONE scope,
// so none can flag a reference the others accept.
//
// Slots that run BEFORE the search screen opens — default values,
// calculated columns, the search-button condition — see NO inputs at
// all (`NO_SEARCH_INPUTS`): an `input(...)` ref there resolves to the
// empty string and the commit gate rejects it.

export function deriveSearchInputDecl(
	row: SearchInputDef,
): EditorSearchInputDecl {
	return {
		name: row.name,
		label: row.label,
		data_type: SEARCH_INPUT_RUNTIME_VALUE_TYPES[row.type],
	};
}

export function searchInputDecls(
	rows: readonly SearchInputDef[],
): readonly EditorSearchInputDecl[] {
	const decls: EditorSearchInputDecl[] = [];
	for (const row of rows) {
		if (row.name === "") continue;
		decls.push(deriveSearchInputDecl(row));
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
			return "date";
		case "date-range":
			return undefined;
		case "select":
			return undefined;
	}
}

/**
 * The default-value slot's `SlotConstraint` — the editor's
 * valid-by-construction surface for the default expression. A value
 * compatible with the input's `expectedTypeForDefault` (or
 * unconstrained for `select`, which accepts any option value). The
 * config-validity gate keeps using `expectedTypeForDefault` directly
 * (a single-type `checkValueExpression` arm); this is its set-valued
 * twin for the editor's pickers. Frozen module-level entries so the
 * constraint identity stays stable across renders (the editor memoizes
 * on it).
 */
export type ScalarDefaultSearchInputType = Exclude<
	SearchInputType,
	"date-range"
>;

const CONSTRAINT_FOR_DEFAULT: Record<
	ScalarDefaultSearchInputType,
	SlotConstraint
> = {
	text: { accepts: compatibleTypesFor("text") },
	barcode: { accepts: compatibleTypesFor("text") },
	date: { accepts: compatibleTypesFor("date") },
	select: ANY_CONSTRAINT,
};

export function constraintForDefault(
	type: ScalarDefaultSearchInputType,
): SlotConstraint {
	return CONSTRAINT_FOR_DEFAULT[type];
}

export function seedDefaultExpression(
	type: ScalarDefaultSearchInputType,
): ValueExpression {
	switch (type) {
		case "date":
			return today();
		case "text":
		case "barcode":
		case "select":
			return term(literal(""));
	}
}

// ── Custom-condition seeding + recovery ───────────────────────────
//
// The Match picker's "Custom Condition" choice converts a simple row
// to the advanced arm; these two functions are the conversion's two
// halves — the forward seed and the round-trip recovery.

/**
 * Whether the simple row's effective match behavior has an equivalent
 * Predicate AST shape that can keep reading this row's runtime input.
 *
 * Equality and the four text/date match functions accept a runtime
 * `input(...)` value, so their simple-arm semantics can move into a custom
 * condition without changing. A range input is two runtime bindings while
 * the Predicate AST has no range-input term, and multi-select containment's
 * values are deliberately literal-only. Those two modes therefore need an
 * explicit consequence confirmation before the UI calls
 * `seedCustomCondition`'s exact-match recovery seed.
 */
export function canSeedCustomConditionFaithfully(
	row: SimpleSearchInputDef,
): boolean {
	switch (effectiveModeKind(row)) {
		case "exact":
		case "fuzzy":
		case "starts-with":
		case "phonetic":
		case "fuzzy-date":
			return true;
		case "range":
		case "multi-select-contains":
			return false;
	}
}

/**
 * Seed the custom condition with the row's effective behavior. Exact mode
 * becomes `property = typed value`; fuzzy, starts-with, phonetic, and
 * fuzzy-date become the corresponding `match` Predicate. The author edits
 * forward from something working instead of starting from a blank. Rows with
 * no property yet seed `match-all()` — the canonical always-true starting
 * point.
 *
 * The comparison against the typed value rides inside a
 * `when-input-present` envelope keyed to the input — the same shape
 * the standard match modes derive at wire-emit
 * (`deriveSimpleArmPredicate`). Without it the bare `input(...)` ref
 * resolves to the empty string before anyone searches, matching every
 * empty-valued case, and the commit gate
 * (`CASE_LIST_BARE_SEARCH_INPUT_REF`) rejects the seed outright — so
 * the envelope is what makes "Custom Condition" land at all. A
 * nameless row compares to a literal, carries no input ref, and needs
 * no envelope.
 *
 * The property reference preserves the row's relation walk the same
 * way `deriveSimpleArmPredicate` does: a non-self `via` threads through
 * so the seed reads the property on the case the row actually searches
 * (a parent / related case), not the current one; a self walk
 * collapses to an unqualified `prop`. Dropping it would seed a
 * condition that reads a property the current case type may not have —
 * a fresh gate rejection, the very failure this conversion avoids.
 */
export function seedCustomCondition(
	row: SimpleSearchInputDef,
	currentCaseType: string,
): Predicate {
	if (row.property === "") return matchAll();
	const viaForRef =
		row.via === undefined || row.via.kind === "self" ? undefined : row.via;
	const propertyRef = prop(currentCaseType, row.property, viaForRef);
	if (row.name === "") return eq(propertyRef, literal(""));
	const inputRef = input(row.name);
	const modeKind = effectiveModeKind(row);
	const clause = (() => {
		switch (modeKind) {
			case "exact":
				return eq(propertyRef, inputRef);
			case "fuzzy":
			case "starts-with":
			case "phonetic":
			case "fuzzy-date":
				return match(propertyRef, inputRef, modeKind);
			case "range":
			case "multi-select-contains":
				// Neither mode can carry its runtime value(s) into the current
				// Predicate AST. The caller must gate this branch with
				// `canSeedCustomConditionFaithfully` and confirm that the custom
				// condition will begin as an exact comparison.
				return eq(propertyRef, inputRef);
		}
	})();
	return whenInput(inputRef, clause);
}

/**
 * The property a custom condition is anchored on, when it has the
 * left-anchored shape (`comparison` / `in` / `between` / `is-null` /
 * `is-blank` whose left side reads a self property). Lets a
 * round-tripped custom→standard conversion land back on the same
 * property rather than re-seeding.
 *
 * A `when-input-present` envelope — the shape `seedCustomCondition`
 * produces for an input-bound row — unwraps to its clause first, so a
 * seeded custom condition round-trips back to its property the same
 * way a hand-authored bare comparison does.
 */
export function recoverAnchoredProperty(
	predicate: Predicate,
): string | undefined {
	const inner =
		predicate.kind === "when-input-present" ? predicate.clause : predicate;
	if (!("left" in inner)) return undefined;
	const left = inner.left;
	if (left.kind !== "term" || left.term.kind !== "prop") return undefined;
	const ref = left.term;
	if (ref.via !== undefined && ref.via.kind !== "self") return undefined;
	return ref.property;
}
