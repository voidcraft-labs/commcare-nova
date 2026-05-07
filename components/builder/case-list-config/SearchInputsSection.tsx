// components/builder/case-list-config/SearchInputsSection.tsx
//
// Drag-orderable list of `SearchInputDef` rows. Each row owns:
//
//   - `name` — programmatic identifier (`instance('search-input')/
//     input/field[@name='X']`). Validated for non-empty + uniqueness
//     across siblings.
//   - `label` — author-facing widget label. Validated for non-empty.
//   - `type` — widget kind picker (text / select / date / date-range
//     / barcode). Sourced from `SEARCH_INPUT_TYPES`.
//   - `property` — optional case property the input targets, picked
//     through the shared `PropertyRefPicker` (mode `property-only`).
//     Absent when the input is "advanced" — every predicate flows
//     through `xpath`.
//   - `via` — optional relation walk to a destination case type,
//     edited through the shared `RelationPathBuilder`. The builder
//     defaults to `selfPath()` UI-side, but `searchInputDef(...)`
//     omits the slot when the path is `self`-shaped so round-trip
//     equality against persisted documents that omitted the slot
//     stays intact.
//   - `mode` — optional explicit search mode picker. Filtered by the
//     `(type, property data type)` matrix from `applicableSearchModes`
//     + `SEARCH_MODE_PROPERTY_TYPES`.
//   - `default` — optional default-value `ValueExpression`, edited
//     through `ExpressionCardEditor`. The expected type derives from
//     the input's `type` (date / date-range → `date`; barcode → `text`;
//     text → `text`; select declines an expectedType because the
//     property's `data_type` is the better signal).
//   - `xpath` — optional advanced `Predicate`, edited through
//     `PredicateCardEditor`. When present, the wire layer uses it
//     verbatim and ignores the `(property, mode)`-derived predicate;
//     the editor surfaces this via an "Advanced override" banner +
//     by hiding the property + mode pickers.
//
// Mirrors `CalculatedColumnEditor`'s shape: per-mount `containerKey`
// for the reorder monitor, per-row `nodeId(...)` React keys
// (WeakMap-backed survival across reorders), unified `resolveRows`
// helper consumed by both inline-error rendering AND the editor's
// `valid` aggregation so display and validity propagation share a
// single source of truth — display/validity asymmetry is structurally
// impossible (per `feedback_always_in_valid_state.md`).
//
// **Hard validation** for type-coupling. Per `feedback_always_in_valid_state.md`,
// a search input declared on a property whose `data_type` doesn't
// satisfy the picked `(type, mode)` pair flips `valid: false` rather
// than surfacing a soft warning. The umbrella principle: Nova rejects
// CCHQ's "save broken, fix later" gauntlet. The user sees inline
// red diagnostics + the parent's save affordance gates correctly.
//
// **Cross-input references in default / xpath.** Each row's
// `ExpressionCardEditor` / `PredicateCardEditor` receives a
// `knownInputs` derived from the OTHER rows. A row can reference any
// sibling input via `input("other_name")` without the type checker
// rejecting the reference; self-references are excluded so the row's
// own name doesn't shadow itself mid-edit (and the user authoring a
// fresh row with a not-yet-named input doesn't see spurious "input
// not declared" errors during the per-keystroke draft phase).

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerBarcode from "@iconify-icons/tabler/barcode";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCalendarStats from "@iconify-icons/tabler/calendar-stats";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerGripVertical from "@iconify-icons/tabler/grip-vertical";
import tablerListSearch from "@iconify-icons/tabler/list-search";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import tablerSelect from "@iconify-icons/tabler/select";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId, useMemo, useRef } from "react";
import {
	applicableSearchModes,
	type CaseProperty,
	type CaseType,
	effectiveDataType,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	type MultiSelectQuantifier,
	multiSelectContainsMode,
	phoneticMode,
	rangeMode,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	SEARCH_INPUT_TYPES,
	SEARCH_MODE_PROPERTY_TYPES,
	type SearchInputDef,
	type SearchInputMode,
	type SearchInputType,
	searchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	literal,
	matchAll,
	type Predicate,
	prop,
	type RelationPath,
	type ResolvedType,
	type SearchInputDecl,
	selfPath,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { ExpressionCardEditor } from "./ExpressionCardEditor";
import { buildValidityIndex, PredicateEditProvider } from "./editorContext";
import { nodeId } from "./nodeIdentity";
import { PredicateCardEditor } from "./PredicateCardEditor";
import { BlurCommitTextInput } from "./primitives/BlurCommitTextInput";
import { InlineError } from "./primitives/CardShell";
import { PropertyRefPicker } from "./primitives/PropertyRefPicker";
import { RelationPathBuilder } from "./primitives/RelationPathBuilder";
import {
	useInnerValidityShadow,
	useValidityPropagator,
} from "./useInnerValidityShadow";
import { ReorderableRow, useReorderableList } from "./useReorderableList";

// ── Public types ──────────────────────────────────────────────────

export interface SearchInputsSectionProps {
	/** The current case-list config's search inputs. Order matters
	 *  — the runtime renders the search form's inputs in declaration
	 *  order. */
	readonly value: readonly SearchInputDef[];
	readonly onChange: (next: readonly SearchInputDef[]) => void;
	readonly caseTypes: readonly CaseType[];
	/** The case-type the case list runs against. Property pickers
	 *  scope here at the top level; relation walks (`via`) navigate
	 *  to other case types. */
	readonly currentCaseType: string;
	/** Surfaces the editor's overall validity to the parent. The
	 *  aggregated verdict combines:
	 *    - per-row `name` non-empty + unique among siblings.
	 *    - per-row `label` non-empty.
	 *    - per-row type-coupling (type vs property's data type;
	 *      mode vs property's data type).
	 *    - per-row inner `default` expression validity (when present).
	 *    - per-row inner `xpath` predicate validity (when present). */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Display labels ────────────────────────────────────────────────
//
// Centralized author-facing labels for each `SearchInputType` and
// `SearchInputMode`. The schema's enum values are wire-shaped
// (`date-range`, `multi-select-contains`); the picker UI shows
// human-friendly labels keyed off the same enum. Keeping the labels
// in one place keeps the trigger label, the menu items, and any
// inline error vocabulary aligned.

const SEARCH_INPUT_TYPE_LABELS: Record<SearchInputType, string> = {
	text: "Text",
	select: "Select",
	date: "Date",
	"date-range": "Date range",
	barcode: "Barcode",
};

const SEARCH_INPUT_TYPE_ICONS: Record<SearchInputType, IconifyIcon> = {
	text: tablerSearch,
	select: tablerSelect,
	date: tablerCalendar,
	"date-range": tablerCalendarStats,
	barcode: tablerBarcode,
};

const SEARCH_MODE_LABELS: Record<SearchInputMode["kind"], string> = {
	exact: "Exact",
	fuzzy: "Fuzzy",
	"starts-with": "Starts with",
	phonetic: "Phonetic",
	"fuzzy-date": "Fuzzy date",
	range: "Range",
	"multi-select-contains": "Multi-select contains",
};

// ── Per-mode builder lookup ───────────────────────────────────────
//
// The picker emits the canonical builder shape for each mode. The
// `multi-select-contains` arm requires a quantifier; the other arms
// are zero-arg. Routing every emission through the builder keeps the
// constructed shape in lockstep with `searchInputModeSchema`.

function buildMode(
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
//
// One helper computes per-row `{ nameState, labelEmpty,
// typeCouplingErrors }` and is consumed by BOTH the inline-error
// chrome on the row AND the editor's `valid` aggregation. Two
// independent computations is the failure mode
// `feedback_always_in_valid_state.md` rules out; centralizing here
// keeps display chrome and validity propagation in lockstep.

type NameState =
	/** Non-empty + unique among siblings. */
	| { kind: "ok" }
	/** Empty string — the user hasn't named the input yet. */
	| { kind: "empty" }
	/** Duplicate against an earlier index. First occurrence at
	 *  `firstIndex` wins; this row's name flags. The wire layer
	 *  binds inputs by name into the `instance('search-input')`
	 *  document, so a duplicate name would silently overwrite the
	 *  first occurrence's binding at evaluation. */
	| { kind: "duplicate"; firstIndex: number };

interface ResolvedRow {
	readonly nameState: NameState;
	readonly labelEmpty: boolean;
	/** Type-coupling diagnostics — empty when the picked
	 *  `(type, mode)` pair is admissible against the targeted
	 *  property's `data_type`. Per `feedback_always_in_valid_state.md`
	 *  the verdict flips `valid: false` whenever this list is
	 *  non-empty (no soft "warning" tier). */
	readonly typeCouplingErrors: readonly string[];
}

/**
 * Resolve every row's status against the sibling list + the editor's
 * `caseTypes` + `currentCaseType` context. The "first-occurrence
 * wins" rule on duplicate names matches the wire layer's binding
 * behavior — `input("name")` resolves to the first declaration in
 * the search-input list.
 *
 * Building the `firstIndexByName` map up-front keeps the per-row
 * pass O(n) rather than O(n²) — without the precomputed index, each
 * row's sibling scan would re-sweep the full list.
 */
function resolveRows(
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
		// Name state: empty → `empty`; duplicate against an earlier
		// index → `duplicate`; otherwise → `ok`.
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

		// Type-coupling diagnostics. The xpath-override branch hides
		// the property + mode pickers entirely (the runtime ignores
		// `(property, mode)` when `xpath` is present), so the per-
		// property type-coupling check is also bypassed there.
		const typeCouplingErrors =
			row.xpath !== undefined
				? []
				: computeTypeCouplingErrors(
						row,
						resolveProperty(caseTypes, row, currentCaseType),
					);

		return {
			nameState,
			labelEmpty: row.label === "",
			typeCouplingErrors,
		};
	});
}

/**
 * Resolve the targeted property reference against the `caseTypes`
 * graph. Returns the `CaseProperty` object when the row's `property`
 * names a declared property on the row's effective scope (the `via`
 * walk's destination, or `currentCaseType` when no walk is set),
 * else `undefined`.
 *
 * The `via`-walk destination is approximated here: the editor's
 * `RelationPathBuilder` only emits canonical single-step
 * `ancestorPath` / `subcasePath` / `selfPath` shapes, and the type-
 * coupling check needs a destination case-type to resolve the
 * property against. For `selfPath()` the destination is the row's
 * scope (`currentCaseType`); for `ancestor` / `subcase` walks the
 * destination resolves through the case-type graph — but since the
 * editor's relation builder doesn't surface destination scope
 * inline AND the wire layer's per-mode property-type gate is the
 * runtime authority, the editor falls back to `currentCaseType`
 * when the destination can't be resolved structurally.
 */
function resolveProperty(
	caseTypes: readonly CaseType[],
	row: SearchInputDef,
	currentCaseType: string,
): CaseProperty | undefined {
	if (row.property === undefined || row.property === "") return undefined;
	// Walk destination resolution.
	const destinationCaseType = resolveDestinationCaseType(
		caseTypes,
		row.via,
		currentCaseType,
	);
	const ct = caseTypes.find((c) => c.name === destinationCaseType);
	return ct?.properties.find((p) => p.name === row.property);
}

/**
 * Resolve a relation walk's destination case type given the editor's
 * `caseTypes` graph + the row's `currentCaseType` anchor:
 *
 *   - Absent / `self` → `currentCaseType` (no walk).
 *   - `ancestor` (single-step canonical shape from the editor) →
 *     the `parent_type` of the current case type (CCHQ's standard
 *     parent walk); falls back to `currentCaseType` when the case
 *     type doesn't declare a `parent_type`.
 *   - `subcase` (single-step canonical shape) → currentCaseType.
 *     The editor's single-step shape doesn't surface the
 *     destination qualifier; the wire layer's per-mode property-
 *     type gate is the runtime authority for stricter resolution.
 *   - `any-relation` / multi-hop / qualified shapes — the editor's
 *     `RelationPathBuilder` doesn't emit these (they route through
 *     the read-only badge + Replace affordance); the case is
 *     unreachable from the editor's emit path but kept defensible
 *     here against persisted documents from external authoring
 *     surfaces.
 */
function resolveDestinationCaseType(
	caseTypes: readonly CaseType[],
	via: RelationPath | undefined,
	currentCaseType: string,
): string {
	if (via === undefined) return currentCaseType;
	switch (via.kind) {
		case "self":
			return currentCaseType;
		case "ancestor": {
			// Walk one step via the case type's `parent_type`. The
			// editor's `RelationPathBuilder` emits single-step ancestor
			// walks only; multi-hop walks route through the read-only
			// badge surface.
			const ct = caseTypes.find((c) => c.name === currentCaseType);
			return ct?.parent_type ?? currentCaseType;
		}
		case "subcase":
			// The editor's single-step subcase walk doesn't surface a
			// destination-qualifier slot. The wire layer's per-mode
			// property-type gate is the runtime authority; the editor
			// falls back to `currentCaseType` for the type-coupling
			// approximation here.
			return currentCaseType;
		case "any-relation":
			return currentCaseType;
	}
}

/**
 * Compute the type-coupling diagnostics for a single row given the
 * targeted property's `CaseProperty` (when resolvable). Three
 * orthogonal checks combine:
 *
 *   1. Widget-kind vs property data-type — the input's `type` admits
 *      a closed set of property `data_type`s per
 *      `SEARCH_INPUT_TYPE_PROPERTY_TYPES`. A `barcode` input declared
 *      on an `int` property is structurally meaningless.
 *
 *   2. Mode vs property data-type — the input's `mode` (when set)
 *      admits a closed set of property `data_type`s per
 *      `SEARCH_MODE_PROPERTY_TYPES`. A `fuzzy` mode declared on an
 *      `int` property is structurally meaningless.
 *
 *   3. Mode vs widget-kind — the picked `mode` must appear in the
 *      `applicableSearchModes(type)` table. The editor's mode picker
 *      filters by this table, so this check is normally satisfied
 *      by construction; the redundant gate here covers persisted
 *      documents that drifted (e.g. a saved `(date, fuzzy)` pair
 *      authored before the table was tightened).
 *
 * No diagnostics fire when the property is unresolved (row has no
 * `property` set, or the property is missing from the case type) —
 * the user is mid-edit, and the empty-property case has its own
 * per-slot signal at the picker. The xpath-override branch (handled
 * upstream in `resolveRows`) bypasses every type-coupling check.
 */
function computeTypeCouplingErrors(
	row: SearchInputDef,
	property: CaseProperty | undefined,
): readonly string[] {
	const errors: string[] = [];

	// Mode vs widget-kind gate. Read first so a saved `(date, fuzzy)`
	// pair surfaces the mismatch even when the property is unresolved
	// — the gate doesn't depend on the property at all.
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

	// Property-anchored gates. Skip when the property is unresolved
	// — the user is mid-edit, the picker surfaces its own placeholder,
	// and the parent-section's empty-property signal handles the gate
	// at the right level.
	if (property === undefined) return errors;

	const dataType = effectiveDataType(property);

	// Widget-kind vs property data-type. `undefined` in the table
	// means unrestricted (the kind admits every data type).
	const typeAllowList = SEARCH_INPUT_TYPE_PROPERTY_TYPES[row.type];
	if (typeAllowList !== undefined && !typeAllowList.includes(dataType)) {
		errors.push(
			`${SEARCH_INPUT_TYPE_LABELS[row.type]} input is not valid for ${dataType} property "${row.property}"; pick a ${typeAllowList.join(" / ")} property.`,
		);
	}

	// Mode vs property data-type. `undefined` means the mode is
	// unrestricted (e.g. `exact` admits every data type).
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

/**
 * Decide whether a resolved row carries any structural error. A
 * row is "ok" when the name is non-empty + unique among siblings AND
 * the label is non-empty AND the type-coupling errors are empty.
 *
 * Returns a boolean rather than a list of strings — the inline-error
 * chrome renders the per-slot messages directly off the structured
 * `ResolvedRow` fields, so a parallel string vocabulary here would
 * be a second source of truth that drifts. The `valid` aggregation
 * reads only the boolean; the renderer reads the structured shape.
 */
function rowHasStructuralError(resolved: ResolvedRow): boolean {
	if (resolved.nameState.kind !== "ok") return true;
	if (resolved.labelEmpty) return true;
	if (resolved.typeCouplingErrors.length > 0) return true;
	return false;
}

// ── knownInputs derivation ────────────────────────────────────────
//
// Each row's inner `ExpressionCardEditor` / `PredicateCardEditor`
// receives the SIBLING rows' search-input declarations as
// `knownInputs`. This lets a row's `default` / `xpath` reference any
// other input via `input("other_name")` without the type checker
// rejecting the reference.
//
// Self-references are excluded so the row's own name doesn't shadow
// itself mid-edit. A row that's still being authored (empty name,
// just-typed name, etc.) doesn't see its own freshly-typed name as
// "input not declared in scope" before the user tabs out — but it
// also doesn't see its own name as a valid binding (the runtime
// can't bind an input to itself; the wire layer surfaces a
// reference-cycle error).
//
// `data_type` derivation per input type:
//   - `text` / `barcode` → `text` (the input serializes as a
//     plain string).
//   - `date` / `date-range` → `date` (the input emits a typed date
//     literal).
//   - `select` → falls back to the targeted property's `data_type`
//     (`single_select` / `multi_select`); `text` if the property
//     isn't resolvable. The wire layer hands selects through as
//     their option-value string at the wire boundary.

function deriveSearchInputDecl(
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
			// Selects derive their declared `data_type` from the
			// targeted property when resolvable. Falls back to `text`
			// when the property isn't set / isn't declared — same
			// fallback the type-checker uses for un-annotated
			// properties.
			const property = resolveProperty(caseTypes, row, currentCaseType);
			if (property === undefined) {
				return { name: row.name, data_type: "text" };
			}
			const dataType = effectiveDataType(property);
			// Narrow to the select-typed shapes; otherwise default to
			// `text` (the input still serializes as a string at the
			// wire boundary).
			if (dataType === "single_select" || dataType === "multi_select") {
				return { name: row.name, data_type: dataType };
			}
			return { name: row.name, data_type: "text" };
		}
	}
}

