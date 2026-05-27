// lib/commcare/suite/case-list/sortKeys.ts
//
// Per-column `<sort>` block emission for the suite-XML case-list
// short detail. Sort directives now ride on the column itself —
// `column.sort?: { direction, priority }`. The wire layer:
//
//   1. Walks the columns once, drops the ones without `sort`, and
//      sorts the survivors by `priority` ascending. Tie-break is
//      column display order in `caseListConfig.columns`: the column
//      appearing earlier wins on equal priority. The rule binds
//      uniformly at the saga, preview, and wire layers; no layer
//      assumes priority uniqueness.
//
//   2. Resolves a comparator type per column. The comparator type
//      isn't authored — the column's `data_type` (for property-rooted
//      columns) or its expression's resolved result type (for
//      calculated columns) drives the choice. The dispatch lives in
//      `resolveColumnSortType` below.
//
//   3. Builds one `ResolvedSortDirective` per sortable column,
//      keyed by `column.uuid`. The orchestrator threads the map
//      through `CaseListEmitContext.sortByUuid`; the per-column
//      emitter looks up its directive and emits the matching
//      `<sort>` block.
//
// `<sort>` `@order` is the 1-based position in the sorted-by-priority
// sequence — `order=1` is the primary sort, `order=2` is the first
// tie-breaker, etc. The canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_short">`
// renders three `<sort>` elements, each carrying its own `order`
// attribute matching its position in the multi-key sort.
//
// Two responsibilities split:
//
//   - **Wire vocab translation.** Nova's `SortType` /
//     `SortDirection` enums map to CCHQ's wire vocabulary
//     (`string` / `int` / `double` / `ascending` / `descending`).
//     The mapping mirrors the per-format dispatch dict inside
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`,
//     where `'plain'` and `'date'` both collapse to wire
//     `'string'` (lexicographic comparison on ISO 8601 strings is
//     order-preserving for both dates and plain text).
//
//   - **Comparator-type derivation.** Property-rooted columns route
//     through `applicableSortTypes(dataType)[0]` (the canonical
//     comparator for the column's `data_type`); calculated columns
//     route through `checkExpression(expression, ctx, errors, path)`
//     mapped to a `SortType`. Three failure shapes — `undefined`
//     (resolution failure), `ANY_TYPE` (null-literal arm), or a
//     `ResolvedType` with no mapping (e.g. `SEQUENCE_TYPE`) —
//     route to `"plain"`.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	Column,
	Module,
	SortDirection,
	SortType,
	Uuid,
} from "@/lib/domain";
import {
	ANY_TYPE,
	checkExpression,
	type ResolvedType,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import {
	moduleTypeContext,
	resolvePropertyDataType,
} from "../../validator/rules/case-list/shared";

// ============================================================
// Wire-vocab translation
// ============================================================

/**
 * Map a domain-layer `SortType` to the CCHQ wire vocabulary. CCHQ
 * `<sort>` `@type` admits `string` / `int` / `double` / `index`;
 * Nova exposes `plain` / `date` / `integer` / `decimal` as the
 * authoring vocabulary and translates here.
 *
 *   - `plain` → `string` (CCHQ's broad-applicability default
 *     comparator; lexicographic comparison via the
 *     `detail_screen.py::FormattedDetailColumn.SORT_TYPE = 'string'`
 *     class attribute).
 *   - `date` → `string` (CCHQ collapses `date` to `string` in the
 *     dispatch dict inside
 *     `detail_screen.py::FormattedDetailColumn.sort_node`; ISO
 *     8601 dates sort correctly under string comparison so a
 *     separate date comparator is unnecessary).
 *   - `integer` → `int` (CCHQ numeric integer comparison).
 *   - `decimal` → `double` (CCHQ numeric float comparison).
 */
const SORT_TYPE_TO_WIRE: Record<SortType, string> = {
	plain: "string",
	date: "string",
	integer: "int",
	decimal: "double",
};

/**
 * Map a domain-layer `SortDirection` to CCHQ's spelled-out
 * attribute values. CCHQ wire uses the long-form `ascending` /
 * `descending`; the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
 * carries `direction="descending"` / `direction="ascending"` on
 * each `<sort>` element under `<detail id="m0_case_short">`.
 */
const SORT_DIRECTION_TO_WIRE: Record<SortDirection, string> = {
	asc: "ascending",
	desc: "descending",
};

/**
 * Re-export the wire-vocab maps so any consumer composing a sort
 * block (test fixtures, sibling emitters that share the
 * `SortType` / `SortDirection` translation) reads from one
 * authoritative table. Adding a `SortType` arm surfaces here as a
 * `Record` exhaustiveness error rather than a silent fall-through
 * to a default.
 */
export const SORT_TYPE_WIRE_MAP: Readonly<Record<SortType, string>> =
	SORT_TYPE_TO_WIRE;
export const SORT_DIRECTION_WIRE_MAP: Readonly<Record<SortDirection, string>> =
	SORT_DIRECTION_TO_WIRE;

// ============================================================
// Comparator-type derivation
// ============================================================

/**
 * Comparator-type table per case-property `data_type`. Each entry
 * is a tuple — the first slot is the canonical comparator the wire
 * emitter reads; subsequent slots are the structurally-sound
 * alternatives that also accept the type's value range. The wire
 * emitter consults `[0]` only.
 *
 *   - `int` → `integer` (numeric integer comparison).
 *   - `decimal` → `decimal` (numeric float comparison).
 *   - `date` / `datetime` / `time` → `date` (ISO-string sort, which
 *     CCHQ's wire layer collapses to `string` per
 *     `detail_screen.py::FormattedDetailColumn.sort_node`'s dispatch
 *     dict).
 *   - Everything else (`text` / `single_select` / `multi_select` /
 *     `geopoint`) → `plain`.
 */
const APPLICABLE_SORT_TYPES: Readonly<
	Record<CasePropertyDataType, readonly SortType[]>
> = {
	int: ["integer", "plain"],
	decimal: ["decimal", "plain"],
	date: ["date", "plain"],
	datetime: ["date", "plain"],
	time: ["date", "plain"],
	text: ["plain"],
	single_select: ["plain"],
	multi_select: ["plain"],
	geopoint: ["plain"],
};

/**
 * Resolve the applicable `SortType` tuple for a property's
 * `data_type`, falling back to `["plain"]` when the property is
 * un-annotated (the same permissive default the case-property
 * type system applies for unresolved properties — lexicographic
 * comparison is structurally sound on every wire-form value).
 *
 * Unresolved (`undefined`) collapses to `["plain"]` so the wire
 * emitter never emits a comparator the runtime can't honor.
 */
export function applicableSortTypes(
	dataType: CasePropertyDataType | undefined,
): readonly SortType[] {
	if (dataType === undefined) return ["plain"];
	return APPLICABLE_SORT_TYPES[dataType];
}

/**
 * Map a checker-resolved `ResolvedType` to the matching wire
 * `SortType`. Returns `null` for resolved types with no mapping;
 * the `ANY_TYPE` and `SEQUENCE_TYPE` sentinels both fall here, as
 * does any future declared type that hasn't been wired into the
 * sort-comparator table. The fallback rule routes the `null`
 * return to `"plain"` at the call site.
 *
 * Property-rooted columns don't route through this helper — they
 * use `applicableSortTypes(dataType)[0]` directly because their
 * source is a `CasePropertyDataType` (the closed enum the table is
 * keyed on). This helper exists for the calculated-column arm,
 * whose source is a `ResolvedType` (the wider alphabet covering
 * every value-bearing surface).
 */
function mapResolvedTypeToSortType(rt: ResolvedType): SortType | null {
	switch (rt) {
		case "int":
			return "integer";
		case "decimal":
			return "decimal";
		case "date":
		case "datetime":
		case "time":
			return "date";
		case "text":
		case "single_select":
		case "multi_select":
		case "geopoint":
			return "plain";
		default:
			// `ANY_TYPE` (null-literal arm) and `SEQUENCE_TYPE`
			// (`unwrap-list` result) fall here, as does any future
			// `ResolvedType` not yet wired into the sort-comparator
			// table. The caller routes `null` to `"plain"` per the
			// explicit fallback rule.
			return null;
	}
}

/**
 * Resolve a column's comparator type at wire emission. Pure — no
 * side effects, no I/O. Three branches:
 *
 *   - **Property-rooted columns** (`plain`, `date`, `phone`,
 *     `id-mapping`, `interval`) read the case property's declared
 *     `data_type` via the validator's `resolvePropertyDataType`
 *     helper and route through `applicableSortTypes(dataType)[0]`.
 *     Unresolved properties (returns `undefined`) collapse to
 *     `"plain"` per the helper's fallback.
 *
 *   - **Calculated columns** type-check the column's `expression`
 *     and map the resolved result type to a `SortType` via
 *     `mapResolvedTypeToSortType`. Three fallback shapes route to
 *     `"plain"`:
 *
 *       1. `checkExpression` returns `undefined` — resolution
 *          failure (e.g. unresolvable property reference inside the
 *          expression). The validator's
 *          `calculatedColumnTypeCheck` rule reports the failure;
 *          the wire emitter still has to produce a well-formed
 *          comparator and `"plain"` is the only structurally sound
 *          default.
 *       2. `checkExpression` returns `ANY_TYPE` — the `null`-literal
 *          arm. Comparing nulls under any comparator is well-defined
 *          but the comparator choice doesn't matter; `"plain"` is
 *          the canonical no-op default.
 *       3. `checkExpression` returns a `ResolvedType` with no
 *          mapping (`SEQUENCE_TYPE`, or any future type not wired
 *          into `mapResolvedTypeToSortType`). The expression is
 *          structurally inadmissible as a sort source but the wire
 *          emitter still produces `"plain"` so an in-flight edit
 *          state doesn't crash the build.
 *
 *   - Modules without a case type can't resolve any property, so
 *     the property-rooted branch returns `"plain"` defensively.
 *     Validator rules upstream gate non-empty configs against
 *     case-type presence; this branch is the structural fallback.
 */
function resolveColumnSortType(
	column: Column,
	mod: Module,
	doc: BlueprintDoc,
): SortType {
	if (column.kind === "calculated") {
		return resolveCalculatedSortType(column.expression, mod, doc);
	}
	if (mod.caseType === undefined) return "plain";
	const dataType = resolvePropertyDataType(doc, mod.caseType, column.field);
	return applicableSortTypes(dataType)[0] ?? "plain";
}

/**
 * Type-check a calculated column's expression and translate the
 * resolved type to a `SortType`. Lives separately so the three
 * fallback shapes — `undefined` / `ANY_TYPE` / unmapped — can be
 * tested in isolation.
 *
 * The type-check runs against the same `TypeContext` the validator
 * builds for the module (`moduleTypeContext`) so the wire emitter
 * sees the same admission set as the validator: declared properties
 * + writer-derived + CommCare standard properties. The walker
 * pushes errors onto an internal `errors` accumulator; the wire
 * layer ignores them — the validator's
 * `calculatedColumnTypeCheck` rule reports the same failures
 * upstream, so a per-emit re-report would just duplicate.
 */
function resolveCalculatedSortType(
	expression: ValueExpression,
	mod: Module,
	doc: BlueprintDoc,
): SortType {
	const ctx = moduleTypeContext(mod, doc);
	const errors: { path: (string | number)[]; message: string }[] = [];
	const resolved = checkExpression(expression, ctx, errors, []);
	if (resolved === undefined) return "plain";
	if (resolved === ANY_TYPE) return "plain";
	const mapped = mapResolvedTypeToSortType(resolved);
	return mapped ?? "plain";
}

// ============================================================
// Sort-directive build pipeline
// ============================================================

/**
 * Resolved per-column sort directive — the wire layer's runtime
 * shape, derived once at orchestration time. Two arms:
 *
 *   - `kind: "property"` — property-rooted column. `xpath` is the
 *     bare property reference for `plain` / `phone` / `id-mapping`
 *     and the raw property for `date` / `interval` (sort-on-raw,
 *     not sort-on-formatted, mirrors CCHQ's per-format
 *     `detail_screen.py::Date.SORT_XPATH_FUNCTION = "{xpath}"`).
 *
 *   - `kind: "calculated"` — calculated column. `calcXpath` is the
 *     lowered ValueExpression. The wire emitter wraps it in a
 *     `<variable name="calculated_property">` block so the sort
 *     comparator reads `$calculated_property` resolved against the
 *     inline calc, mirroring CCHQ's
 *     `detail_screen.py::FormattedDetailColumn.sort_node`'s
 *     `useXpathExpression` branch.
 *
 * Common slots on both arms: `order` (1-based priority position
 * after the priority sort + tie-break), `direction`, `type`.
 */
export type ResolvedSortDirective =
	| {
			readonly kind: "property";
			readonly order: number;
			readonly direction: SortDirection;
			readonly type: SortType;
			readonly xpath: string;
	  }
	| {
			readonly kind: "calculated";
			readonly order: number;
			readonly direction: SortDirection;
			readonly type: SortType;
			readonly calcXpath: string;
	  };

/**
 * Compute the sort xpath for a property-rooted column. The wire
 * comparator reads the raw property reference for every kind —
 * date/interval columns sort on the raw property so ISO-string
 * lexicographic order matches calendar order, and so an overdue-
 * flagged row sorts by its actual date rather than by the flag
 * string. Plain / phone / id-mapping use the same property as the
 * display xpath. Mirrors CCHQ's per-format
 * `detail_screen.py::Date.SORT_XPATH_FUNCTION = "{xpath}"` rule.
 *
 * The parameter type excludes the calculated arm at the type
 * layer — callers route calc columns through
 * `emitOnDeviceExpression(expression)` directly, so this helper's
 * exhaustiveness check covers only the property-rooted kinds.
 */
function propertySortXpath(
	column: Exclude<Column, { kind: "calculated" }>,
): string {
	return column.field;
}

/**
 * Build the per-column sort-directive map a `CaseListEmitContext`
 * threads through the per-column emitters. Pure — same inputs
 * always produce the same output map.
 *
 * Pipeline:
 *
 *   1. Walk the columns once, keep the entries with `column.sort`
 *      defined, and remember their original array indices.
 *   2. Sort the survivors by `priority` ascending. Tie-break to
 *      original array index so the column appearing earlier in
 *      `caseListConfig.columns` wins on equal priority. The
 *      tie-break rule binds at every layer (saga / preview / wire);
 *      no layer assumes priority uniqueness.
 *   3. Assign `order = i + 1` to the i-th survivor in the sorted
 *      sequence — the 1-based position the CCHQ wire `<sort>
 *      @order>` attribute carries.
 *   4. Resolve each survivor's comparator type via
 *      `resolveColumnSortType` and lower its sort xpath
 *      (raw property for non-calc; lowered ValueExpression for
 *      calc).
 *
 * The output map keys on `column.uuid` so the per-column emitter
 * looks up its directive in O(1) without re-walking the sort list.
 *
 * Empty input or a configuration where no column carries `sort`
 * yields an empty map — the wire emitter then omits every `<sort>`
 * block.
 */
export function buildSortDirectives(
	mod: Module,
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, ResolvedSortDirective> {
	const config = mod.caseListConfig;
	if (!config) return new Map();

	// Phase 1 — collect sortable columns with their array index.
	type Survivor = {
		readonly column: Column;
		readonly index: number;
	};
	const survivors: Survivor[] = [];
	for (let i = 0; i < config.columns.length; i++) {
		const column = config.columns[i];
		if (column.sort === undefined) continue;
		survivors.push({ column, index: i });
	}
	if (survivors.length === 0) return new Map();

	// Phase 2 — priority sort with explicit tie-break to original
	// display order. Explicit tie-break is safer than relying on
	// the ECMAScript spec's "stable sort" guarantee — readers can
	// see the rule directly, and the wire layer's behavior is
	// independent of any future engine changes.
	const sorted = [...survivors].sort((a, b) => {
		// `column.sort` is non-undefined for both — the survivor
		// filter guarantees it. The non-null assertion is the cost
		// of TypeScript's narrowing not flowing through the filter.
		const ap = a.column.sort?.priority ?? 0;
		const bp = b.column.sort?.priority ?? 0;
		if (ap !== bp) return ap - bp;
		return a.index - b.index;
	});

	// Phase 3 — assign 1-based order, resolve comparator type +
	// sort xpath, build the directive.
	const out = new Map<Uuid, ResolvedSortDirective>();
	for (let i = 0; i < sorted.length; i++) {
		const { column } = sorted[i];
		// Survivor filter pinned `column.sort` non-undefined; the
		// access is type-safe at runtime even though TypeScript
		// can't propagate the narrowing through the sort.
		const sortConfig = column.sort;
		if (sortConfig === undefined) continue;
		const order = i + 1;
		const type = resolveColumnSortType(column, mod, doc);
		if (column.kind === "calculated") {
			const calcXpath = emitOnDeviceExpression(column.expression);
			out.set(column.uuid, {
				kind: "calculated",
				order,
				direction: sortConfig.direction,
				type,
				calcXpath,
			});
		} else {
			out.set(column.uuid, {
				kind: "property",
				order,
				direction: sortConfig.direction,
				type,
				xpath: propertySortXpath(column),
			});
		}
	}
	return out;
}

// ============================================================
// Wire emission
// ============================================================

/**
 * Build a `<sort>` Element from a resolved directive. Dispatches
 * on the directive's `kind`:
 *
 *   - `property` arm — bare-XPath shape:
 *
 *         <sort type="<wireType>" order="<order>" direction="<wireDirection>">
 *           <text>
 *             <xpath function="<xpath>"/>
 *           </text>
 *         </sort>
 *
 *   - `calculated` arm — CCHQ's inline-variable shape per
 *     `detail_screen.py::FormattedDetailColumn.sort_node`'s
 *     `useXpathExpression` branch:
 *
 *         <sort type="<wireType>" order="<order>" direction="<wireDirection>">
 *           <text>
 *             <xpath function="$calculated_property">
 *               <variable name="calculated_property">
 *                 <xpath function="<calcXpath>"/>
 *               </variable>
 *             </xpath>
 *           </text>
 *         </sort>
 *
 * Attribute insertion order — `type, order, direction` — matches CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Sort`
 * field declaration order. XML attribute order is wire-irrelevant
 * (CCHQ's own fixtures use mixed orderings; the parser accepts
 * both); anchoring on the model declaration gives one stable
 * order.
 *
 * The XPath payload flows raw into the `function` attribute; the
 * serializer XML-escapes `<` / `>` / `&` / `"` / `'` exactly once at
 * render time, so every wire-form XPath emitted by
 * `lib/commcare/expression/onDeviceEmitter.ts` (single-quoted string
 * literals, ` >` comparison operators) round-trips correctly without
 * hand-escaping.
 */
