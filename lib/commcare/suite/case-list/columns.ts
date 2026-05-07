// lib/commcare/suite/case-list/columns.ts
//
// Per-`Column` and per-`CalculatedColumn` `<field>` block emission
// for the suite-XML case-list detail. Each column produces one
// `<field>` element matching CCHQ's wire vocabulary at
// `commcare-hq/corehq/apps/app_manager/detail_screen.py` —
// per-format-class XPath templates pin the per-kind display +
// sort behavior. The same emitters service both detail surfaces
// (short + long); per-surface divergences (locale-id substring,
// `<sort>` block presence, `<template form="phone">` on long-only,
// `search-only` skip on long-only) flow through the
// `CaseListEmitContext.detailKind` discriminator.
//
// The seven Nova column kinds map to CCHQ formats as follows:
//
//   - `plain`             → CCHQ `detail_screen.py::Plain` format.
//     Bare property reference; the runtime renders the case
//     property's value as text.
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
//   - `time-since-until`  → CCHQ `detail_screen.py::TimeAgo`
//     format wrapped with an overdue-label branch. CCHQ's base
//     shape is
//     `if({xpath} = '', '', string(int((today() - date({xpath})) div <divisor>)))`
//     where `<divisor>` is the days-equivalent of one unit (year =
//     365.25, month = 365.25/12, week = 7, day = 1, per
//     `commcare-hq/corehq/apps/app_manager/static/app_manager/js/details/utils.js::module.TIME_AGO`).
//     The overdue branch wraps that in
//     `if(today() - date({xpath}) > <thresholdDays>, '<displayLabel>', <baseShape>)`
//     so the runtime surfaces the author's overdue text past the
//     threshold and the integer interval otherwise. CCHQ's stock
//     `TimeAgo` has no overdue branch — Nova adds one. Sort uses
//     raw `{xpath}`.
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
//   - `late-flag`         → CCHQ `detail_screen.py::LateFlag`
//     format. Wire shape:
//     `if({xpath} = '', '<flag>', if(today() - date({xpath}) > <thresholdDays>, '<flag>', ''))`.
//     CCHQ hardcodes the flag string to `'*'`; Nova authors it
//     via `flagDisplayValue`. CCHQ's wire shape emits the flag
//     for the absent-property case AND the overdue case, leaving
//     the cell empty only when the date is present and within
//     threshold. Sort uses raw `{xpath}`.
//
//   - `search-only`       → CCHQ `detail_screen.py::Invisible`
//     format (which inherits `HideShortColumn` →
//     `HideShortHeaderColumn`). On short detail, wire shape: a
//     `<field>` with `width="0"` on both `<header>` and
//     `<template>` so the runtime hides the column from the case
//     list while preserving the property as a sort / search
//     target. On long detail, the column emits NO `<field>` at
//     all — Nova's authoring vocabulary defines `search-only` as
//     a search/filter target with no display affordance, and the
//     case-detail screen has no search/filter affordance. The
//     orchestrator handles the skip; the per-Column emitter
//     returns `undefined` to signal the absence.
//
// Calculated columns ride a separate emit path in `emitCalculatedColumnField`
// — the `<template>` body wraps `$calculated_property` around the
// inline value-expression emission, mirroring CCHQ's
// `useXpathExpression` branch in
// `detail_screen.py::FormattedDetailColumn.template`.
//
// `<sort>` block emission is detail-surface-aware. Short detail
// emits sort blocks for both property-rooted and calculated
// columns when `caseListConfig.sort` (or `CalculatedColumn.sort`)
// targets them. Long detail emits no `<sort>` blocks for the
// non-nodeset case, matching CCHQ's
// `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
// short-circuit on `self.detail.display != 'short'`.

import type {
	CalculatedColumn,
	Column,
	SortDirection,
	SortType,
} from "@/lib/domain";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import { quoteLiteral } from "../../predicate/stringQuoting";
import { escapeXml } from "../../xml";
import {
	emitCalculatedSortBlock,
	emitSortBlock,
	findSortKey,
} from "./sortKeys";
import type {
	CaseListEmission,
	CaseListEmitContext,
	DetailKind,
} from "./types";

/**
 * The CCHQ `detail_type` substring carried in column header
 * locale ids per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`.
 * The two surfaces' ids share every other segment; only this
 * token differs (`case_short` vs `case_long`). Centralising the
 * map keeps the locale-id composers symmetric across surfaces.
 */