/**
 * Compute the `knownInputs` array each row's inner editor sees:
 * every sibling row's declaration except this row's own. The
 * derived `data_type` follows the per-type fallback rules in
 * `deriveSearchInputDecl`.
 */
function computeKnownInputsForRow(
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

// ── Default-value expectedType ────────────────────────────────────
//
// The `expectedType` threaded into each row's `default` editor lets
// the inner type checker fire its own "Expected X; resolves to Y"
// diagnostic alongside the row-level type-coupling check.
//
//   - `text` / `barcode` → `text`. The wire layer serializes the
//     default as a plain string.
//   - `date` / `date-range` → `date`. The wire layer emits a typed
//     date literal at evaluation.
//   - `select` → undefined. The select's value type depends on the
//     targeted property's `data_type` (`single_select` /
//     `multi_select`), which is the better signal — the inner
//     editor's literal slot picks the type from there. Threading
//     `text` here would force every select default to type-check
//     as `text`, which is a wire-layer truth but not the editing
//     truth.

function expectedTypeForDefault(
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

// ── Default-value seed ────────────────────────────────────────────
//
// When the user clicks "Add default value", the default-value slot
// seeds with a per-type-appropriate expression so the inner editor
// surfaces a meaningful starting point rather than an empty literal:
//
//   - `date` / `date-range` → `today()` (the project-timezone ISO
//     date constant — the canonical date-typed seed).
//   - `text` / `barcode` / `select` → `term(literal(""))` (an
//     empty-string literal lift, the same shape
//     `CalculatedColumnEditor` uses for fresh expression rows).

function seedDefaultExpression(type: SearchInputType): ValueExpression {
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

// ── Top-level editor ──────────────────────────────────────────────

/**
 * Drag-orderable list of `SearchInputDef` rows. Composes the per-
 * row editor surface + an "Add search input" affordance + the
 * validity propagation contract. Mutations route through the
 * `searchInputDef(...)` builder so the constructed shape stays in
 * lockstep with `searchInputDefSchema` (and the optional-slot
 * omission semantics — `via: selfPath()` collapses to absent —
 * apply uniformly).
 */
export function SearchInputsSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	onValidityChange,
}: SearchInputsSectionProps) {
	// Per-mount stable id for the reorder container. The editor's
	// `value` is a plain array (no envelope object to use as a
	// `nodeId(...)` lookup key); a per-mount UUID gives the monitor
	// a stable scope across re-renders without coupling to the
	// array reference.
	const containerKey = useId();

	// Resolve every row's status once per render. The unified pass
	// feeds both the inline-error chrome AND the editor's `valid`
	// aggregation.
	const resolvedPerRow = useMemo(
		() => resolveRows(value, caseTypes, currentCaseType),
		[value, caseTypes, currentCaseType],
	);

	const hasStructuralErrorPerRow = useMemo(
		() => resolvedPerRow.map((r) => rowHasStructuralError(r)),
		[resolvedPerRow],
	);

	// Per-row inner-editor validity. Each row's `default` / `xpath`
	// editors fire `onValidityChange(boolean)` on every transition;
	// the shared `useInnerValidityShadow` hook maintains a row-
	// identity-keyed `WeakMap<SearchInputDef, boolean>` so a
	// reorder-then-flip never races against a stale index slot.
	const { aggregatedValid: innerAggregatedValid, setRowValid } =
		useInnerValidityShadow<SearchInputDef>(value);

	// Aggregated section-level verdict — every row's structural
	// errors empty AND the shadow's inner aggregation true.
	const isValid = useMemo(() => {
		for (let i = 0; i < value.length; i++) {
			if (hasStructuralErrorPerRow[i] === true) return false;
		}
		return innerAggregatedValid;
	}, [value, hasStructuralErrorPerRow, innerAggregatedValid]);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed against fresh-each-render parent
	// callback identity.
	useValidityPropagator({ isValid, onValidityChange });

	// Reorder wiring — per-container monitor scoped to `containerKey`.
	const { pendingDrop } = useReorderableList<SearchInputDef>({
		containerKey,
		containerKind: "search-inputs",
		items: value,
		onReorder: (next) => onChange(next),
	});

	// ── Mutators ──
	//
	// Every mutation rebuilds the affected row via
	// `searchInputDef(...)`. The builder's optional-slot omission
	// semantics keep round-trip equality intact across edits.

	const replaceRow = (index: number, next: SearchInputDef) => {
		onChange(value.map((r, i) => (i === index ? next : r)));
	};

	const removeRow = (index: number) => {
		// The row-identity-keyed shadow auto-collects entries when the
		// removed row's reference leaves React state — no manual
		// "drop this index" cleanup needed. The new `value` array
		// excludes the removed row, the next aggregation walks only
		// surviving rows, and the WeakMap entry is unreachable.
		onChange(value.filter((_, i) => i !== index));
	};

	const appendRow = () => {
		// Generate the fresh name at click time, NOT during render.
		// `crypto.randomUUID()` inside a render path would explode
		// the WeakMap-backed `nodeId(...)` identity (every render
		// emits a new name, every render emits a new key). The
		// `input_` prefix distinguishes auto-generated names from
		// author-renamed ones at-a-glance; the suffix is the v4
		// short-form (8 hex digits) so the name stays readable.
		const freshName = `input_${crypto.randomUUID().slice(0, 8)}`;
		// Default seed: text type, fresh name, empty label, no
		// property / mode / via / default / xpath. The
		// `searchInputDef(...)` builder omits every absent optional
		// slot so the seed parses through `safeParse(...).toEqual(input)`.
		// The shadow's "missing entry → trivially valid" default
		// covers the fresh row until its inner editors fire their
		// first verdicts.
		const seed = searchInputDef(freshName, "", "text");
		onChange([...value, seed]);
	};

	return (
		<div className="space-y-3">
			{/* Section header — title + add affordance. Mirrors the
			    visual chrome of `FiltersSection` so the case-list-config
			    panel reads as one consistent surface. */}
			<header className="flex items-baseline gap-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
				<Icon
					icon={tablerListSearch}
					width="14"
					height="14"
					className="text-nova-violet-bright/80 self-center"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					Search inputs
				</h3>
				<span className="ml-1 text-[10px] text-nova-text-muted/70">
					Form fields the user fills in to narrow the case list.
				</span>
			</header>

			<div className="space-y-1.5">
				{value.length === 0 && <EmptyState />}
				{value.map((row, i) => {
					// Fall back to a structurally-valid resolved row when
					// the array length is mid-transition (defensive — the
					// `useMemo` rebuilds on every `value` change so the
					// fallback is unreachable in practice, but TypeScript
					// can't prove the array indexing returns non-undefined
					// without the guard).
					const resolved = resolvedPerRow[i] ?? {
						nameState: { kind: "ok" } as const,
						labelEmpty: row.label === "",
						typeCouplingErrors: [] as readonly string[],
					};
					const hasStructuralError = hasStructuralErrorPerRow[i] === true;
					const knownInputs = computeKnownInputsForRow(
						value,
						i,
						caseTypes,
						currentCaseType,
					);
					return (
						<ReorderableRow
							// Stable per-row React key from the WeakMap-backed
							// `nodeId(row)` — the reorder hook splices existing
							// element references into the new array order, so
							// per-row identity persists across drag-drop AND
							// across the duplicate-name case (where a
							// `key={row.name}` would collide).
							key={nodeId(row)}
							index={i}
							containerKey={containerKey}
							containerKind="search-inputs"
							pendingDrop={pendingDrop}
							preview={<SearchInputDragPreview index={i} row={row} />}
						>
							{({
								wrapperRef,
								setHandleEl,
								closestEdge,
								previewPortal,
								beingMoved,
							}) => (
								<div
									ref={wrapperRef}
									className={`relative ${beingMoved ? "opacity-50" : ""}`}
								>
									{closestEdge !== null && (
										<div
											aria-hidden="true"
											className="absolute left-0 right-0 h-0.5 bg-nova-violet rounded-full"
											style={{
												top: closestEdge === "top" ? -3 : undefined,
												bottom: closestEdge === "bottom" ? -3 : undefined,
											}}
										/>
									)}
									<SearchInputRow
										value={row}
										index={i}
										resolved={resolved}
										hasStructuralError={hasStructuralError}
										caseTypes={caseTypes}
										currentCaseType={currentCaseType}
										knownInputs={knownInputs}
										onChange={(next) => replaceRow(i, next)}
										onRemove={() => removeRow(i)}
										// Route the row's combined inner verdict through
										// the row-identity-keyed shadow. Passing `row`
										// (the current SearchInputDef object) keys the
										// WeakMap entry to this row's reference so a
										// reorder-then-flip writes against the right slot.
										onInnerValidityChange={(valid) => setRowValid(row, valid)}
										setHandleEl={setHandleEl}
									/>
									{previewPortal}
								</div>
							)}
						</ReorderableRow>
					);
				})}
				<button
					type="button"
					onClick={appendRow}
					className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
					aria-label="Add search input"
				>
					<Icon icon={tablerPlus} width="11" height="11" />
					<span>Add search input</span>
				</button>
			</div>
		</div>
	);
}

// ── Empty state ────────────────────────────────────────────────────

function EmptyState() {
	return (
		<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20 px-3 py-3 text-[11px] text-nova-text-muted/70">
			<div className="flex items-center gap-1.5">
				<Icon
					icon={tablerListSearch}
					width="12"
					height="12"
					className="text-nova-text-muted/60"
				/>
				<span>
					No search inputs. Add one to give users a form field for narrowing the
					case list (e.g. patient name, date of birth).
				</span>
			</div>
		</div>
	);
}

// ── Per-row component ─────────────────────────────────────────────

interface SearchInputRowProps {
	readonly value: SearchInputDef;
	readonly index: number;
	readonly resolved: ResolvedRow;
	readonly hasStructuralError: boolean;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly onChange: (next: SearchInputDef) => void;
	readonly onRemove: () => void;
	/** Combined `default` + `xpath` validity verdict for the row.
	 *  Fired with `false` when EITHER the default-value editor OR the
	 *  xpath editor reports invalid; `true` only when both report
	 *  valid (or aren't mounted). The combination collapses two
	 *  sub-editors into one signal so the section's aggregated
	 *  validity stays index-keyed without a per-sub-editor shadow
	 *  matrix. */
	readonly onInnerValidityChange: (valid: boolean) => void;
	readonly setHandleEl: (el: HTMLElement | null) => void;
}

function SearchInputRow({
	value,
	index,
	resolved,
	hasStructuralError,
	caseTypes,
	currentCaseType,
	knownInputs,
	onChange,
	onRemove,
	onInnerValidityChange,
	setHandleEl,
}: SearchInputRowProps) {
	// Track each inner editor's verdict separately so the row can
	// AND them at every transition. Mirrors the section-level
	// shadow-array shape; a single combined boolean would lose the
	// "which editor flipped" signal that's the right thing to thread
	// up.
	const defaultValidRef = useRef(true);
	const xpathValidRef = useRef(true);
	const propagateValidity = () => {
		onInnerValidityChange(defaultValidRef.current && xpathValidRef.current);
	};

	// ── Mutators ──
	//
	// Each mutator rebuilds the row via the `searchInputDef(...)`
	// builder. The builder's optional-slot omission semantics keep
	// the constructed shape's optional slots aligned with the
	// schema's "absent ≡ ..." contracts.

	const setName = (name: string) => {
		onChange(rebuildRow(value, { name }));
	};
	const setLabel = (label: string) => {
		onChange(rebuildRow(value, { label }));
	};
	const setType = (type: SearchInputType) => {
		// Type change resets the `mode` slot ONLY when the current
		// mode is no longer admissible against the new type. Without
		// the gate, switching from `text` to `select` and back would
		// silently drop the user's previously-picked `fuzzy` mode;
		// keeping the mode when admissible preserves authoring intent.
		const applicable = applicableSearchModes(type);
		const keepMode =
			value.mode !== undefined && applicable.includes(value.mode.kind);
		onChange(
			rebuildRow(value, {
				type,
				...(keepMode ? {} : { mode: undefined }),
			}),
		);
	};
	const setProperty = (property: string) => {
		onChange(rebuildRow(value, { property }));
	};
	// Remove the property reference from the row. The `via` slot is
	// PRESERVED across the remove — a user removing the property
	// hasn't necessarily abandoned the relation walk, so re-adding a
	// property keeps the previously-authored walk on the new
	// reference. The schema admits this shape (both `property` and
	// `via` are independent optionals); the wire layer handles
	// "via without property" by falling through to the xpath
	// derivation when no property is targeted.
	const removeProperty = () => {
		onChange(rebuildRow(value, { property: undefined }));
	};
	const setVia = (via: RelationPath) => {
		onChange(rebuildRow(value, { via }));
	};
	const setMode = (mode: SearchInputMode | undefined) => {
		onChange(rebuildRow(value, { mode }));
	};
	const setDefault = (next: ValueExpression | undefined) => {
		// Reset the inner verdict to `true` when the slot becomes
		// undefined — the editor unmounts and the stale `false` left
		// behind by a clearing edit would otherwise leak past the
		// clear (same shape `FiltersSection` uses for its slot-
		// presence guard).
		if (next === undefined) {
			defaultValidRef.current = true;
			propagateValidity();
		}
		onChange(rebuildRow(value, { default: next }));
	};
	const setXpath = (next: Predicate | undefined) => {
		if (next === undefined) {
			xpathValidRef.current = true;
			propagateValidity();
		}
		onChange(rebuildRow(value, { xpath: next }));
	};

	const xpathPresent = value.xpath !== undefined;
	const propertyPresent = value.property !== undefined;
	const viaForBuilder = value.via ?? selfPath();

	// The row owns one `PredicateEditProvider` so the property +
	// relation pickers it mounts directly (`PropertyRefPicker`,
	// indirectly the `PropertyPicker` via `usePredicateEditContext`)
	// resolve case types + known inputs from a real context. The
	// row's `validityIndex` is empty — the row's validation surfaces
	// inline through `resolved.typeCouplingErrors` rather than via
	// the predicate-card path-keyed map. Inner sub-editors
	// (`ExpressionCardEditor`, `PredicateCardEditor`) mount their
	// own providers below this one and replace the context for
	// their own subtrees, so this provider only governs the row-
	// level pickers.
	// `knownInputs` and `caseTypes` are recomputed by the parent on
	// every render anyway; wrapping them in `useMemo([...arr])` would
	// allocate a fresh array each render AND memoize nothing. Pass
	// the readonly arrays straight through — `PredicateEditProvider`
	// accepts `readonly`. The validity-index is the only memoized
	// value; its `[]` dep makes the singleton-shape meaningful.
	const emptyValidityIndex = useMemo(() => buildValidityIndex([]), []);

	return (
		<PredicateEditProvider
			caseTypes={caseTypes}
			currentCaseType={currentCaseType}
			knownInputs={knownInputs}
			validityIndex={emptyValidityIndex}
		>
			<div
				className={[
					"group/row relative flex items-stretch gap-2 rounded-md border bg-nova-surface/40 px-2 py-2 transition-colors",
					hasStructuralError
						? "border-nova-error/35 shadow-[inset_0_0_0_1px_rgba(255,90,120,0.12)]"
						: "border-white/[0.04]",
				].join(" ")}
			>
				{/* Position badge + drag handle. */}
				<div className="flex flex-col items-center gap-1 pt-0.5">
					<button
						type="button"
						ref={setHandleEl}
						aria-label="Reorder search input"
						className="cursor-grab text-nova-text-muted/50 hover:text-nova-text-muted transition-colors"
					>
						<Icon icon={tablerGripVertical} width="14" height="14" />
					</button>
					<span
						aria-hidden="true"
						className="text-[10px] font-mono text-nova-text-muted/40"
					>
						{index + 1}
					</span>
				</div>

				{/* Body — all the row's pickers + sub-editors. */}
				<div className="min-w-0 flex-1 space-y-2">
					{/* Name / label / type — top row. Three columns on wide
				    screens; stacks on narrow. */}
					<div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-1.5">
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Name
							</div>
							<BlurCommitTextInput
								value={value.name}
								onCommit={setName}
								placeholder="input_name"
								ariaLabel={`Search input ${index + 1} name`}
								monospace
							/>
							{resolved.nameState.kind === "empty" && (
								<InlineError errors={["Name is required."]} />
							)}
							{resolved.nameState.kind === "duplicate" && (
								<InlineError
									errors={[
										`Already used by row ${resolved.nameState.firstIndex + 1}.`,
									]}
								/>
							)}
						</div>
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Label
							</div>
							<BlurCommitTextInput
								value={value.label}
								onCommit={setLabel}
								placeholder="Display label"
								ariaLabel={`Search input ${index + 1} label`}
							/>
							{resolved.labelEmpty && (
								<InlineError errors={["Label is required."]} />
							)}
						</div>
						<div className="block">
							<div className="block text-[10px] uppercase tracking-widest text-nova-text-muted/60 mb-1">
								Type
							</div>
							<TypePicker
								value={value.type}
								onChange={setType}
								rowIndex={index}
							/>
						</div>
					</div>

					{/* xpath-override branch — when the row carries an xpath
				    predicate, the wire layer ignores the (property, mode)
				    derivation entirely. The editor surfaces this via an
				    "Advanced override" banner + by hiding the property +
				    mode pickers. The user sees one clear narrative
				    rather than two parallel filters fighting silently. */}
					{xpathPresent ? (
						<div className="rounded-md border border-amber-300/15 bg-amber-300/[0.04] px-2 py-1.5 text-[10px] text-amber-300/80">
							Advanced override active — the predicate below replaces the
							property + mode derivation.
						</div>
					) : (
						<>
							{/* Property + mode pickers. The relation-walk
						    builder mounts only when the user has chosen
						    a property (the walk is meaningless without
						    a property to read at the destination). */}
							<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
								<div className="flex items-center gap-1.5">
									<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
										Property
									</span>
									{propertyPresent ? (
										<button
											type="button"
											onClick={removeProperty}
											className="ml-auto text-[10px] uppercase tracking-wider text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
											aria-label="Remove property reference"
										>
											Remove
										</button>
									) : null}
								</div>
								{propertyPresent ? (
									<div className="space-y-1.5">
										<PropertyRefPicker
											mode="property-only"
											// The `via` slot is OWNED by the sibling
											// `RelationPathBuilder` below, NOT by this picker.
											// Pass a self-shaped `prop(...)` (omitting `via`)
											// so the picker stays in its property-dropdown
											// surface across every authoring state — including
											// rows whose row-level `via` is a non-self walk.
											// Threading `value.via` here would route every
											// non-self walk through `PropertyRefPicker`'s
											// "Property via relation walk" badge, which
											// replaces the property dropdown with a Replace
											// affordance and blocks property edits on the
											// canonical authoring flow. The picker's
											// property-only mode is the right surface for
											// property edits; the walk surface lives one row
											// down.
											value={prop(currentCaseType, value.property ?? "")}
											onChange={(nextRef) => {
												// Property-only mode emits a canonical `prop()`
												// ref with no `via` slot (the picker doesn't
												// see / edit `via` here); the row's `via` is
												// authored independently via the
												// `RelationPathBuilder` below. Apply only the
												// property-name change.
												onChange(
													rebuildRow(value, { property: nextRef.property }),
												);
											}}
											ariaLabel={`Search input ${index + 1} property`}
										/>
										<div className="flex items-center gap-2">
											<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60 shrink-0">
												Walk
											</span>
											<div className="flex-1 min-w-0">
												<RelationPathBuilder
													value={viaForBuilder}
													onChange={setVia}
												/>
											</div>
										</div>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setProperty("")}
										className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
										aria-label="Add property reference"
									>
										<Icon icon={tablerPlus} width="11" height="11" />
										<span>Add property</span>
									</button>
								)}
							</div>

							{/* Mode picker — applicable modes filtered by
						    `(type, property data type)`. Always rendered;
						    the picker's "Default" entry clears the slot so
						    the wire layer picks the per-type default. */}
							<div className="flex items-center gap-2">
								<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60 shrink-0">
									Mode
								</span>
								<div className="flex-1 min-w-0">
									<ModePicker
										value={value.mode}
										type={value.type}
										onChange={setMode}
										invalid={resolved.typeCouplingErrors.length > 0}
										rowIndex={index}
									/>
								</div>
							</div>
						</>
					)}

					{/* Type-coupling diagnostics — render BELOW the type /
				    property / mode pickers so the user sees the
				    diagnostic next to the inputs that drove it. The
				    diagnostics flip `valid: false` (per
				    `feedback_always_in_valid_state.md`); the renderer
				    treats them as full errors, not soft warnings. */}
					<InlineError errors={resolved.typeCouplingErrors} />

					{/* Default-value sub-editor. Collapsed by default;
				    expands to mount `ExpressionCardEditor` when the
				    user clicks Add. The expected-type prop helps the
				    inner editor's type checker fire its own diagnostic
				    alongside the row-level type-coupling check. */}
					<DefaultValueSlot
						value={value.default}
						inputType={value.type}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						rowIndex={index}
						onChange={setDefault}
						onValidityChange={(valid) => {
							defaultValidRef.current = valid;
							propagateValidity();
						}}
					/>

					{/* Advanced xpath sub-editor. Collapsed by default;
				    expands to mount `PredicateCardEditor` when the
				    user clicks Add. When the slot is present, the
				    property + mode pickers above are hidden (the
				    predicate replaces the (property, mode)
				    derivation). */}
					<XpathSlot
						value={value.xpath}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						rowIndex={index}
						onChange={setXpath}
						onValidityChange={(valid) => {
							xpathValidRef.current = valid;
							propagateValidity();
						}}
					/>
				</div>

				{/* Remove button — trailing-aligned. */}
				<button
					type="button"
					onClick={onRemove}
					aria-label="Remove search input"
					className="self-start rounded p-0.5 text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
				>
					<Icon icon={tablerTrash} width="14" height="14" />
				</button>
			</div>
		</PredicateEditProvider>
	);
}

