// lib/commcare/suite/case-list/columns.ts
//
// Per-`Column` `<field>` block emission for the suite-XML case-list
// detail. Each column produces one `<field>` element matching CCHQ's
// wire vocabulary at
// `commcare-hq/corehq/apps/app_manager/detail_screen.py` —
// per-format-class XPath templates pin the per-kind display +
// sort behavior. The same emitter services both detail surfaces
// (short + long); per-surface divergences (locale-id substring,
// `<sort>` block presence, `<template form="phone">` on long-only)
// flow through the `CaseListEmitContext.detailKind` discriminator.
//
// The seven Nova column kinds map to CCHQ formats as follows:
//
//   - `plain`             → CCHQ `detail_screen.py::Plain` template.
//     Most properties emit a bare reference. A declared single- or
//     multi-select property derives its worker-facing option labels from the
//     case-property catalog; unknown imported tokens remain raw so changing an
//     option catalog never makes historical data disappear.
//
//   - `date`              → CCHQ `detail_screen.py::Date` format.
//     Wire shape:
//     `if({xpath} = '', '', format-date(date({xpath}), '<pattern>'))`.
//     The empty-string short-circuit covers absent values; the
//     pattern routes through `quoteLiteral` to escape any embedded
//     single-quote authoring (the on-device XPath dialect's
//     concat-fallback). Sort uses raw `{xpath}` (mirrors CCHQ's
//     `Date.SORT_XPATH_FUNCTION = "{xpath}"`) so ISO-string
//     lexicographic ordering matches calendar order.
//
//   - `phone`             → CCHQ `detail_screen.py::Phone` format.
//     Same XPath as `plain`; the divergence between the two
//     detail surfaces is the `<template>` element's `form`
//     attribute. CCHQ's
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`
//     returns `'phone'` only when `detail.display == 'long'`; on
//     long detail the runtime renders a tappable-link affordance,
//     on short detail a bare text cell. The `detailKind`
//     discriminator routes a phone column to either
//     `<template>` or `<template form="phone">` accordingly.
//
//   - `id-mapping`        → CCHQ `detail_screen.py::Enum` format.
//     Wire shape:
//     `replace(join(' ', if(selected({xpath}, 'value-1'), 'label-1', ''), ...), '\s+', ' ')`.
//     CCHQ's stock `Enum` references `<variable name="kKey">` →
//     locale-id labels; Nova inlines the labels as XPath string
//     literals because the project has no multi-language wiring
//     (the labels live on the `IdMappingEntry.label` slot
//     verbatim). The `selected()` arm matches against the raw
//     property value; the `replace(join(...), '\\s+', ' ')` collapse
//     trims the leading whitespace from the join's empty-arm
//     fall-throughs. Sort uses raw `{xpath}`.
//
//   - `image-map`         → CCHQ `detail_screen.py::EnumImage` format
//     (`<template form="image">`). The id-mapping shape with image
//     paths instead of text labels: a NESTED-`if` chain
//     `if(selected({xpath}, 'value-1'), 'jr://file/commcare/<hash><ext>',
//     if(...))` inlining the resolved `jr://` path literals. Nested-if
//     (not id-mapping's `replace(join(...))`) because the join's
//     empty-arm collapse would leave a trailing space inside a matched
//     `jr://` path and break the reference. Degrades to a plain column
//     (raw property value) when media emission is off (no manifest).
//
//   - `interval`          → merges CCHQ's `TimeAgo` + `LateFlag`
//     formats under one Nova kind. The `display` discriminator
//     dispatches the cell shape:
//
//       - `display: "always"` — always show the relative interval.
//         Wraps CCHQ's
//         `detail_screen.py::TimeAgo.XPATH_FUNCTION =
//         "if({xpath} = '', '', string(int((today() - date({xpath})) div <divisor>)))"`
//         with an overdue-text branch that surfaces `text` past the
//         threshold and the integer interval otherwise. CCHQ's
//         stock `TimeAgo` has no overdue branch — Nova adds one.
//
//       - `display: "flag"` — render `text` only when the threshold
//         is exceeded; otherwise the cell is empty. Mirrors CCHQ's
//         `detail_screen.py::LateFlag.XPATH_FUNCTION =
//         "if({xpath} = '', '*', if(today() - date({xpath}) > <threshold>, '*', ''))"`
//         with the author's `text` substituting for CCHQ's
//         hard-coded `'*'`. The CCHQ shape surfaces the flag for
//         the absent-property case AND the overdue case, leaving
//         the cell empty only when the date is present and within
//         threshold.
//
//     Sort uses raw `{xpath}` for both arms.
//
//   - `calculated`        → CCHQ `useXpathExpression` branch in
//     `detail_screen.py::FormattedDetailColumn.template`. The
//     `<template>` body wraps `$calculated_property` around an
//     inline `<variable name="calculated_property">` block
//     carrying the lowered ValueExpression XPath. The `<header>`
//     resolves through the `case_calculated_property_<position>`
//     locale convention per
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`'s
//     `useXpathExpression` substitution. No `field` slot — the
//     expression is the source.
//
// `<sort>` block emission is detail-surface-aware. Short detail
// emits sort blocks for every column whose uuid keys into
// `ctx.sortByUuid`. Long detail emits no `<sort>` blocks for the
// non-nodeset case, matching CCHQ's
// `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
// short-circuit on `self.detail.display != 'short'`.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import {
	type CaseProperty,
	type Column,
	resolveCommCareDatePattern,
	TIME_SINCE_UNIT_DAYS,
} from "@/lib/domain";
import { emitCasePropertyWirePath } from "../../casePropertyWire";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import {
	type AssetManifest,
	requireAssetRef,
} from "../../multimedia/assetWirePath";
import { quoteLiteral } from "../../predicate/stringQuoting";
import type { InstanceRoot } from "../../predicate/termEmitter";
import { escapeRegex } from "../../xml";
import { buildSortBlock, type ResolvedSortDirective } from "./sortKeys";
import type {
	CaseListEmission,
	CaseListEmitContext,
	DetailKind,
	DetailTarget,
} from "./types";