const DETAIL_KIND_LOCALE_TYPE: Readonly<Record<DetailKind, string>> = {
	short: "case_short",
	long: "case_long",
};

/**
 * Days-equivalent divisor for each `TimeSinceUnit` arm. Shared by
 * both `time-since-until` (renders the integer interval count)
 * and `late-flag` (compares a day delta against a threshold). The
 * canonical values come from CCHQ's authoring UI module at
 * `commcare-hq/corehq/apps/app_manager/static/app_manager/js/details/utils.js::module.TIME_AGO`:
 *
 *     module.TIME_AGO = {
 *         year: 365.25,
 *         month: 365.25 / 12,
 *         week: 7,
 *         day: 1,
 *     };
 *
 * The values are the SAME divisor regardless of the column kind —
 * `time-ago`'s wire formula emits the divisor verbatim into the
 * XPath; `late-flag`'s threshold-in-days computation multiplies
 * the user-authored unit count by the same divisor. Centralising
 * here keeps the two emitters bit-identical on unit math.
 *
 * The fractional `30.4375` (month) emits via `formatTimeAgoDivisor`
 * below — JavaScript's `String(365.25 / 12)` produces
 * `"30.4375"` with no exponent, so a direct interpolation is
 * grammar-safe per the XPath grammar's decimal-literal rule
 * (`grammar.lezer.grammar::NumberLiteral`).
 */
const TIME_AGO_DIVISOR_DAYS = {
	days: 1,
	weeks: 7,
	months: 365.25 / 12,
	years: 365.25,
} as const;

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
 * Header-locale-id composer. Matches CCHQ's
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`,
 * whose `@pattern('m%d.%s.%s_%s_%d.header')` decorator + body
 * f-string produce
 * `m{module.id}.{detail_type}.{column.model}_{field}_{column.id+1}.header`,
 * where `column.model` is `'case'` for case-detail columns and
 * `detail_type` is `case_short` / `case_long` per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`.
 * The `column.id + 1` step keys the suffix to the global
 * 1-based position of the column within its detail (regular
 * columns + calculated columns share the count).
 *
 * The 1-based index disambiguates duplicate-property columns
 * (the same property rendered through two different format
 * kinds, e.g. plain text + late-flag).
 */
function detailHeaderLocaleId(
	detailKind: DetailKind,
	moduleIndex: number,
	field: string,
	position: number,
): string {
	const localeType = DETAIL_KIND_LOCALE_TYPE[detailKind];
	return `m${moduleIndex}.${localeType}.case_${field}_${position}.header`;
}

/**
 * Calculated-column header locale id. Matches CCHQ's
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`
 * — the `useXpathExpression` branch substitutes the literal
 * `calculated_property` for the field segment so the locale id
 * reads `case_calculated_property_<position>.header`.
 * The position is the global 1-based slot in the detail; the
 * orchestrator passes `regularColumnCount + calcIndex + 1` so
 * the count continues across the regular-column pass.
 */
function detailCalculatedHeaderLocaleId(
	detailKind: DetailKind,
	moduleIndex: number,
	position: number,
): string {
	const localeType = DETAIL_KIND_LOCALE_TYPE[detailKind];
	return `m${moduleIndex}.${localeType}.case_calculated_property_${position}.header`;
}

/**
 * Build a `<header>` block that resolves through a locale id.
 * The locale id is XML-attribute-safe (alphanumerics + `.` + `_`
 * + `-`) by construction at the composer site, so no escape pass
 * is needed here.
 */
function emitHeaderBlock(localeId: string): string {
	return [
		`      <header>`,
		`        <text>`,
		`          <locale id="${localeId}"/>`,
		`        </text>`,
		`      </header>`,
	].join("\n");
}

/**
 * Build a `<template>` block whose `<xpath function="...">` is
 * the literal display XPath for a column. The `xpathFunction`
 * is escaped for XML-attribute-value rules (the same set
 * `escapeXml` covers — `&` / `<` / `>` / `"`).
 *
 * Single quotes are NOT escaped: every wire-form XPath emitted
 * by `lib/commcare/expression/onDeviceEmitter.ts` and the per-
 * format helpers below quotes string literals with single
 * quotes, so the attribute's enclosing double quotes stay safe.
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
function emitTemplateBlock(
	xpathFunction: string,
	form: string | undefined = undefined,
): string {
	const formAttr = form !== undefined ? ` form="${form}"` : "";
	return [
		`      <template${formAttr}>`,
		`        <text>`,
		`          <xpath function="${escapeXml(xpathFunction)}"/>`,
		`        </text>`,
		`      </template>`,
	].join("\n");
}

/**
 * Build a `<template>` block carrying an inline calc reference.
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
 * `calcXpath` is XML-attribute-escaped before interpolation. The
 * outer `$calculated_property` stays a fixed string — XPath's
 * variable-reference syntax doesn't admit any character that
 * would need escaping.
 */