// ── Row rebuild helper ────────────────────────────────────────────
//
// Single shape every per-slot mutator routes through. Threads each
// surviving slot through `searchInputDef(...)` so the optional-slot
// omission semantics apply uniformly — passing `undefined` for an
// optional slot omits the key from the output (matches the schema's
// strip-mode parse).

interface RowPatch {
	readonly name?: string;
	readonly label?: string;
	readonly type?: SearchInputType;
	readonly property?: string | undefined;
	readonly via?: RelationPath | undefined;
	readonly mode?: SearchInputMode | undefined;
	readonly default?: ValueExpression | undefined;
	readonly xpath?: Predicate | undefined;
}

/**
 * Rebuild a row by overlaying the patch on the existing row's slots.
 * Routes through `searchInputDef(...)` so:
 *
 *   - The constructed shape's key order is canonical.
 *   - `via: selfPath()` collapses to absent at the wire layer.
 *   - Every absent optional slot is structurally absent, not
 *     present-with-undefined.
 *
 * The patch's `undefined` values resolve to "clear the slot" — the
 * builder's optional-slot omission then drops the key entirely.
 * Slots not mentioned in the patch carry through verbatim from
 * `value`.
 */
function rebuildRow(value: SearchInputDef, patch: RowPatch): SearchInputDef {
	const property = "property" in patch ? patch.property : value.property;
	const via = "via" in patch ? patch.via : value.via;
	const mode = "mode" in patch ? patch.mode : value.mode;
	const dflt = "default" in patch ? patch.default : value.default;
	const xpath = "xpath" in patch ? patch.xpath : value.xpath;
	return searchInputDef(
		patch.name ?? value.name,
		patch.label ?? value.label,
		patch.type ?? value.type,
		{ property, via, mode, default: dflt, xpath },
	);
}