/**
 * The Element-returning shape `buildColumnField` produces for the
 * case-list detail emitters (`shortDetail.ts`, `longDetail.ts`). The
 * per-field tree slots into a `<detail>` parent without a parse-then-
 * reserialize round-trip. `emitColumnField` serializes the Element to
 * a string for callers that assert against the rendered XML (the
 * test surface).
 */
export interface CaseListFieldEmission {
	readonly element: Element;
	readonly strings: Record<string, string>;
}

/**
 * The CCHQ `detail_type` substring carried in column header
 * locale ids per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`.
 * Two-dimensional lookup: `(target, surface)` → token. The four
 * tokens correspond to the four canonical CCHQ wire ids that
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
 * pins via its `<detail id>` attributes (`m0_case_short` /
 * `m0_search_short` / `m0_case_long` / `m0_search_long`).
 *
 * Every other segment of the locale id stays identical across
 * targets — only this token differs. Centralising the map keeps
 * the locale-id composers symmetric across the four wire ids.
 */
const DETAIL_LOCALE_TYPE: Readonly<
	Record<DetailTarget, Record<DetailKind, string>>
> = {
	case: { short: "case_short", long: "case_long" },
	search: { short: "search_short", long: "search_long" },
};

/**
 * Translate a detail target to the storage-instance id the on-device
 * emitter threads through every relation-walk anchor. CCHQ's
 * `<detail id="m{N}_search_*">` block runs against the search-result
 * roster, while the `<detail id="m{N}_case_*">` block runs against
 * the local casedb. Verified against the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`:
 * `detail[@id='m0_case_short']`'s parent-relation field emits
 * `instance('casedb')/casedb/case[@case_id=current()/index/parent]/whatever`,
 * while `detail[@id='m0_search_short']`'s same field emits
 * `instance('results')/results/case[@case_id=current()/index/parent]/whatever`.
 *
 * The `current()/index/<rel>` segment is identical on both targets
 * (it reads the index off the surrounding evaluation case, not the
 * roster); the only divergence is the outer `instance` reference and
 * its mirrored path segment. Property-rooted column kinds emit bare
 * property identifiers with no instance prefix, so the parameter is
 * a no-op for them — same as the calc-column emission when the
 * expression contains no relation walk.
 */
function instanceRootFor(target: DetailTarget): InstanceRoot {
	return target === "search" ? "results" : "casedb";
}

/** Preserve both graph and root-scope identity whenever a calculated value is
 * lowered. Passing only the graph is insufficient for an authored unqualified
 * relation: the canonicalizer needs the surrounding module case type to know
 * which uniquely typed edge the identifier names. */
function relationContextFor(ctx: CaseListEmitContext) {
	return {
		...(ctx.caseTypes === undefined ? {} : { caseTypes: ctx.caseTypes }),
		...(ctx.currentCaseType === undefined
			? {}
			: { currentCaseType: ctx.currentCaseType }),
	};
}