function emitCalculatedTemplateBlock(calcXpath: string): string {
	return [
		`      <template>`,
		`        <text>`,
		`          <xpath function="$calculated_property">`,
		`            <variable name="calculated_property">`,
		`              <xpath function="${escapeXml(calcXpath)}"/>`,
		`            </variable>`,
		`          </xpath>`,
		`        </text>`,
		`      </template>`,
	].join("\n");
}

/**
 * Build a hidden `<header>` / `<template>` pair for a search-only
 * column. CCHQ's `detail_screen.py::Invisible` format inherits
 * this hide-on-short behavior across two parent classes:
 *   - `commcare-hq/corehq/apps/app_manager/detail_screen.py::HideShortHeaderColumn.header`
 *     overrides `header` to return an empty `<text/>` with
 *     `width=template_width` on short detail.
 *   - `commcare-hq/corehq/apps/app_manager/detail_screen.py::HideShortColumn.template_width`
 *     extends `HideShortHeaderColumn` and overrides
 *     `template_width` to return `0` on short detail.
 * `detail_screen.py::Invisible` inherits both. The combined effect
 * on short detail is a `<header width="0"><text/></header>` plus
 * a `<template width="0">` body — the runtime collapses the
 * column visually while keeping the property in the case-list's
 * indexable schema.
 */
function emitHiddenFieldBody(xpathFunction: string): string {
	return [
		`      <header width="0">`,
		`        <text/>`,
		`      </header>`,
		`      <template width="0">`,
		`        <text>`,
		`          <xpath function="${escapeXml(xpathFunction)}"/>`,
		`        </text>`,
		`      </template>`,
	].join("\n");
}

// ============================================================
// Per-kind XPath builders
// ============================================================
//
// Each helper takes the column's `field` (raw property name) and
// any per-kind config, and returns the wire-form XPath the
// `<template>` slot consumes. Sort XPaths are emitted separately
// (they always read the raw `field` for date / time-since-until
// / late-flag arms; for plain / phone / id-mapping the sort and
// display XPaths are identical).

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
	const quotedPattern = quoteLiteral(pattern, "case-list-filter");
	return `if(${field} = '', '', format-date(date(${field}), ${quotedPattern}))`;
}

/**
 * Time-since-until column display XPath. Wraps CCHQ's `time-ago`
 * shape with an overdue-label branch:
 *
 *     if({xpath} = '', '',
 *        if(today() - date({xpath}) > <thresholdDays>, '<label>',
 *           string(int((today() - date({xpath})) div <divisor>))))
 *
 * The `today() - date({xpath})` delta is in days; `thresholdDays`
 * is the user-authored `threshold` × the unit's days-equivalent
 * divisor. The integer-interval display divides the same delta
 * by the divisor and floors via `int(...)` to render whole-unit
 * counts (e.g. "3" for "3 weeks"). The empty-string outer guard
 * keeps absent values blank (CCHQ's stock `time-ago` shape).
 *
 * `displayLabel` routes through `quoteLiteral` so an embedded
 * `'` flips to concat-fallback rather than producing broken
 * XPath.
 */
function timeSinceUntilDisplayXpath(args: {
	readonly field: string;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly displayLabel: string;
}): string {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const divisorWire = formatTimeAgoDivisor(divisor);
	const thresholdWire = formatTimeAgoDivisor(thresholdDays);
	const labelLiteral = quoteLiteral(args.displayLabel, "case-list-filter");
	const intervalShape = `string(int((today() - date(${args.field})) div ${divisorWire}))`;
	const overdueShape = `if(today() - date(${args.field}) > ${thresholdWire}, ${labelLiteral}, ${intervalShape})`;
	return `if(${args.field} = '', '', ${overdueShape})`;
}

