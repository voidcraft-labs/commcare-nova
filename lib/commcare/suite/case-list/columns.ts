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
// The six Nova column kinds map to CCHQ formats as follows:
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

import type { Column } from "@/lib/domain";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import { quoteLiteral } from "../../predicate/stringQuoting";
import { escapeXml } from "../../xml";
import { emitSortBlock } from "./sortKeys";
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
 * Header-locale-id composer for property-rooted columns. Matches
 * CCHQ's
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`,
 * whose `@pattern('m%d.%s.%s_%s_%d.header')` decorator + body
 * f-string produce
 * `m{module.id}.{detail_type}.{column.model}_{field}_{column.id+1}.header`,
 * where `column.model` is `'case'` for case-detail columns and
 * `detail_type` is `case_short` / `case_long` per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`.
 * The `column.id + 1` step keys the suffix to the global 1-based
 * position of the column within its detail.
 *
 * The 1-based position disambiguates duplicate-property columns
 * (the same property rendered through two different format
 * kinds, e.g. plain text + interval).
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
 * reads `case_calculated_property_<position>.header`. The position
 * is the global 1-based slot in the detail.
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
): string {
	switch (column.kind) {
		case "plain":
			return plainDisplayXpath(column.field);
		case "date":
			return dateDisplayXpath(column.field, column.pattern);
		case "phone":
			return phoneDisplayXpath(column.field);
		case "id-mapping":
			return idMappingDisplayXpath(column.field, column.mapping);
		case "interval":
			return column.display === "always"
				? intervalAlwaysXpath({
						field: column.field,
						threshold: column.threshold,
						unit: column.unit,
						text: column.text,
					})
				: intervalFlagXpath({
						field: column.field,
						threshold: column.threshold,
						unit: column.unit,
						text: column.text,
					});
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
	column: Exclude<Column, { kind: "calculated" }>,
	detailKind: DetailKind,
): string | undefined {
	if (column.kind === "phone" && detailKind === "long") return "phone";
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
 * parent module's short detail.
 */
function resolveSortXml(
	column: Column,
	ctx: CaseListEmitContext,
): string | undefined {
	if (ctx.detailKind === "long") return undefined;
	const directive = ctx.sortByUuid.get(column.uuid);
	if (directive === undefined) return undefined;
	return emitSortBlock(directive);
}

/**
 * Emit one `<field>` block for a column. The `position` is 1-based
 * — the surrounding orchestrator passes the column's source-array
 * index plus 1 so the locale-id suffix matches CCHQ's
 * `detail_column_header_locale` convention. Position is keyed off
 * the source-array index (config-time), NOT a render-time visible-
 * column counter — toggling `visibleInList` / `visibleInDetail`
 * doesn't churn locale ids.
 *
 * The dispatch routes calculated columns through the inline-
 * variable template path (CCHQ's `useXpathExpression` branch); every
 * other kind goes through the standard `<header>` / `<template>`
 * pair. May carry a `<template>` `form` attribute (long-detail
 * phone columns) and may carry a `<sort>` block on short detail
 * when the column's uuid keys into `ctx.sortByUuid`. Long detail
 * emits no `<sort>` blocks regardless of `ctx.sortByUuid` content.
 */
export function emitColumnField(args: {
	readonly column: Column;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
}): CaseListEmission {
	const { column, position, ctx } = args;

	if (column.kind === "calculated") {
		return emitCalculatedField({ column, position, ctx });
	}

	const displayXpath = propertyDisplayXpath(column);
	const headerLocaleId = detailHeaderLocaleId(
		ctx.detailKind,
		ctx.moduleIndex,
		column.field,
		position,
	);
	const headerXml = emitHeaderBlock(headerLocaleId);
	const templateXml = emitTemplateBlock(
		displayXpath,
		templateFormFor(column, ctx.detailKind),
	);
	const sortXml = resolveSortXml(column, ctx);
	const parts = [`    <field>`, headerXml, templateXml];
	if (sortXml !== undefined) parts.push(sortXml);
	parts.push(`    </field>`);

	return {
		xml: parts.join("\n"),
		strings: {
			[headerLocaleId]: column.header,
		},
	};
}

/**
 * Emit one `<field>` block for a calculated column. The
 * `<template>` carries an inline `<variable name="calculated_property">`
 * holding the lowered ValueExpression XPath, and the `<header>`
 * resolves through the `case_calculated_property_<position>`
 * locale convention.
 *
 * The strings map carries the calc's `header` text under its
 * computed locale id so `app_strings.txt` carries the rendered
 * header at runtime. CCHQ's stock convention has the same shape
 * (per `id_strings.py::detail_column_header_locale`, with the
 * `column.useXpathExpression` branch substituting the literal
 * `calculated_property` for the property name).
 *
 * Sort routing is identical to property-rooted columns: short
 * detail looks up the column's uuid in `ctx.sortByUuid` and the
 * directive carries the inline-variable shape; long detail emits
 * no `<sort>` block.
 */
function emitCalculatedField(args: {
	readonly column: Extract<Column, { kind: "calculated" }>;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
}): CaseListEmission {
	const { column, position, ctx } = args;
	const calcXpath = emitOnDeviceExpression(column.expression);
	const headerLocaleId = detailCalculatedHeaderLocaleId(
		ctx.detailKind,
		ctx.moduleIndex,
		position,
	);
	const headerXml = emitHeaderBlock(headerLocaleId);
	const templateXml = emitCalculatedTemplateBlock(calcXpath);
	const sortXml = resolveSortXml(column, ctx);

	const parts = [`    <field>`, headerXml, templateXml];
	if (sortXml !== undefined) parts.push(sortXml);
	parts.push(`    </field>`);

	return {
		xml: parts.join("\n"),
		strings: {
			[headerLocaleId]: column.header,
		},
	};
}