/**
 * Days-equivalent divisor for each `TimeSinceUnit` arm. Shared by
 * both `interval` arms — `display: "always"` renders the integer
 * interval count, `display: "flag"` compares a day delta against a
 * threshold. The canonical values come from CCHQ's authoring UI
 * module at
 * `commcare-hq/corehq/apps/app_manager/static/app_manager/js/details/utils.js::module.TIME_AGO`:
 *
 *     module.TIME_AGO = {
 *         year: 365.25,
 *         month: 365.25 / 12,
 *         week: 7,
 *         day: 1,
 *     };
 *
 * The values are the SAME divisor regardless of the display arm —
 * the always-display arm emits the divisor verbatim into the
 * XPath; the flag-display arm's threshold-in-days computation
 * multiplies the user-authored unit count by the same divisor.
 * Centralising here keeps the two arms bit-identical on unit math.
 *
 * The fractional `30.4375` (month) emits via `formatTimeAgoDivisor`
 * below — JavaScript's `String(365.25 / 12)` produces
 * `"30.4375"` with no exponent, so a direct interpolation is
 * grammar-safe per the XPath grammar's decimal-literal rule
 * (`grammar.lezer.grammar::NumberLiteral`).
 */
export const TIME_AGO_DIVISOR_DAYS = TIME_SINCE_UNIT_DAYS;

/**
 * Render a `TIME_AGO_DIVISOR_DAYS` value as a wire-form decimal
 * literal. The `String(n)` round-trip is exponent-free for every
 * entry of `TIME_AGO_DIVISOR_DAYS` — the four constants are all
 * non-extreme decimals — so a direct stringification is enough.
 * The helper exists to centralize the rule so any future
 * additional unit (quarters, decades) routes through one
 * formatter rather than scattering string concatenation.
 */
function formatTimeAgoDivisor(divisor: number): string {
	return String(divisor);
}

/**
 * Header-locale-id composer for property-rooted columns. Matches
 * CCHQ's
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`,
 * whose `@pattern('m%d.%s.%s_%s_%d.header')` decorator + body
 * f-string produce
 * `m{module.id}.{detail_type}.{column.model}_{field}_{column.id+1}.header`,
 * where `column.model` is `'case'` for case-detail columns and
 * `detail_type` is one of
 * `case_short` / `case_long` / `search_short` / `search_long` per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`. The
 * `column.id + 1` step keys the suffix to the global 1-based
 * position of the column within its detail.
 *
 * The 1-based position disambiguates duplicate-property columns
 * (the same property rendered through two different format
 * kinds, e.g. plain text + interval).
 *
 * The leading `case_` segment of the suffix tracks CCHQ's
 * `column.model` (the per-instance-shape model name, fixed to
 * `case` for both case-rooted detail blocks); it is NOT redundant
 * with the surrounding `case_short` / `search_short` token. The
 * canonical fixture
 * `commcare-hq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_short']`'s
 * field locale ids (`m0.search_short.case_name_1.header`) confirm
 * the literal `case_` segment survives onto the search target.
 */
function detailHeaderLocaleId(
	target: DetailTarget,
	detailKind: DetailKind,
	moduleIndex: number,
	field: string,
	position: number,
): string {
	const localeType = DETAIL_LOCALE_TYPE[target][detailKind];
	return `m${moduleIndex}.${localeType}.case_${field}_${position}.header`;
}

/**
 * Calculated-column header locale id. Matches CCHQ's
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`
 * — the `useXpathExpression` branch substitutes the literal
 * `calculated_property` for the field segment so the locale id
 * reads `case_calculated_property_<position>.header`. The position
 * is the global 1-based slot in the detail.
 */
function detailCalculatedHeaderLocaleId(
	target: DetailTarget,
	detailKind: DetailKind,
	moduleIndex: number,
	position: number,
): string {
	const localeType = DETAIL_LOCALE_TYPE[target][detailKind];
	return `m${moduleIndex}.${localeType}.case_calculated_property_${position}.header`;
}

/**
 * Build a `<header>` block that resolves through a locale id.
 * The locale id is XML-attribute-safe (alphanumerics + `.` + `_`
 * + `-`) by construction at the composer site, so the serializer's
 * one-pass escape is a no-op here.
 */
function buildHeaderBlock(localeId: string, hidden = false): Element {
	return el("header", hidden ? { width: "0" } : {}, [
		el("text", {}, [el("locale", { id: localeId })]),
	]);
}

/**
 * Build a `<template>` Element whose `<xpath function="...">` is
 * the literal display XPath for a column. The serializer XML-escapes
 * `&` / `<` / `>` / `"` / `'` in the attribute value exactly once at
 * render time, so any wire-form XPath emitted by
 * `lib/commcare/expression/onDeviceEmitter.ts` (single-quoted string
 * literals, `>` comparison operators) round-trips correctly without
 * any local escaping pass.
 *
 * `form` is the optional CCHQ `<template form="...">` attribute.
 * Carries `'phone'` for long-detail phone columns per
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`,
 * which the runtime renders as a tappable-link affordance. CCHQ
 * supports a wider set of `form` values for the long detail
 * (`address`, `image`, `audio`, et al per
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py`) — Nova's
 * authoring vocabulary covers `phone` only at this surface.
 */
