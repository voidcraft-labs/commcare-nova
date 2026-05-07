// lib/commcare/suite/case-list/sortKeys.ts
//
// Per-column `<sort>` block emission for the suite-XML case-list
// short detail. Sort keys live on `caseListConfig.sort` as a
// typed array; each key targets one source — a case property OR a
// calculated column id — and the wire layer locates the matching
// `<field>` block at column-emission time and appends the `<sort>`
// element with its 1-based `order` attribute.
//
// Two responsibilities split across this module:
//
//   - **Type / direction translation.** The domain layer's
//     `SortType` enum (`plain` / `date` / `integer` / `decimal`)
//     and `SortDirection` enum (`asc` / `desc`) map to CCHQ's wire
//     vocabulary (`string` / `int` / `double` / `ascending` /
//     `descending`). The mapping mirrors the per-format dispatch
//     dict inside
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`,
//     where `'plain'` and `'date'` both collapse to wire
//     `'string'` (lexicographic comparison on ISO 8601 strings is
//     order-preserving for both dates and plain text).
//   - **Source resolution.** A `SortKey.source` is either
//     `{ kind: "property", property }` or `{ kind: "calculated",
//     columnId }`. The orchestrator looks up which key (if any)
//     targets the column being emitted and threads the matching
//     entry into `emitSortBlock`.
//
// `<sort>` `@order` is the 1-based position of the key in
// `caseListConfig.sort`. When multiple `<sort>` elements coexist,
// the runtime applies them by ascending `order` — `order=1` is
// the primary sort, `order=2` is the first tie-breaker, etc. The
// canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
// renders three `<sort>` elements under
// `<detail id="m0_case_short">`, each carrying its own `order`
// attribute.

import type { SortDirection, SortKey, SortType } from "@/lib/domain";
import { escapeXml } from "../../xml";

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
 * Produce a `<sort>` block targeting a single column's display
 * value. Emits the wire-shape:
 *
 *     <sort type="<wireType>" order="<order>" direction="<wireDirection>">
 *       <text>
 *         <xpath function="<xpathFunction>"/>
 *       </text>
 *     </sort>
 *
 * Attribute order — `type, order, direction` — matches CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Sort`
 * field declaration order. XML attribute order is wire-irrelevant
 * (CCHQ's own fixtures use mixed orderings — `multi-sort.xml`'s
 * `<sort>` blocks match the model order; `search_command_detail.xml`
 * uses `direction, order, type` instead — the parser accepts
 * both). Anchoring on the model declaration gives one stable
 * order.
 *
 * `xpathFunction` is the wire XPath the runtime reads to obtain
 * the per-row sort value — typically the bare property name for
 * plain / phone / id-mapping columns, or the raw property name
 * for date / time-since-until / late-flag columns (sort-on-raw,
 * not sort-on-formatted, mirrors CCHQ's per-format
 * `detail_screen.py::Date.SORT_XPATH_FUNCTION = "{xpath}"`).
 *
 * The XPath is XML-escaped — `&`, `<`, `>`, `"` are special
 * inside a double-quoted attribute value. Single quotes survive
 * verbatim because every wire-form XPath emitted by
 * `lib/commcare/expression/onDeviceEmitter.ts` quotes string
 * literals with single quotes.
 */
export function emitSortBlock(args: {
	readonly order: number;
	readonly direction: SortDirection;
	readonly type: SortType;
	readonly xpathFunction: string;
}): string {
	const wireType = SORT_TYPE_TO_WIRE[args.type];
	const wireDirection = SORT_DIRECTION_TO_WIRE[args.direction];
	const escaped = escapeXml(args.xpathFunction);
	return `      <sort type="${wireType}" order="${args.order}" direction="${wireDirection}">\n        <text>\n          <xpath function="${escaped}"/>\n        </text>\n      </sort>`;
}

/**
 * Produce a `<sort>` block targeting a calculated column's value.
 * The wire shape mirrors `emitSortBlock` above but threads a
 * `<variable name="calculated_property">` block through the
 * `<xpath>` element so the sort comparator reads `$calculated_property`
 * resolved against the inline calc expression — same shape CCHQ
 * emits when a column has `useXpathExpression` set (per the
 * `useXpathExpression` branch in
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`):
 *
 *     <sort type="..." order="..." direction="...">
 *       <text>
 *         <xpath function="$calculated_property">
 *           <variable name="calculated_property">
 *             <xpath function="<calcXpath>"/>
 *           </variable>
 *         </xpath>
 *       </text>
 *     </sort>
 *
 * The detail-level `<variables>` block could in principle host the
 * calc instead, but CCHQ's wire convention for per-column calcs
 * is the inline `<variable>` shape — keeping the calc local to
 * its consuming `<field>` matches CCHQ's case_short fixtures at
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
 * (under `<detail id="m0_case_short">`, calc fields render
 * `<template>` bodies with inline `<variable name="calculated_property">`).
 *
 * `order` is `number | undefined`. When provided, the wire layer
 * renders `order="<n>"` and the runtime's multi-key sort applies
 * the key in that priority position. When omitted, the `<sort>`
 * block carries no `order` attribute — CCHQ's per-format default
 * shape, mirrored at the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
 * (the second `birthdate` `<field>` under
 * `<detail id="m0_case_short">` carries `<sort type="string">`
 * with no `order` attribute, marking it as a per-format default
 * rather than a multi-key participant). The orchestrator omits
 * `order` for calc-local sort configs (`CalculatedColumn.sort`)
 * and supplies `order` only when a module-level
 * `caseListConfig.sort` key targets the calc.
 */
export function emitCalculatedSortBlock(args: {
	readonly order: number | undefined;
	readonly direction: SortDirection;
	readonly type: SortType;
	readonly calcXpath: string;
}): string {
	const wireType = SORT_TYPE_TO_WIRE[args.type];
	const wireDirection = SORT_DIRECTION_TO_WIRE[args.direction];
	const escapedCalc = escapeXml(args.calcXpath);
	const orderAttr = args.order !== undefined ? ` order="${args.order}"` : "";
	return [
		`      <sort type="${wireType}"${orderAttr} direction="${wireDirection}">`,
		`        <text>`,
		`          <xpath function="$calculated_property">`,
		`            <variable name="calculated_property">`,
		`              <xpath function="${escapedCalc}"/>`,
		`            </variable>`,
		`          </xpath>`,
		`        </text>`,
		`      </sort>`,
	].join("\n");
}

/**
 * Locate the sort key whose source matches a per-column target.
 * Returns the key plus its 1-based `order` (the per-array index
 * + 1). When no matching key exists, returns `undefined` and the
 * caller skips `<sort>` emission for the field.
 *
 * Two source-kind branches:
 *
 *   - `property` — match by case-property name. Both regular
 *     columns and the validator's `propertyExists` admission
 *     bind sort keys to property names by string equality.
 *   - `calculated` — match by calculated column id. Sort keys
 *     can target a calc by id, including a calc-only sort that
 *     no displayed column references.
 *
 * Duplicate-property simplification: when two `<field>` blocks
 * reference the same case property (e.g. a plain text column and
 * a date-formatted column both targeting `birthdate`), this
 * resolver returns the same `(key, order)` pair for each call.
 * Both fields receive a `<sort order="N">` block. CCHQ's stricter
 * convention is to attach the order attribute to the first
 * matching field and emit no-order `<sort>` blocks on the rest —
 * the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
 * has two `birthdate` `<field>` blocks under
 * `<detail id="m0_case_short">`; the second one's `<sort>`
 * carries no `order` attribute. The wire is still well-formed
 * under both conventions — duplicate `order` attributes don't
 * reject at import — but Nova's emission diverges from the
 * CCHQ-canonical shape. The simplification is acceptable because
 * Nova generates and consumes its own wire output; downstream
 * multi-sort priority is unambiguous either way.
 */
export function findSortKey(
	sort: readonly SortKey[],
	target:
		| { readonly kind: "property"; readonly property: string }
		| { readonly kind: "calculated"; readonly id: string },
): { readonly key: SortKey; readonly order: number } | undefined {
	for (let i = 0; i < sort.length; i++) {
		const key = sort[i];
		if (target.kind === "property" && key.source.kind === "property") {
			if (key.source.property === target.property) {
				return { key, order: i + 1 };
			}
		} else if (
			target.kind === "calculated" &&
			key.source.kind === "calculated"
		) {
			if (key.source.columnId === target.id) {
				return { key, order: i + 1 };
			}
		}
	}
	return undefined;
}

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