// ── Type picker ───────────────────────────────────────────────────

interface TypePickerProps {
	readonly value: SearchInputType;
	readonly onChange: (next: SearchInputType) => void;
	readonly rowIndex: number;
}

function TypePicker({ value, onChange, rowIndex }: TypePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const triggerLabel = SEARCH_INPUT_TYPE_LABELS[value];
	const triggerIcon = SEARCH_INPUT_TYPE_ICONS[value];
	const triggerClass =
		"group flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30 whitespace-nowrap";
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				aria-label={`Search input ${rowIndex + 1} type: ${triggerLabel}`}
				className={triggerClass}
			>
				<Icon
					icon={triggerIcon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80"
				/>
				<span className="text-nova-text">{triggerLabel}</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="end"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} min-w-[10rem]`}>
						{SEARCH_INPUT_TYPES.map((t, i) => {
							const isActive = t === value;
							const last = SEARCH_INPUT_TYPES.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={t}
									onClick={() => onChange(t)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<Icon
										icon={SEARCH_INPUT_TYPE_ICONS[t]}
										width="14"
										height="14"
										className={
											isActive
												? "text-nova-violet-bright"
												: "text-nova-text-muted"
										}
									/>
									<span className="flex-1 text-left">
										{SEARCH_INPUT_TYPE_LABELS[t]}
									</span>
									{isActive && (
										<Icon
											icon={tablerCheck}
											width="14"
											height="14"
											className="text-nova-violet-bright"
										/>
									)}
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

// ── Mode picker ───────────────────────────────────────────────────

interface ModePickerProps {
	readonly value: SearchInputMode | undefined;
	readonly type: SearchInputType;
	readonly onChange: (next: SearchInputMode | undefined) => void;
	readonly invalid: boolean;
	readonly rowIndex: number;
}

/**
 * Search-mode picker. The applicable-mode set comes from the type;
 * the `multi-select-contains` arm exposes a nested quantifier toggle
 * (`any` ↔ `all`). The "Default" item clears the slot so the wire
 * layer picks the per-type default.
 *
 * Inapplicable modes never appear in the menu (the editor's matrix
 * scopes the menu items per type). Stale persisted modes carry the
 * trigger's red error chrome via `invalid`; the diagnostic surfaces
 * inline below the row.
 */
function ModePicker({
	value,
	type,
	onChange,
	invalid,
	rowIndex,
}: ModePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const applicable = applicableSearchModes(type);
	const triggerLabel =
		value === undefined ? "Default" : SEARCH_MODE_LABELS[value.kind];
	const triggerClass = [
		"group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-error/40 hover:border-nova-error/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const setMultiSelectQuantifier = (q: MultiSelectQuantifier) => {
		onChange(multiSelectContainsMode(q));
	};

	const isMultiSelect = value?.kind === "multi-select-contains";

	return (
		<div className="flex items-center gap-1.5">
			<Menu.Root>
				<Menu.Trigger
					ref={triggerRef}
					aria-label={`Search input ${rowIndex + 1} mode: ${triggerLabel}`}
					className={triggerClass}
				>
					<span className="flex items-center gap-1.5 min-w-0">
						<span className={invalid ? "text-nova-error/90" : "text-nova-text"}>
							{triggerLabel}
						</span>
						{invalid && (
							<Icon
								icon={tablerExclamationCircle}
								width="14"
								height="14"
								className="text-nova-error/80"
								aria-hidden="true"
							/>
						)}
					</span>
					<Chevron />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						className={MENU_POSITIONER_CLS}
						style={{ minWidth: "var(--anchor-width)" }}
					>
						<Menu.Popup className={MENU_POPUP_CLS}>
							{/* Default — clears the slot. The wire layer
							    picks the per-type default at evaluation. */}
							<Menu.Item
								onClick={() => onChange(undefined)}
								className={`rounded-t-xl ${MENU_ITEM_CLS} ${
									value === undefined
										? "text-nova-violet-bright bg-nova-violet/10"
										: ""
								}`}
							>
								<span className="flex-1 text-left">
									<div>Default</div>
									<div
										className={`text-[10px] uppercase tracking-wider ${
											value === undefined
												? "text-nova-violet-bright/60"
												: "text-nova-text-muted"
										}`}
									>
										Per-type default
									</div>
								</span>
								{value === undefined && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright"
									/>
								)}
							</Menu.Item>
							{applicable.map((kind, i) => {
								const isActive = value !== undefined && value.kind === kind;
								const last = applicable.length - 1;
								const corners = i === last ? "rounded-b-xl" : "";
								return (
									<Menu.Item
										key={kind}
										onClick={() => onChange(buildMode(kind))}
										className={`${corners} ${MENU_ITEM_CLS} ${
											isActive
												? "text-nova-violet-bright bg-nova-violet/10"
												: ""
										}`}
									>
										<span className="flex-1 text-left">
											{SEARCH_MODE_LABELS[kind]}
										</span>
										{isActive && (
											<Icon
												icon={tablerCheck}
												width="14"
												height="14"
												className="text-nova-violet-bright"
											/>
										)}
									</Menu.Item>
								);
							})}
							{applicable.length === 0 && (
								<div
									className={`${MENU_ITEM_BASE} text-nova-text-muted italic`}
								>
									No applicable modes
								</div>
							)}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
			{/* Quantifier toggle — only visible for `multi-select-contains`.
			    Renders as a tight `any`/`all` segmented control. */}
			{isMultiSelect && (
				<QuantifierToggle
					value={value.quantifier}
					onChange={setMultiSelectQuantifier}
					rowIndex={rowIndex}
				/>
			)}
		</div>
	);
}

// ── Quantifier toggle ─────────────────────────────────────────────

interface QuantifierToggleProps {
	readonly value: MultiSelectQuantifier;
	readonly onChange: (next: MultiSelectQuantifier) => void;
	readonly rowIndex: number;
}

/**
 * Two-state segmented toggle for the `multi-select-contains` mode's
 * quantifier. `any` (∃) — match if at least one of the values is
 * present; `all` (∀) — match only when every value is present.
 * Clicking the inactive segment flips the quantifier; clicking the
 * active one is a no-op.
 */
function QuantifierToggle({
	value,
	onChange,
	rowIndex,
}: QuantifierToggleProps) {
	const segCls = (active: boolean) =>
		[
			"px-2 py-1.5 text-xs transition-colors cursor-pointer",
			active
				? "bg-nova-violet/15 text-nova-violet-bright"
				: "text-nova-text-muted hover:text-nova-text",
		].join(" ");
	// `<fieldset>` is the semantic group element for a related set of
	// form controls per ARIA's group-pattern recommendation; the
	// inline-flex / overflow-hidden classes reset the browser's
	// default fieldset chrome (border, padding, min-width:auto). The
	// `<legend>` carries the assistive-tech-readable name; `sr-only`
	// hides it visually so the segmented-control chrome stays the
	// only visual cue while AT users get the group label.
	return (
		<fieldset className="inline-flex rounded-md border border-white/[0.06] bg-nova-deep/50 overflow-hidden p-0 m-0 min-w-0">
			<legend className="sr-only">
				Search input {rowIndex + 1} multi-select quantifier
			</legend>
			<button
				type="button"
				onClick={() => onChange("any")}
				aria-pressed={value === "any"}
				className={segCls(value === "any")}
			>
				Any
			</button>
			<button
				type="button"
				onClick={() => onChange("all")}
				aria-pressed={value === "all"}
				className={segCls(value === "all")}
			>
				All
			</button>
		</fieldset>
	);
}

// ── Default-value slot ────────────────────────────────────────────

interface DefaultValueSlotProps {
	readonly value: ValueExpression | undefined;
	readonly inputType: SearchInputType;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly rowIndex: number;
	readonly onChange: (next: ValueExpression | undefined) => void;
	readonly onValidityChange: (valid: boolean) => void;
}

/**
 * Default-value slot. Renders an "Add default value" affordance when
 * the slot is undefined; mounts `ExpressionCardEditor` when defined.
 * The inner editor receives an `expectedType` derived from the
 * input's `type` so its type checker fires native "Expected X;
 * resolves to Y" diagnostics on top of the row-level type-coupling
 * check.
 */
function DefaultValueSlot({
	value,
	inputType,
	caseTypes,
	currentCaseType,
	knownInputs,
	rowIndex,
	onChange,
	onValidityChange,
}: DefaultValueSlotProps) {
	const expectedType = expectedTypeForDefault(inputType);
	if (value === undefined) {
		return (
			<button
				type="button"
				onClick={() => onChange(seedDefaultExpression(inputType))}
				className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				aria-label={`Add default value for search input ${rowIndex + 1}`}
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add default value</span>
			</button>
		);
	}
	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
			<div className="flex items-center gap-1.5">
				<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
					Default value
				</span>
				<button
					type="button"
					onClick={() => onChange(undefined)}
					className="ml-auto text-[10px] uppercase tracking-wider text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
					aria-label={`Remove default value for search input ${rowIndex + 1}`}
				>
					Remove
				</button>
			</div>
			<ExpressionCardEditor
				value={value}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				expectedType={expectedType}
				onValidityChange={onValidityChange}
			/>
		</div>
	);
}

// ── Xpath slot ────────────────────────────────────────────────────

interface XpathSlotProps {
	readonly value: Predicate | undefined;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly SearchInputDecl[];
	readonly rowIndex: number;
	readonly onChange: (next: Predicate | undefined) => void;
	readonly onValidityChange: (valid: boolean) => void;
}

/**
 * Advanced xpath predicate slot. Renders an "Add advanced filter"
 * affordance when the slot is undefined; mounts `PredicateCardEditor`
 * when defined. The default seed is `match-all()` — the same
 * always-true sentinel `FiltersSection` uses, surfacing immediately
 * with the kind-replacement menu so the user's first interaction is
 * "what kind of filter?" rather than "fill in this comparison."
 */
function XpathSlot({
	value,
	caseTypes,
	currentCaseType,
	knownInputs,
	rowIndex,
	onChange,
	onValidityChange,
}: XpathSlotProps) {
	if (value === undefined) {
		return (
			<button
				type="button"
				onClick={() => onChange(matchAll())}
				className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				aria-label={`Add advanced filter for search input ${rowIndex + 1}`}
			>
				<Icon icon={tablerPlus} width="11" height="11" />
				<span>Add advanced filter</span>
			</button>
		);
	}
	return (
		<div className="rounded-md border border-white/[0.04] bg-nova-deep/30 p-2 space-y-1.5">
			<div className="flex items-center gap-1.5">
				<span className="text-[10px] uppercase tracking-widest text-nova-text-muted/60">
					Advanced filter
				</span>
				<button
					type="button"
					onClick={() => onChange(undefined)}
					className="ml-auto text-[10px] uppercase tracking-wider text-nova-text-muted/50 hover:text-nova-error transition-colors cursor-pointer"
					aria-label={`Remove advanced filter for search input ${rowIndex + 1}`}
				>
					Remove
				</button>
			</div>
			<PredicateCardEditor
				value={value}
				onChange={onChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				onValidityChange={onValidityChange}
			/>
		</div>
	);
}

// ── Drag preview ──────────────────────────────────────────────────

/**
 * Custom drag preview rendered in place of the browser's default
 * source snapshot. Mirrors `CalculatedColumnDragPreview` —
 * the browser would otherwise snapshot the 14×14 grip icon, leaving
 * the user blind to what's being moved.
 */
function SearchInputDragPreview({
	index,
	row,
}: {
	readonly index: number;
	readonly row: SearchInputDef;
}) {
	const label = row.label || row.name || `Search input ${index + 1}`;
	return (
		<div className="inline-flex items-center gap-1.5 rounded-lg border border-nova-violet/40 bg-nova-surface/95 px-3 py-1.5 text-sm text-nova-text shadow-lg backdrop-blur-sm">
			<Icon
				icon={tablerGripVertical}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<Icon
				icon={SEARCH_INPUT_TYPE_ICONS[row.type]}
				width="14"
				height="14"
				className="text-nova-violet-bright/80"
			/>
			<span className="max-w-[240px] truncate">{label}</span>
		</div>
	);
}

// ── Helpers ───────────────────────────────────────────────────────

function Chevron() {
	return (
		<svg
			aria-hidden="true"
			width="10"
			height="10"
			viewBox="0 0 10 10"
			className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
		>
			<path
				d="M2 3.5L5 6.5L8 3.5"
				stroke="currentColor"
				strokeWidth="1.2"
				fill="none"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