function buildTemplateBlock(
	xpathFunction: string,
	form: string | undefined = undefined,
	hidden = false,
): Element {
	const templateAttribs: Record<string, string> = hidden ? { width: "0" } : {};
	if (form !== undefined) templateAttribs.form = form;
	return el("template", templateAttribs, [
		el("text", {}, [el("xpath", { function: xpathFunction })]),
	]);
}

/**
 * Build a `<template>` Element carrying an inline calc reference.
 * The wire shape is CCHQ's `useXpathExpression` form per the
 * `useXpathExpression` branch in
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.template`:
 *
 *     <template>
 *       <text>
 *         <xpath function="$calculated_property">
 *           <variable name="calculated_property">
 *             <xpath function="<calcXpath>"/>
 *           </variable>
 *         </xpath>
 *       </text>
 *     </template>
 *
 * The outer `$calculated_property` is a fixed string — XPath's
 * variable-reference syntax doesn't admit any character that would
 * need escaping. `calcXpath` flows raw into the inner attribute;
 * the serializer escapes the attribute value once at render time.
 */
function buildCalculatedTemplateBlock(
	calcXpath: string,
	hidden = false,
): Element {
	return el("template", hidden ? { width: "0" } : {}, [
		el("text", {}, [
			el("xpath", { function: "$calculated_property" }, [
				el("variable", { name: "calculated_property" }, [
					el("xpath", { function: calcXpath }),
				]),
			]),
		]),
	]);
}

// ============================================================
// Per-kind XPath builders
// ============================================================
//
// Each helper takes the column's `field` (raw property name) and
// any per-kind config, and returns the wire-form XPath the
// `<template>` slot consumes.

/**
 * Plain text column display XPath — bare property reference.
 * Matches CCHQ's `detail_screen.py::Plain` format (which inherits
 * the `XPATH_FUNCTION = "{xpath}"` default from
 * `detail_screen.py::FormattedDetailColumn`).
 */
function plainDisplayXpath(field: string): string {
	return field;
}

/**
 * A plain select column is still authored as Nova's simplest column kind, but
 * its property catalog carries the worker-facing option labels. Derive those
 * labels on device while preserving unknown historical/imported tokens.
 * Non-select plain columns never route through this helper.
 */
export function plainSelectDisplayXpath(
	field: string,
	property: CaseProperty,
): string {
	const options = property.options ?? [];
	if (options.length === 0) return plainDisplayXpath(field);
	if (property.data_type === "single_select") {
		// Exact string equality, never `selected()`: a single-select
		// property stores exactly one option value, and Core's
		// `selected()` is space-token membership
		// (`XPathSelectedFunc.multiSelected`), so a catalog value that is
		// a space-bounded prefix of a later multi-word value ("north" vs
		// "north region") would win by chain order and render the wrong
		// label — while Preview's projection matches the stored value
		// exactly. Equality keeps the two surfaces identical.
		return options.reduceRight((elseArm, option) => {
			const value = quoteLiteral(option.value, "case-list-filter");
			const label = quoteLiteral(option.label, "case-list-filter");
			return `if(${field} = ${value}, ${label}, ${elseArm})`;
		}, field);
	}

	// Multi-select values are space-delimited tokens on device. Known labels
	// use option-catalog order. A second expression removes only those known
	// tokens from the normalized raw value, leaving unknown tokens intact; the
	// final concat appends that honest fallback without ever remapping a label.
	const tokenOptions = options.filter(
		(option) => option.value !== "" && !/\s/.test(option.value),
	);
	if (tokenOptions.length === 0) return plainDisplayXpath(field);
	const knownLabels = idMappingDisplayXpath(field, tokenOptions);
	let unknownTokens = `concat(' ', normalize-space(${field}), ' ')`;
	for (const option of tokenOptions) {
		const pattern = quoteLiteral(
			` ${escapeRegex(option.value)} `,
			"case-list-filter",
		);
		unknownTokens = `replace(${unknownTokens}, ${pattern}, ' ')`;
	}
	return `normalize-space(concat(${knownLabels}, ' ', ${unknownTokens}))`;
}

/**
 * Date-formatted column display XPath. Per CCHQ's
 * `detail_screen.py::Date` format:
 *
 *     if({xpath} = '', '', format-date(date({xpath}), '{date_format}'))
 *
 * The empty-string short-circuit suppresses formatter errors on
 * absent values (CCHQ's `format-date` rejects `date('')`). The
 * pattern routes through `quoteLiteral` against the
 * `case-list-filter` dialect so an embedded `'` flips to the
 * concat-fallback shape rather than producing broken XPath.
 */