/**
 * Phone column display XPath. CCHQ's
 * `detail_screen.py::Phone` format inherits
 * `XPATH_FUNCTION = "{xpath}"` from the base
 * `FormattedDetailColumn` — both detail surfaces emit a bare
 * property reference here. The per-surface divergence
 * (`<template form="phone">` on long, bare `<template>` on
 * short) lives at the `<template>` element level via
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
 * Late-flag column display XPath. CCHQ's
 * `detail_screen.py::LateFlag` format emits:
 *
 *     if({xpath} = '', '*', if(today() - date({xpath}) > <thresholdDays>, '*', ''))
 *
 * CCHQ hardcodes the flag string to `'*'`; Nova substitutes the
 * author's `flagDisplayValue` via `quoteLiteral`. The CCHQ shape
 * surfaces the flag in TWO conditions: the property is absent OR
 * the property is present and the day delta exceeds the
 * threshold. The cell is blank only when the property is present
 * and within threshold.
 *
 * `thresholdDays` is `threshold` × the unit's days-equivalent
 * divisor; CCHQ's wire shape stores the threshold pre-multiplied
 * (the authoring UI computes `threshold_in_days` from a separate
 * unit picker and persists only the day count).
 *
 * Header rendering diverges from CCHQ. CCHQ's
 * `detail_screen.py::LateFlag` extends
 * `detail_screen.py::HideShortHeaderColumn`, which hides the
 * header on short detail and emits
 * `<header width="11%"><text/></header>` (canonical fixture:
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml`
 * under `<detail id="m0_case_short">/<field>` for `late-flag`).
 * Nova emits a normal `<header>` with the author's `header` text
 * routed through the standard locale-id pattern — the late-flag
 * column has its own header label in the Nova authoring surface
 * (the column-editor field is exposed alongside `flagDisplayValue`),
 * so the runtime renders that label rather than CCHQ's hidden-
 * header magic. The decision is grounded in
 * `feedback_dont_inherit_cchq_ux_at_authoring_layer.md`: CCHQ's
 * authoring surface (header-must-be-hidden-for-this-format) is
 * not a wire constraint and Nova's authoring layer chooses to
 * surface a normal header instead.
 */
function lateFlagDisplayXpath(args: {
	readonly field: string;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly flagDisplayValue: string;
}): string {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const thresholdWire = formatTimeAgoDivisor(thresholdDays);
	const flagLiteral = quoteLiteral(args.flagDisplayValue, "case-list-filter");
	return `if(${args.field} = '', ${flagLiteral}, if(today() - date(${args.field}) > ${thresholdWire}, ${flagLiteral}, ''))`;
}

// ============================================================
// Per-Column dispatcher
// ============================================================

/**
 * The displayed-column subset of the `Column` discriminated
 * union. `search-only` is the one kind that never reaches the
 * display + sort resolution path because its `<field>` body is a
 * hidden width=0 stub; every other kind goes through
 * `resolveColumnXpaths`.
 */
type DisplayedColumn = Exclude<Column, { kind: "search-only" }>;

/**
 * Resolve the display + sort XPath pair for a displayed column.
 * Two values because CCHQ's per-format design splits them — date
 * / time-since-until / late-flag display a transformed value but
 * sort by the raw property (so ISO-string lexicographic order
 * matches calendar order, and so an overdue-flagged row sorts
 * by its actual date rather than by the flag string). For
 * plain / phone / id-mapping the two XPaths are identical.
 *
 * Search-only is excluded from the input type — that path skips
 * this resolver entirely (see `emitColumnField`'s search-only
 * branch) because the hidden body has no slot for either xpath.
 */