export function buildSortBlock(directive: ResolvedSortDirective): Element {
	const wireType = SORT_TYPE_TO_WIRE[directive.type];
	const wireDirection = SORT_DIRECTION_TO_WIRE[directive.direction];
	const sortAttribs: Record<string, string> = {
		type: wireType,
		order: String(directive.order),
		direction: wireDirection,
	};
	if (directive.kind === "property") {
		return el("sort", sortAttribs, [
			el("text", {}, [el("xpath", { function: directive.xpath })]),
		]);
	}
	// Calculated arm — CCHQ's `useXpathExpression` shape wraps the
	// raw expression inside a `<variable>` definition referenced by a
	// `$calculated_property` placeholder in the outer `<xpath>`. The
	// nested structure is what CCHQ's runtime resolves the calc
	// expression against during sort.
	return el("sort", sortAttribs, [
		el("text", {}, [
			el("xpath", { function: "$calculated_property" }, [
				el("variable", { name: "calculated_property" }, [
					el("xpath", { function: directive.calcXpath }),
				]),
			]),
		]),
	]);
}

/**
 * Boundary shim — serializes `buildSortBlock`'s Element to a string for
 * callers that still consume the string-array accumulator shape. Drops
 * when those callers (`columns.ts`) switch to direct Element consumption
 * in the case-list DOM migration.
 */
export function emitSortBlock(directive: ResolvedSortDirective): string {
	return render(buildSortBlock(directive), RENDER_OPTS);
}