function dateDisplayXpath(field: string, pattern: string): string {
	const quotedPattern = quoteLiteral(
		resolveCommCareDatePattern(pattern),
		"case-list-filter",
	);
	return `if(${field} = '', '', format-date(date(${field}), ${quotedPattern}))`;
}

/**
 * `display: "always"` interval-column XPath. Wraps CCHQ's
 * `time-ago` shape with an overdue-text branch:
 *
 *     if({xpath} = '', '',
 *        if(today() - date({xpath}) > <thresholdDays>, '<text>',
 *           string(int((today() - date({xpath})) div <divisor>))))
 *
 * The `today() - date({xpath})` delta is in days; `thresholdDays`
 * is the user-authored `threshold` × the unit's days-equivalent
 * divisor. The integer-interval display divides the same delta by
 * the divisor and floors via `int(...)` to render whole-unit counts
 * (e.g. "3" for "3 weeks"). The empty-string outer guard keeps
 * absent values blank (CCHQ's stock `time-ago` shape).
 *
 * `text` routes through `quoteLiteral` so an embedded `'` flips to
 * concat-fallback rather than producing broken XPath.
 */
function intervalAlwaysXpath(args: {
	readonly field: string;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly text: string;
}): string {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const divisorWire = formatTimeAgoDivisor(divisor);
	const thresholdWire = formatTimeAgoDivisor(thresholdDays);
	const labelLiteral = quoteLiteral(args.text, "case-list-filter");
	const intervalShape = `string(int((today() - date(${args.field})) div ${divisorWire}))`;
	const overdueShape = `if(today() - date(${args.field}) > ${thresholdWire}, ${labelLiteral}, ${intervalShape})`;
	return `if(${args.field} = '', '', ${overdueShape})`;
}

/**
 * `display: "flag"` interval-column XPath. Mirrors CCHQ's
 * `detail_screen.py::LateFlag.XPATH_FUNCTION`:
 *
 *     if({xpath} = '', '<text>', if(today() - date({xpath}) > <thresholdDays>, '<text>', ''))
 *
 * CCHQ hardcodes the flag string to `'*'`; Nova substitutes the
 * author's `text` via `quoteLiteral`. The CCHQ shape surfaces the
 * flag in TWO conditions: the property is absent OR the property
 * is present and the day delta exceeds the threshold. The cell is
 * blank only when the property is present and within threshold.
 *
 * `thresholdDays` is `threshold` × the unit's days-equivalent
 * divisor; CCHQ's wire shape stores the threshold pre-multiplied
 * (the authoring UI computes `threshold_in_days` from a separate
 * unit picker and persists only the day count).
 *
 * Header rendering diverges from CCHQ. CCHQ's
 * `detail_screen.py::LateFlag` extends
 * `detail_screen.py::HideShortHeaderColumn`, which hides the
 * header on short detail. Nova emits a normal `<header>` with the
 * author's `header` text routed through the standard locale-id
 * pattern — the column has its own header label in the Nova
 * authoring surface so the runtime renders that label rather than
 * CCHQ's hidden-header magic.
 */
function intervalFlagXpath(args: {
	readonly field: string;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly text: string;
}): string {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const thresholdWire = formatTimeAgoDivisor(thresholdDays);
	const flagLiteral = quoteLiteral(args.text, "case-list-filter");
	return `if(${args.field} = '', ${flagLiteral}, if(today() - date(${args.field}) > ${thresholdWire}, ${flagLiteral}, ''))`;
}

/**
 * Complete display expression for an authored interval column. HQ JSON uses
 * this same expression through its calculated-column arm; projecting to
 * CCHQ's stock `time-ago` / `late-flag` formats would discard Nova's authored
 * threshold text (and hard-code `*` for flags).
 */
export function intervalColumnDisplayXpath(
	column: Extract<Column, { kind: "interval" }>,
): string {
	const field = emitCasePropertyWirePath(column.field);
	return column.display === "always"
		? intervalAlwaysXpath({
				field,
				threshold: column.threshold,
				unit: column.unit,
				text: column.text,
			})
		: intervalFlagXpath({
				field,
				threshold: column.threshold,
				unit: column.unit,
				text: column.text,
			});
}

/**
 * Phone column display XPath. CCHQ's `detail_screen.py::Phone`
 * format inherits `XPATH_FUNCTION = "{xpath}"` from the base
 * `FormattedDetailColumn` — both detail surfaces emit a bare
 * property reference here. The per-surface divergence
 * (`<template form="phone">` on long, bare `<template>` on short)
 * lives at the `<template>` element level via
 * `emitTemplateBlock`'s `form` parameter, not in the XPath.
 */