function resolveColumnXpaths(column: DisplayedColumn): {
	readonly display: string;
	readonly sort: string;
} {
	switch (column.kind) {
		case "plain":
			return {
				display: plainDisplayXpath(column.field),
				sort: column.field,
			};
		case "date":
			return {
				display: dateDisplayXpath(column.field, column.pattern),
				sort: column.field,
			};
		case "time-since-until":
			return {
				display: timeSinceUntilDisplayXpath({
					field: column.field,
					threshold: column.threshold,
					unit: column.unit,
					displayLabel: column.displayLabel,
				}),
				sort: column.field,
			};
		case "phone":
			return {
				display: phoneDisplayXpath(column.field),
				sort: column.field,
			};
		case "id-mapping":
			return {
				display: idMappingDisplayXpath(column.field, column.mapping),
				sort: column.field,
			};
		case "late-flag":
			return {
				display: lateFlagDisplayXpath({
					field: column.field,
					threshold: column.threshold,
					unit: column.unit,
					flagDisplayValue: column.flagDisplayValue,
				}),
				sort: column.field,
			};
		default: {
			const _exhaustive: never = column;
			throw new Error(
				`emitColumn: unhandled DisplayedColumn kind ${String(_exhaustive)}`,
			);
		}
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
 * Other CCHQ `template_form` values (`address`, `image`, `audio`,
 * et al) belong to column kinds Nova does not author at this
 * layer.
 */
function templateFormFor(
	column: DisplayedColumn,
	detailKind: DetailKind,
): string | undefined {
	if (column.kind === "phone" && detailKind === "long") return "phone";
	return undefined;
}

/**
 * Emit one `<field>` block for a regular (property-rooted) column.
 * The position is 1-based — the surrounding orchestrator passes
 * the column's index plus 1 so the locale-id suffix matches CCHQ's
 * `detail_column_header_locale` convention.
 *
 * Three return shapes:
 *
 *   - `undefined` — the column doesn't produce a `<field>` on
 *     this surface. Today's only path is `search-only` on long
 *     detail (per `DetailKind`'s authoring-vocabulary contract).
 *     The orchestrator skips the result; the 1-based position
 *     counter still advances for the skipped slot, matching
 *     CCHQ's `column.id`-keyed numbering convention.
 *   - hidden `<field>` — `search-only` on short detail uses
 *     `emitHiddenFieldBody` (`width="0"` header + template pair)
 *     without a `<sort>` block. The `<field>` exists only so the
 *     property is declared at the detail layer for downstream
 *     search-input emission to bind against.
 *   - normal `<field>` — every other kind uses the standard
 *     `<header>` / `<template>` pair, may carry a `<template>`
 *     `form` attribute (long-detail phone columns), and may
 *     carry a `<sort>` block on short detail when a key in
 *     `ctx.sort` targets the column's property. Long detail emits
 *     no `<sort>` blocks regardless of `ctx.sort` content.
 */
export function emitColumnField(args: {
	readonly column: Column;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
}): CaseListEmission | undefined {
	const { column, position, ctx } = args;

	// Search-only columns split by detail surface. Long detail
	// emits no field for them — Nova's authoring vocabulary
	// defines `search-only` as a search/filter target with no
	// display affordance, and the case-detail screen has no
	// search/filter affordance.
	if (column.kind === "search-only") {
		if (ctx.detailKind === "long") return undefined;
		const xml = `    <field>\n${emitHiddenFieldBody(column.field)}\n    </field>`;
		return { xml, strings: {} };
	}

	// Every other kind goes through the displayed-column
	// resolver. Narrowing on the search-only short-circuit above
	// is enough for TypeScript to admit `column` as
	// `DisplayedColumn` here.
	const xpaths = resolveColumnXpaths(column);
	const headerLocaleId = detailHeaderLocaleId(
		ctx.detailKind,
		ctx.moduleIndex,
		column.field,
		position,
	);
	const headerXml = emitHeaderBlock(headerLocaleId);
	const templateXml = emitTemplateBlock(
		xpaths.display,
		templateFormFor(column, ctx.detailKind),
	);
	const sortXml = resolvePropertySortXml(column, xpaths.sort, ctx);
	const parts = [`    <field>`, headerXml, templateXml];
	if (sortXml !== undefined) parts.push(sortXml);
	parts.push(`    </field>`);
	const xml = parts.join("\n");

	return {
		xml,
		strings: {
			[headerLocaleId]: column.header,
		},
	};
}

/**
 * Resolve a property-rooted column's `<sort>` block (or absence
 * thereof). On short detail, walks `ctx.sort` for a
 * property-source key matching the column's `field` and emits
 * the wire-shape `<sort>` block when one matches. On long detail,
 * always returns `undefined` — CCHQ's
 * `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
 * short-circuits when `self.detail.display != 'short'` (modulo
 * nodeset-column tabs not modelled in `caseListConfig`), and the
 * canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
 * has zero `<sort>` blocks despite a multi-key sort on the parent
 * module's short detail.
 *
 * Restricted to `DisplayedColumn` because search-only columns
 * never reach this resolver — their emit path short-circuits in
 * `emitColumnField` before sort resolution.
 */
function resolvePropertySortXml(
	column: DisplayedColumn,
	sortXpath: string,
	ctx: CaseListEmitContext,
): string | undefined {
	if (ctx.detailKind === "long") return undefined;
	const match = findSortKey(ctx.sort, {
		kind: "property",
		property: column.field,
	});
	if (match === undefined) return undefined;
	return emitSortBlock({
		order: match.order,
		direction: match.key.direction,
		type: match.key.type,
		xpathFunction: sortXpath,
	});
}

/**
 * Emit one `<field>` block for a calculated column. The
 * `<template>` carries an inline `<variable name="calculated_property">`
 * holding the lowered ValueExpression XPath, and the `<header>`
 * resolves through the `case_calculated_property_<position>`
 * locale convention.
 *
 * Position math mirrors the regular-column case — 1-based, used
 * for the locale id's collision-disambiguation suffix.
 *
 * The strings map carries the calc's `header` text under its
 * computed locale id so `app_strings.txt` carries the rendered
 * header at runtime. CCHQ's stock convention has the same shape
 * (per `id_strings.py::detail_column_header_locale`, with the
 * `column.useXpathExpression` branch substituting the literal
 * `calculated_property` for the property name).
 */
export function emitCalculatedColumnField(args: {
	readonly calculated: CalculatedColumn;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
}): CaseListEmission {
	const { calculated, position, ctx } = args;
	const calcXpath = emitOnDeviceExpression(calculated.expression);
	const headerLocaleId = detailCalculatedHeaderLocaleId(
		ctx.detailKind,
		ctx.moduleIndex,
		position,
	);
	const headerXml = emitHeaderBlock(headerLocaleId);
	const templateXml = emitCalculatedTemplateBlock(calcXpath);

	const parts: string[] = [`    <field>`, headerXml, templateXml];

	// Sort resolution for calculated columns is short-detail-only.
	// Long detail emits no `<sort>` blocks per the same CCHQ rule
	// `resolvePropertySortXml` documents
	// (`detail_screen.py::FormattedDetailColumn.sort_node`
	// short-circuits on `self.detail.display != 'short'`); the
	// canonical fixture
	// `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`
	// carries three calculated-property fields with zero `<sort>`
	// blocks.
	//
	// Within the short-detail branch, two paths the schema admits:
	//
	//   1. A module-level sort key targets the calc by id
	//      (`SortKey.source.kind === "calculated"`). The calc
	//      participates in the multi-key sort and its `<sort>`
	//      block carries the 1-based `order` attribute matching
	//      the key's position in `caseListConfig.sort`.
	//   2. The calc carries its own `sort` slot
	//      (`CalculatedColumn.sort`) — a per-column sort config
	//      that doesn't enter the module-level array. The wire
	//      layer emits `<sort>` WITHOUT an `order` attribute,
	//      matching CCHQ's per-format-default sort shape: the
	//      canonical fixture
	//      `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`
	//      under `<detail id="m0_case_short">` carries a second
	//      `birthdate` field whose `<sort type="string">` block
	//      has no `order` attribute. The runtime treats no-order
	//      `<sort>` blocks as per-column defaults that the
	//      multi-sort UI surfaces alongside the explicit keys.
	//
	// A module-level key wins over a calc-local sort when both
	// are authored — the module-level array is the canonical
	// multi-key spec.
	if (ctx.detailKind === "short") {
		const moduleSortMatch = findSortKey(ctx.sort, {
			kind: "calculated",
			id: calculated.id,
		});
		if (moduleSortMatch !== undefined) {
			parts.push(
				emitCalculatedSortBlock({
					order: moduleSortMatch.order,
					direction: moduleSortMatch.key.direction,
					type: moduleSortMatch.key.type,
					calcXpath,
				}),
			);
		} else if (calculated.sort !== undefined) {
			parts.push(
				emitCalculatedSortBlock({
					order: undefined,
					direction: calculated.sort.direction,
					type: calculated.sort.type,
					calcXpath,
				}),
			);
		}
	}

	parts.push(`    </field>`);

	return {
		xml: parts.join("\n"),
		strings: {
			[headerLocaleId]: calculated.header,
		},
	};
}

/**
 * Re-export the `SortType` / `SortDirection` enums purely as a
 * convenience for callers that compose sort blocks from values
 * sourced through this module's surface (e.g. test fixtures).
 * Both types are pure type-level imports under
 * `verbatimModuleSyntax`.
 */
export type { SortDirection, SortType };