function phoneDisplayXpath(field: string): string {
	return field;
}

/**
 * ID-mapping column display XPath. Mirrors CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::XPathEnum.build`
 * shape but inlines labels as XPath string literals rather than
 * referencing locale-id variables (Nova has no multi-language
 * wiring at the authoring layer).
 *
 * Wire shape for a mapping with entries `(value-A, label-A),
 * (value-B, label-B), ...`:
 *
 *     replace(join(' ',
 *       if(selected({xpath}, '<value-A>'), '<label-A>', ''),
 *       if(selected({xpath}, '<value-B>'), '<label-B>', ''),
 *       ...
 *     ), '\s+', ' ')
 *
 * `selected({xpath}, '<value>')` is XPath's space-delimited token
 * membership test — true for either a single-value property
 * equal to `<v>` or a multi-select property whose token list
 * contains `<v>`. The `replace(join(...), '\s+', ' ')` collapse
 * trims double-space artifacts from the empty-arm fall-throughs.
 *
 * Each value AND label routes through `quoteLiteral` for the
 * embedded-quote escape. An empty mapping array short-circuits
 * to an empty-string XPath (`''`) — the runtime renders nothing,
 * matching CCHQ's behavior on a zero-entry enum.
 */
function idMappingDisplayXpath(
	field: string,
	mapping: ReadonlyArray<{ readonly value: string; readonly label: string }>,
): string {
	if (mapping.length === 0) return `''`;
	const arms = mapping.map((entry) => {
		const value = quoteLiteral(entry.value, "case-list-filter");
		const label = quoteLiteral(entry.label, "case-list-filter");
		return `if(selected(${field}, ${value}), ${label}, '')`;
	});
	return `replace(join(' ', ${arms.join(", ")}), '\\s+', ' ')`;
}

/**
 * Image-map column display XPath — maps each case-property value to its
 * `jr://file/commcare/...` image path; with `<template form="image">`
 * (see `templateFormFor`) the runtime renders the resolved path as an
 * image.
 *
 * Shape is a NESTED `if(...)` chain, NOT the `replace(join(' ', …))`
 * wrapper `idMappingDisplayXpath` uses. This is load-bearing and is
 * exactly where image-map diverges from id-mapping: CCHQ applies the
 * `join` wrapper only to `format="enum"` (text id-mapping), while
 * `format="enum-image"` takes the nested-`if` branch — verified at
 * `commcare-hq/.../suite_xml/xml_models.py::XPathEnum.build` (the
 * `type == "display" and format == "enum"` wrapper vs the `elif`) and
 * `detail_screen.py::EnumImage._xpath_template` (`"if({cond}, {var}"`).
 * The wrapper would also CORRUPT the result here: `join(' ', 'jr://x',
 * '', '')` leaves a trailing space (`'jr://x '`), a malformed image
 * path — harmless for a text label, fatal for a resource reference.
 * The nested chain returns the single matching path verbatim.
 *
 * Nova inlines the jr:// literals (rather than CCHQ's app_strings
 * locale variables) and uses `selected(field, value)` membership (the
 * same predicate `idMappingDisplayXpath` uses) — both the single-
 * language simplification Nova applies throughout. An empty mapping
 * short-circuits to `''` (no image).
 *
 * Resolution requires the asset manifest; the media-OFF path degrades
 * the column to plain in `propertyDisplayXpath`, so reaching here with
 * a missing manifest entry is a compiler-bug via `requireAssetRef`.
 */
function imageMapDisplayXpath(
	field: string,
	mapping: ReadonlyArray<{ readonly value: string; readonly assetId: string }>,
	assets: AssetManifest,
): string {
	// Fold right so the first entry is the outermost `if`, matching the
	// runtime's first-match-wins walk: the empty-string base is the final
	// else (no value matched => no image).
	return mapping.reduceRight((elseArm, entry) => {
		const value = quoteLiteral(entry.value, "case-list-filter");
		const path = quoteLiteral(
			requireAssetRef(entry.assetId, assets, "imageMapDisplayXpath"),
			"case-list-filter",
		);
		return `if(selected(${field}, ${value}), ${path}, ${elseArm})`;
	}, `''`);
}

// ============================================================
// Per-Column dispatcher
// ============================================================

/**
 * Resolve the display XPath for a property-rooted column. Calc
 * columns ride the inline-variable template path and don't route
 * through this helper.
 */
function propertyDisplayXpath(
	column: Exclude<Column, { kind: "calculated" }>,
	ctx: CaseListEmitContext,
): string {
	const field = emitCasePropertyWirePath(column.field);
	switch (column.kind) {
		case "plain": {
			const property = ctx.caseProperties.find(
				(candidate) => candidate.name === column.field,
			);
			return property?.data_type === "single_select" ||
				property?.data_type === "multi_select"
				? plainSelectDisplayXpath(field, property)
				: plainDisplayXpath(field);
		}
		case "date":
			return dateDisplayXpath(field, column.pattern);
		case "phone":
			return phoneDisplayXpath(field);
		case "id-mapping":
			return idMappingDisplayXpath(field, column.mapping);
		case "image-map":
			// Media-ON → the per-value image-path chain (rendered via
			// `<template form="image">`). Media-OFF (no manifest) → degrade
			// to the raw property value as a plain column; `templateFormFor`
			// drops the `form="image"` in lockstep so the two never disagree.
			return ctx.assets
				? imageMapDisplayXpath(field, column.mapping, ctx.assets)
				: plainDisplayXpath(field);
		case "interval":
			return intervalColumnDisplayXpath(column);
	}
}

/**
 * Resolve the per-Column `<template>` `form` attribute. Returns
 * `undefined` for the bare-template case and a string for surfaces
 * that carry a CCHQ `form` attribute. Centralising the lookup keeps
 * the per-kind / per-surface matrix in one place.
 *
 * Today only `phone` on long detail surfaces a non-`undefined`
 * value — `'phone'` per
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`.
 * `phone` (long detail) and `image-map` (when media is on) are the two
 * non-`undefined` cases. `image-map` → `'image'` per
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::EnumImage.template_form`,
 * so the runtime renders the display XPath's resolved jr:// path as an
 * image. Media-OFF image-map drops to `undefined` (a plain template
 * over the raw value), matching `propertyDisplayXpath`'s degradation —
 * the form attribute and the display XPath must never disagree.
 */
function templateFormFor(
	column: Exclude<Column, { kind: "calculated" }>,
	detailKind: DetailKind,
	assets: AssetManifest | undefined,
): string | undefined {
	if (column.kind === "phone" && detailKind === "long") return "phone";
	if (column.kind === "image-map" && assets) return "image";
	return undefined;
}

/**
 * Resolve a column's `<sort>` block (or absence thereof). On short
 * detail, looks up the column's uuid in `ctx.sortByUuid`; on long
 * detail, always returns `undefined` — CCHQ's
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
 * short-circuits when `self.detail.display != 'short'` (modulo
 * nodeset-column tabs not modelled in `caseListConfig`), and the
 * canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
 * carries zero `<sort>` blocks despite a multi-key sort on the
 * parent module's short detail. The same suppression rule binds
 * the `m{N}_search_long` block — the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_long']`
 * carries zero `<sort>` blocks alongside the search-short block's
 * directives.
 *
 * Search-target emission re-lowers a calc-arm directive's xpath
 * against the `"results"` instance root so the rendered `<sort>`
 * block carries the search-instance roster for any cross-case calc
 * references. The property-rooted directive arm has no instance
 * prefix and passes through unchanged.
 */
function resolveSortElement(
	column: Column,
	ctx: CaseListEmitContext,
): Element | undefined {
	if (ctx.detailKind === "long") return undefined;
	const directive = ctx.sortByUuid.get(column.uuid);
	if (directive === undefined) return undefined;
	const targeted = retargetSortDirective(directive, column, ctx);
	return buildSortBlock(targeted);
}

/**
 * Re-lower the calc-arm directive's xpath against the target
 * detail's instance root. The case-target directive's xpath is
 * already lowered against `instance('casedb')` (the
 * `buildSortDirectives` default), so the case-target arm returns the
 * directive unchanged; the search-target arm re-emits the column's
 * expression against `instance('results')` and returns a fresh
 * directive carrying the rewritten xpath. The property arm is
 * instance-root-agnostic and passes through.
 */
function retargetSortDirective(
	directive: ResolvedSortDirective,
	column: Column,
	ctx: CaseListEmitContext,
): ResolvedSortDirective {
	if (ctx.target === "case" || directive.kind === "property") return directive;
	if (column.kind !== "calculated") {
		// Structural invariant: a calc-arm directive always pairs with
		// a calculated column. The `buildSortDirectives` pipeline
		// builds the two slots in lockstep keyed off the same column.
		throw new Error(
			`retargetSortDirective received a calculated directive paired with a ${column.kind}-kind column. The directive map keys on column uuid; the kinds must agree.`,
		);
	}
	return {
		...directive,
		calcXpath: emitOnDeviceExpression(
			column.expression,
			instanceRootFor(ctx.target),
			relationContextFor(ctx),
		),
	};
}

/**
 * Build one `<field>` Element for a column. The `position` is 1-based
 * — the surrounding orchestrator passes the column's position in the
 * selected Results or Details wire sequence plus 1 so the locale-id suffix
 * matches CCHQ's `detail_column_header_locale` convention. Off-screen sort
 * carriers keep their Results position, so their sort references remain
 * stable while Details uses its independent order.
 *
 * The dispatch routes calculated columns through the inline-variable
 * template path (CCHQ's `useXpathExpression` branch); every other kind
 * goes through the standard `<header>` / `<template>` pair. May carry a
 * `<template>` `form` attribute (long-detail phone columns) and may
 * carry a `<sort>` block on short detail when the column's uuid keys
 * into `ctx.sortByUuid`. Long detail emits no `<sort>` blocks
 * regardless of `ctx.sortByUuid` content.
 */
export function buildColumnField(args: {
	readonly column: Column;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
	/** Zero-width carrier used only when an off-screen Results field still
	 * owns a Default-order rule. The field remains on the wire for its sort
	 * block without becoming visible in the running app. */
	readonly hidden?: boolean;
}): CaseListFieldEmission {
	const { column, position, ctx, hidden = false } = args;

	if (column.kind === "calculated") {
		return buildCalculatedField({ column, position, ctx, hidden });
	}

	const displayXpath = propertyDisplayXpath(column, ctx);
	const headerLocaleId = detailHeaderLocaleId(
		ctx.target,
		ctx.detailKind,
		ctx.moduleIndex,
		column.field,
		position,
	);
	const fieldChildren: Element[] = [
		buildHeaderBlock(headerLocaleId, hidden),
		buildTemplateBlock(
			displayXpath,
			templateFormFor(column, ctx.detailKind, ctx.assets),
			hidden,
		),
	];
	const sortEl = resolveSortElement(column, ctx);
	if (sortEl !== undefined) fieldChildren.push(sortEl);

	return {
		element: el("field", {}, fieldChildren),
		strings: { [headerLocaleId]: column.header },
	};
}

/**
 * Build one `<field>` Element for a calculated column. The
 * `<template>` carries an inline `<variable name="calculated_property">`
 * holding the lowered ValueExpression XPath, and the `<header>`
 * resolves through the `case_calculated_property_<position>` locale
 * convention.
 *
 * The strings map carries the calc's `header` text under its computed
 * locale id so `app_strings.txt` carries the rendered header at
 * runtime. CCHQ's stock convention has the same shape (per
 * `id_strings.py::detail_column_header_locale`, with the
 * `column.useXpathExpression` branch substituting the literal
 * `calculated_property` for the property name).
 *
 * Sort routing is identical to property-rooted columns: short detail
 * looks up the column's uuid in `ctx.sortByUuid` and the directive
 * carries the inline-variable shape; long detail emits no `<sort>`
 * block.
 */
function buildCalculatedField(args: {
	readonly column: Extract<Column, { kind: "calculated" }>;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
	readonly hidden?: boolean;
}): CaseListFieldEmission {
	const { column, position, ctx, hidden = false } = args;
	// `emitOnDeviceExpression` lowers the AST against the surrounding
	// detail's storage-instance root — `instance('casedb')` for the
	// case-target detail (default), `instance('results')` for the
	// search-target detail. Property-rooted refs (no `via` walk) emit
	// bare property names with no prefix, so the parameter is a no-op
	// for them; cross-case `count(...)` calls and `via`-walked property
	// refs both thread the root through to the relation-walk anchor
	// builders in `lib/commcare/predicate/termEmitter.ts`.
	const calcXpath = emitOnDeviceExpression(
		column.expression,
		instanceRootFor(ctx.target),
		relationContextFor(ctx),
	);
	const headerLocaleId = detailCalculatedHeaderLocaleId(
		ctx.target,
		ctx.detailKind,
		ctx.moduleIndex,
		position,
	);
	const fieldChildren: Element[] = [
		buildHeaderBlock(headerLocaleId, hidden),
		buildCalculatedTemplateBlock(calcXpath, hidden),
	];
	const sortEl = resolveSortElement(column, ctx);
	if (sortEl !== undefined) fieldChildren.push(sortEl);

	return {
		element: el("field", {}, fieldChildren),
		strings: { [headerLocaleId]: column.header },
	};
}

/**
 * String adapter — serializes `buildColumnField`'s Element for callers
 * that assert against the rendered XML string (the test surface). The
 * detail emitters (`shortDetail.ts`, `longDetail.ts`) call
 * `buildColumnField` directly.
 */
export function emitColumnField(args: {
	readonly column: Column;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
}): CaseListEmission {
	const { element, strings } = buildColumnField(args);
	return { xml: render(element, RENDER_OPTS), strings };
}
