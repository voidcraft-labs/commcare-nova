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
//     pattern is a string literal whose quotes the serializer escapes.
//     Its sort key is the raw `{xpath}` (CCHQ's
//     `Date.SORT_XPATH_FUNCTION = "{xpath}"`), so ISO-string order
//     matches calendar order.
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
//     locale-id labels. Nova projects those variables from its central
//     translation inventory, while the pure XPath helper retains literal
//     labels as its language-neutral fallback. The `selected()` arm matches against the raw
//     property value; the `replace(join(...), '\\s+', ' ')` collapse
//     trims the leading whitespace from the join's empty-arm
//     fall-throughs. Its sort key is the mapping position
//     (`sortKeys.ts::idMappingSortXpath`), as HQ's `enum` sorts.
//
//   - `image-map`         → CCHQ `detail_screen.py::EnumImage` format
//     (`<template form="image">`). The id-mapping shape with image
//     paths instead of text labels: a NESTED-`if` chain
//     `if(selected({xpath}, 'value-1'), 'jr://file/commcare/<hash><ext>',
//     if(...))` inlining the resolved `jr://` path literals. Nested-if
//     (not id-mapping's `replace(join(...))`) because the join's
//     empty-arm collapse would leave a trailing space inside a matched
//     `jr://` path and break the reference. Written as images wherever
//     `imageMapShowsImages` holds, at `13%` like HQ's build; otherwise a
//     plain column over the raw property value.
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
//     Its sort key is the text it shows, as HQ's `translatable-enum`
//     sorts.
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
// emits a sort block for every field that keeps a sort key in the
// order plan (`ctx.sortByUuid`). A field hidden from Results is HQ's
// `invisible` column: an empty header and a raw template at width 0.
// Long detail emits no `<sort>` blocks for the
// non-nodeset case, matching CCHQ's
// `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
// short-circuit on `self.detail.display != 'short'`.

import type { Element } from "domhandler";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { w } from "@/lib/commcare/xpath/wire/builders";
import {
	toWire,
	type WireBuildContext,
} from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	type CaseProperty,
	type Column,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	imageMapShowsImages,
	makeTranslationUnitId,
	printProseTemplate,
	TIME_SINCE_UNIT_DAYS,
	type TranslationUnitId,
	tileCellFor,
} from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	type AssetManifest,
	requireAssetRef,
} from "../../multimedia/assetWirePath";
import { escapeRegex } from "../../xml";
import { INLINE_SEARCH_INPUT_INSTANCE_ID } from "../case-search/noMatches";
import { casePropertyPath, normalizeSpace } from "../wire";
import { keyAsVariable } from "./keyVariable";
import {
	buildSortBlock,
	calculatedPropertyText,
	type ResolvedSortDirective,
} from "./sortKeys";
import { buildTileStyleBlock } from "./tileStyle";
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
	readonly translationUnits: Record<string, TranslationUnitId>;
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
function instanceRootFor(
	ctx: Pick<CaseListEmitContext, "target" | "caseSource">,
): "casedb" | "results" | "results:inline" {
	if (ctx.target === "search") return "results";
	return ctx.caseSource ?? "casedb";
}

/** Preserve both graph and root-scope identity whenever a calculated value is
 * lowered. Passing only the graph is insufficient for an authored unqualified
 * relation: the canonicalizer needs the surrounding module case type to know
 * which uniquely typed edge the identifier names. */
/** Term-emission context carrying the run's lookup naming, when present. */
function lookupTermContext(
	ctx: CaseListEmitContext,
): NonNullable<WireBuildContext["bindings"]> {
	return {
		// A search-first module's list is the inline query's results, which
		// keep the Search answers beside them.
		...(ctx.caseSource === "results:inline"
			? { searchInputInstanceId: INLINE_SEARCH_INPUT_INSTANCE_ID }
			: {}),
		...(ctx.lookupNaming === undefined
			? {}
			: {
					lookup: {
						naming: ctx.lookupNaming,
						instanceScope: "suite",
					},
				}),
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
 * The serializer prints every divisor as a finite numeric literal.
 */
export const TIME_AGO_DIVISOR_DAYS = TIME_SINCE_UNIT_DAYS;

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
	return `${detailColumnLocaleBase(target, detailKind, moduleIndex, field, position)}.header`;
}

/**
 * The stem every locale id of one property-rooted column shares,
 * `m<N>.<detail>.case_<field>_<position>`: the header appends `.header`,
 * an id-mapping value `.enum.<variable>` and an image-map key's alt text
 * `.alt_text.<variable>` (`id_strings.py::detail_column_header_locale`,
 * `detail_column_enum_variable`, `detail_column_alt_text_variable`).
 */
function detailColumnLocaleBase(
	target: DetailTarget,
	detailKind: DetailKind,
	moduleIndex: number,
	field: string,
	position: number,
): string {
	const localeType = DETAIL_LOCALE_TYPE[target][detailKind];
	return `m${moduleIndex}.${localeType}.case_${field}_${position}`;
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
 * one-pass escape is a no-op here. `width` is the header's width hint
 * where the column has one (an image map's `13%`).
 */
function buildHeaderBlock(localeId: string, width?: string): Element {
	return el("header", width === undefined ? {} : { width }, [
		el("text", {}, [el("locale", { id: localeId })]),
	]);
}

/**
 * The header of a field hidden from Results: width 0 over an empty text,
 * with no locale id, which is the header HQ's build writes for an
 * `invisible` column whose sort element has no display text
 * (`detail_screen.py::Invisible.header`, `models/case_list.py::
 * SortElement.has_display_values`). With it Android's Sort menu lists the
 * shown columns alone, and the field's header is no app string.
 */
function buildHiddenHeaderBlock(): Element {
	return el("header", { width: "0" }, [el("text", {}, [])]);
}

/**
 * The width hint an image map's header and template carry where it is
 * written as images, on the short and the long detail alike: HQ's build
 * writes `13%` (`detail_screen.py::EnumImage.header_width` and
 * `template_width`, with no dynamic width).
 */
const IMAGE_MAP_WIDTH = "13%";

/**
 * Build a `<template>` Element whose `<xpath function="...">` is
 * the literal display XPath for a column. The serializer XML-escapes
 * `&` / `<` / `>` / `"` / `'` in the attribute value exactly once at
 * render time, so any wire-form XPath emitted by
 * `lib/commcare/xpath/wire/fromExpression.ts` (single-quoted string
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
	xpathFunction: WireExpr,
	context: WireElementContext,
	form: string | undefined = undefined,
	width: string | undefined = undefined,
	variables: readonly Element[] = [],
): Element {
	const templateAttribs: Record<string, string> = {};
	if (form !== undefined) templateAttribs.form = form;
	if (width !== undefined) templateAttribs.width = width;
	return el("template", templateAttribs, [
		el("text", {}, [
			xel("xpath", { xpath: { function: xpathFunction } }, context, [
				...variables,
			]),
		]),
	]);
}

interface LocalizedDisplayProjection {
	readonly xpath: WireExpr;
	readonly variables: readonly Element[];
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, TranslationUnitId>;
}

function localizedVariable(
	index: number,
	localeId: string,
	source: string,
	unitId: TranslationUnitId,
): LocalizedDisplayProjection {
	const name = `knova_text_${index}`;
	return {
		xpath: w.enumLabelVar(index),
		variables: [el("variable", { name }, [el("locale", { id: localeId })])],
		strings: { [localeId]: source },
		translationUnits: { [localeId]: unitId },
	};
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
 * Both expressions are typed trees. Their prints contribute reads to the
 * detail's instance sink before XML attribute escaping.
 */
function buildCalculatedTemplateBlock(
	calcXpath: WireExpr,
	context: WireElementContext,
	width?: string,
): Element {
	return el("template", width === undefined ? {} : { width }, [
		el("text", {}, [
			xel(
				"xpath",
				{ xpath: { function: w.calculatedPropertyVar() } },
				context,
				[
					el("variable", { name: "calculated_property" }, [
						xel("xpath", { xpath: { function: calcXpath } }, context),
					]),
				],
			),
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
function plainDisplayXpath(field: WireExpr): WireExpr {
	return field;
}

/**
 * A plain select column is still authored as Nova's simplest column kind, but
 * its property catalog carries the worker-facing option labels. Derive those
 * labels on device while preserving unknown historical/imported tokens.
 * Non-select plain columns never route through this helper.
 */
export function plainSelectDisplayXpath(
	field: WireExpr,
	property: CaseProperty,
	doc: CaseListEmitContext["proseDoc"],
	labelExpression?: (
		option: NonNullable<CaseProperty["options"]>[number],
		index: number,
	) => WireExpr,
): WireExpr {
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
		return options.reduceRight<WireExpr>((elseArm, option, index) => {
			const value = w.str(option.value);
			const label =
				labelExpression?.(option, index) ??
				w.str(printProseTemplate(option.label, doc));
			return w.call("if", [w.eq(field, value), label, elseArm]);
		}, field);
	}

	// Multi-select values are space-delimited tokens on device. Known labels
	// use option-catalog order. A second expression removes only those known
	// tokens from the normalized raw value, leaving unknown tokens intact; the
	// final concat appends that honest fallback without ever remapping a label.
	const tokenOptions = options.flatMap((option, index) =>
		option.value !== "" && !/\s/.test(option.value)
			? [{ option, originalIndex: index }]
			: [],
	);
	if (tokenOptions.length === 0) return plainDisplayXpath(field);
	const knownLabels = idMappingDisplayXpath(
		field,
		tokenOptions.map(({ option, originalIndex }) => ({
			value: option.value,
			label: printProseTemplate(option.label, doc),
			labelExpression: labelExpression?.(option, originalIndex),
		})),
	);
	// Double-space the normalized value so every token owns BOTH of its
	// flanking spaces. Java regex matching is non-overlapping: with
	// single-space delimiters, removing ` tok ` consumes the shared space
	// between adjacent identical tokens, so the second copy of a duplicated
	// known token survives as a bogus "unknown" (` north north ` → `north`).
	// With dedicated flanks (`  north  north  `), every copy matches its own
	// ` tok ` window and the remainder holds only genuinely unknown tokens —
	// duplicates of those included, matching Preview's projection. The final
	// `normalize-space` collapses the leftover padding.
	let unknownTokens = w.call("concat", [
		w.str("  "),
		w.call("replace", [normalizeSpace(field), w.str(" "), w.str("  ")]),
		w.str("  "),
	]);
	for (const { option } of tokenOptions) {
		const pattern = w.str(` ${escapeRegex(option.value)} `);
		unknownTokens = w.call("replace", [unknownTokens, pattern, w.str(" ")]);
	}
	return normalizeSpace(
		w.call("concat", [knownLabels, w.str(" "), unknownTokens]),
	);
}

/**
 * Date-formatted column display XPath. Per CCHQ's
 * `detail_screen.py::Date` format:
 *
 *     if({xpath} = '', '', format-date(date({xpath}), '{date_format}'))
 *
 * The empty-string short-circuit suppresses formatter errors on
 * absent values (CCHQ's `format-date` rejects `date('')`). The
 * pattern remains a string literal; the serializer chooses its quotes or
 * concat fallback without treating authored text as an expression.
 */
function dateDisplayXpath(field: WireExpr, pattern: string): WireExpr {
	return w.call("if", [
		w.eq(field, w.str("")),
		w.str(""),
		w.call("format-date", [w.call("date", [field]), w.str(pattern)]),
	]);
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
 * The serializer quotes `text` as a string literal.
 */
function intervalAlwaysXpath(args: {
	readonly field: WireExpr;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly text: string;
	readonly textExpression?: WireExpr;
}): WireExpr {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const label = args.textExpression ?? w.str(args.text);
	const elapsed = w.sub(w.call("today", []), w.call("date", [args.field]));
	const interval = w.call("string", [
		w.call("int", [w.div(elapsed, w.num(divisor))]),
	]);
	const overdue = w.call("if", [
		w.gt(elapsed, w.num(thresholdDays)),
		label,
		interval,
	]);
	return w.call("if", [w.eq(args.field, w.str("")), w.str(""), overdue]);
}

/**
 * `display: "flag"` interval-column XPath. Mirrors CCHQ's
 * `detail_screen.py::LateFlag.XPATH_FUNCTION`:
 *
 *     if({xpath} = '', '<text>', if(today() - date({xpath}) > <thresholdDays>, '<text>', ''))
 *
 * CCHQ hardcodes the flag string to `'*'`; Nova substitutes the
 * author's `text` as a string literal. The CCHQ shape surfaces the
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
	readonly field: WireExpr;
	readonly threshold: number;
	readonly unit: keyof typeof TIME_AGO_DIVISOR_DAYS;
	readonly text: string;
	readonly textExpression?: WireExpr;
}): WireExpr {
	const divisor = TIME_AGO_DIVISOR_DAYS[args.unit];
	const thresholdDays = args.threshold * divisor;
	const flag = args.textExpression ?? w.str(args.text);
	const elapsed = w.sub(w.call("today", []), w.call("date", [args.field]));
	return w.call("if", [
		w.eq(args.field, w.str("")),
		flag,
		w.call("if", [w.gt(elapsed, w.num(thresholdDays)), flag, w.str("")]),
	]);
}

/**
 * Complete display expression for an authored link column, shared with the
 * HQ JSON twin so an imported app and a downloaded `.ccz` render the same
 * cell.
 *
 * `[label](address)` is the ONLY spelling that produces a link. A bare URL is
 * not autolinked: Web Apps builds its renderer as `markdowner({breaks: true})`
 * (`cloudcare/static/cloudcare/js/markdown.js::initMd`), leaving markdown-it's
 * `linkify` at its `false` default, and DOMPurify sanitizes the SOURCE before
 * rendering, which strips an `<url>` autolink too.
 *
 * The blank guard is not decoration: without it a row whose property is empty
 * renders `[label]()`, a link to nowhere that looks exactly like a working
 * one. Empty in, empty cell.
 *
 * The label is inlined rather than carried as a locale variable; see
 * `linkColumnSchema` in `lib/domain/modules.ts` for why the wire leaves no
 * room for a translated one.
 */
export function linkColumnDisplayXpath(
	field: WireExpr,
	linkText: string,
): WireExpr {
	return w.call("if", [
		w.eq(field, w.str("")),
		w.str(""),
		w.call("concat", [w.str(`[${linkText}](`), field, w.str(")")]),
	]);
}

/**
 * Complete display expression for an authored interval column. HQ JSON uses
 * this same expression through its calculated-column arm; projecting to
 * CCHQ's stock `time-ago` / `late-flag` formats would discard Nova's authored
 * threshold text (and hard-code `*` for flags).
 */
export function intervalColumnDisplayXpath(
	column: Extract<Column, { kind: "interval" }>,
	textExpression?: WireExpr,
): WireExpr {
	const field = casePropertyPath(column.field);
	return column.display === "always"
		? intervalAlwaysXpath({
				field,
				threshold: column.threshold,
				unit: column.unit,
				text: column.text,
				textExpression,
			})
		: intervalFlagXpath({
				field,
				threshold: column.threshold,
				unit: column.unit,
				text: column.text,
				textExpression,
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
function phoneDisplayXpath(field: WireExpr): WireExpr {
	return field;
}

/**
 * ID-mapping column display XPath. Mirrors CCHQ's
 * `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::XPathEnum.build`
 * shape. Callers may supply locale-variable expressions for translated
 * labels; a missing expression falls back to an XPath string literal.
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
 * Each value and label is a string literal quoted by the serializer.
 * An empty mapping array short-circuits
 * to an empty-string XPath (`''`) — the runtime renders nothing,
 * matching CCHQ's behavior on a zero-entry enum.
 */
export function idMappingDisplayXpath(
	field: WireExpr,
	mapping: ReadonlyArray<{
		readonly value: string;
		readonly label: string;
		readonly labelExpression?: WireExpr;
	}>,
): WireExpr {
	if (mapping.length === 0) return w.str("");
	const arms = mapping.map((entry) => {
		const label = entry.labelExpression ?? w.str(entry.label);
		return w.call("if", [
			w.call("selected", [field, w.str(entry.value)]),
			label,
			w.str(""),
		]);
	});
	return w.call("replace", [
		w.call("join", [w.str(" "), ...arms]),
		w.str("\\s+"),
		w.str(" "),
	]);
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
 * A map with entries resolves its paths through the asset manifest; a map
 * with no entries names no image and is `''` with or without one
 * (`lib/domain/modules.ts::imageMapShowsImages`). Reaching an entry with no
 * manifest, or a missing manifest entry, is a compiler bug.
 */
function imageMapDisplayXpath(
	field: WireExpr,
	mapping: ReadonlyArray<{
		readonly value: string;
		readonly assetId: MediaAssetId;
	}>,
	assets: AssetManifest | undefined,
): WireExpr {
	// Fold right so the first entry is the outermost `if`, matching the
	// runtime's first-match-wins walk: the empty-string base is the final
	// else (no value matched => no image).
	return mapping.reduceRight<WireExpr>((elseArm, entry) => {
		if (assets === undefined) {
			throw new Error(
				"imageMapDisplayXpath: an image map with entries was written as images with no media manifest. `imageMapShowsImages` holds a map with entries to its image column only where the export carries one.",
			);
		}
		const path = w.str(
			requireAssetRef(entry.assetId, assets, "imageMapDisplayXpath"),
		);
		return w.call("if", [
			w.call("selected", [field, w.str(entry.value)]),
			path,
			elseArm,
		]);
	}, w.str(""));
}

/**
 * The HQ JSON key of one image-map entry, `selected(., <value>)`: HQ's
 * `EnumImage` reads a key holding punctuation as an expression and
 * interpolates `.` to the column's property, so this keeps Nova's token
 * matching with the authored value quoted as data. The HQ JSON column's
 * `enum` and the local suite's alt-text variable names both read it, so
 * the two paths name each key alike.
 */
export function imageMapEnumExpression(value: string): WireExpr {
	return w.call("selected", [w.context([w.self()]), w.str(value)]);
}

export function imageMapEnumKey(value: string): string {
	return serializeWire(imageMapEnumExpression(value), {
		target: "hq-json",
		interpolation: "enum-key",
	}).text;
}

/**
 * The `<alt_text>` HQ's build gives an image-map field at CommCare 2.54 or
 * later (`detail_screen.py::EnumImage.alt_text`, `feature_support.py::
 * supports_alt_text`), as the field's last child (`xml_models.py::Field.ORDER`).
 *
 * An enum over the same keys as the field's template, in its XPath shape:
 * `if(selected(<field>, <value>), $<variable>, <the next key's branch>)`
 * with `''` last. Each variable is named as HQ names it over the HQ JSON's
 * key, `imageMapEnumKey` (named by `keyVariable.ts`), and reads the locale id
 * `id_strings.py::detail_column_alt_text_variable` gives for that column and
 * key, whose string is blank in every language: Nova sets no alt text, and
 * HQ's `clean_trans` of an empty label is blank too. Absent for every other
 * kind, for an image map that is not written as images
 * (`imageMapShowsImages`), which both paths emit as a plain column, and for
 * a field hidden from Results, which HQ's build writes as `invisible`.
 */
function imageMapAltText(
	column: Exclude<Column, { kind: "calculated" }>,
	position: number,
	ctx: CaseListEmitContext,
):
	| { readonly element: Element; readonly strings: Record<string, string> }
	| undefined {
	if (
		column.kind !== "image-map" ||
		!imageMapShowsImages(column, ctx.assets !== undefined)
	) {
		return undefined;
	}
	const field = casePropertyPath(column.field);
	const idBase = detailColumnLocaleBase(
		ctx.target,
		ctx.detailKind,
		ctx.moduleIndex,
		column.field,
		position,
	);
	const keys = column.mapping.map((entry) => {
		const name = keyAsVariable(imageMapEnumKey(entry.value));
		return {
			condition: w.call("selected", [field, w.str(entry.value)]),
			variable: w.imageAltVar(entry.value),
			name,
			localeId: `${idBase}.alt_text.${name}`,
		};
	});
	const xpath = keys.reduceRight<WireExpr>(
		(elseArm, key) => w.call("if", [key.condition, key.variable, elseArm]),
		w.str(""),
	);
	return {
		element: el("alt_text", {}, [
			el("text", {}, [
				xel(
					"xpath",
					{ xpath: { function: xpath } },
					ctx.wire,
					keys.map((key) =>
						el("variable", { name: key.name }, [
							el("locale", { id: key.localeId }),
						]),
					),
				),
			]),
		]),
		strings: Object.fromEntries(keys.map((key) => [key.localeId, ""])),
	};
}

// ============================================================
// Per-Column dispatcher
// ============================================================

/**
 * Resolve the display XPath for a property-rooted column. Calc
 * columns ride the inline-variable template path and don't route
 * through this helper.
 */
function propertyDisplayProjection(
	column: Exclude<Column, { kind: "calculated" }>,
	ctx: CaseListEmitContext,
	position: number,
): LocalizedDisplayProjection {
	const field = casePropertyPath(column.field);
	const plain = (xpath: WireExpr): LocalizedDisplayProjection => ({
		xpath,
		variables: [],
		strings: {},
		translationUnits: {},
	});
	const valueLocaleId = (index: number): string =>
		`${detailColumnLocaleBase(
			ctx.target,
			ctx.detailKind,
			ctx.moduleIndex,
			column.field,
			position,
		)}.enum.knova_text_${index}`;
	const variable = (
		index: number,
		source: string,
		unitId: TranslationUnitId,
	): LocalizedDisplayProjection =>
		localizedVariable(index, valueLocaleId(index), source, unitId);
	const combineVariables = (
		projections: readonly LocalizedDisplayProjection[],
		xpath: WireExpr,
	): LocalizedDisplayProjection => ({
		xpath,
		variables: projections.flatMap((projection) => projection.variables),
		strings: Object.assign(
			{},
			...projections.map((projection) => projection.strings),
		),
		translationUnits: Object.assign(
			{},
			...projections.map((projection) => projection.translationUnits),
		),
	});
	switch (column.kind) {
		case "plain": {
			const property = ctx.caseProperties.find(
				(candidate) => candidate.name === column.field,
			);
			if (
				property?.data_type !== "single_select" &&
				property?.data_type !== "multi_select"
			) {
				return plain(plainDisplayXpath(field));
			}
			const options = property.options ?? [];
			const projections = options.map((option, index) =>
				variable(
					index,
					printProseTemplate(option.label, ctx.proseDoc),
					casePropertyOptionTranslationUnitId(
						ctx.caseType,
						property.name,
						option.value,
						casePropertyOptionOccurrence(options, index),
					),
				),
			);
			return combineVariables(
				projections,
				plainSelectDisplayXpath(
					field,
					property,
					ctx.proseDoc,
					(_option, index) => projections[index]?.xpath ?? w.str(""),
				),
			);
		}
		case "date":
			return plain(dateDisplayXpath(field, column.pattern));
		case "phone":
			return plain(phoneDisplayXpath(field));
		case "id-mapping": {
			const projections = column.mapping.map((entry, index) =>
				variable(
					index,
					entry.label,
					makeTranslationUnitId("column", column.uuid, "mapping", entry.value),
				),
			);
			return combineVariables(
				projections,
				idMappingDisplayXpath(
					field,
					column.mapping.map((entry, index) => ({
						...entry,
						labelExpression: projections[index]?.xpath,
					})),
				),
			);
		}
		case "image-map":
			// Written as images (`imageMapShowsImages`) → the per-value
			// image-path chain, rendered via `<template form="image">`.
			// Otherwise the raw property value as a plain column;
			// `templateFormFor` reads the same predicate so the two never
			// disagree.
			return plain(
				imageMapShowsImages(column, ctx.assets !== undefined)
					? imageMapDisplayXpath(field, column.mapping, ctx.assets)
					: plainDisplayXpath(field),
			);
		case "link":
			return plain(linkColumnDisplayXpath(field, column.linkText));
		case "interval": {
			const projection = variable(
				0,
				column.text,
				makeTranslationUnitId("column", column.uuid, "text"),
			);
			return combineVariables(
				[projection],
				intervalColumnDisplayXpath(column, projection.xpath),
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
 * Three kinds surface a non-`undefined` value:
 *
 *   - `phone` on long detail → `'phone'` per
 *     `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`.
 *   - `image-map` written as images (`imageMapShowsImages`) → `'image'`
 *     per `commcare-hq/.../detail_screen.py::EnumImage.template_form`, so
 *     the runtime renders the display XPath's resolved jr:// path as an
 *     image. Otherwise `undefined` (a plain template over the raw value),
 *     matching `propertyDisplayProjection` — the form attribute and the
 *     display XPath must never disagree.
 *   - `link` on every surface → `'markdown'`, the ONLY thing that makes a
 *     case-list cell render as a link. `case_list/item.html` renders an
 *     ordinary cell as `<%- datum %>`, escaped text; only a `Markdown` cell
 *     reaches `renderMarkdown`. `markdown` is a declared member of the
 *     emitted `@form` vocabulary
 *     (`suite_xml/xml_models.py::AbstractTemplate.form`,
 *     `detail_screen.py::Markdown.template_form`,
 *     `commcare-core/.../suite/model/Style.java::setDisplayFormatFromString`),
 *     and it is ungated in HQ's own format menu. CommCare Android parses it
 *     and then ignores it: `EntityView` branches on `image`, `audio`,
 *     `graph`, `address`, and `callout` only, and `Style.getDisplayFormat()`
 *     has no caller anywhere in commcare-core or commcare-android, so an
 *     Android cell shows the raw `[label](address)` text. That is stated
 *     where the author picks the kind rather than worked around here.
 */
function templateFormFor(
	column: Exclude<Column, { kind: "calculated" }>,
	detailKind: DetailKind,
	assets: AssetManifest | undefined,
): string | undefined {
	if (column.kind === "phone" && detailKind === "long") return "phone";
	if (
		column.kind === "image-map" &&
		imageMapShowsImages(column, assets !== undefined)
	) {
		return "image";
	}
	if (column.kind === "link") return "markdown";
	return undefined;
}

/**
 * The `<sort>` of a short-detail field that keeps a sort key, or nothing.
 * Long detail carries no `<sort>`: HQ's
 * `detail_screen.py::FormattedDetailColumn.sort_node` short-circuits when
 * `self.detail.display != 'short'`, and the canonical fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
 * carries none.
 *
 * The directive (`sortKeys.ts::planSortNodes`) says what the sort reads; the
 * text comes from the field itself, so a calculation sorts by the same
 * expression its template evaluates, against the same case source, and a
 * label or interval sorts by its display text with variables of its own.
 */
function resolveSortElement(
	column: Column,
	ctx: CaseListEmitContext,
	fieldText: () => {
		readonly xpath: WireExpr;
		readonly variables: readonly Element[];
	},
): Element | undefined {
	if (ctx.detailKind === "long") return undefined;
	const directive = ctx.sortByUuid.get(column.uuid);
	if (directive === undefined) return undefined;
	return buildSortBlock(
		directive,
		sortText(directive, fieldText, ctx.wire),
		ctx.wire,
	);
}

function sortText(
	directive: ResolvedSortDirective,
	fieldText: () => {
		readonly xpath: WireExpr;
		readonly variables: readonly Element[];
	},
	context: WireElementContext,
): { readonly xpath: WireExpr; readonly variables: readonly Element[] } {
	switch (directive.kind) {
		case "property":
			return { xpath: directive.xpath, variables: [] };
		case "calculated":
			return calculatedPropertyText(fieldText().xpath, context);
		case "variables":
			return fieldText();
	}
}

/**
 * The `<style>` child a placed cell contributes, or nothing.
 *
 * Three conditions gate it, and each is load-bearing:
 *
 *   - the column carries a cell — an unplaced column has nothing to
 *     describe, and a `<style>` with no complete `<grid>` is an
 *     install-time parse failure (see `tileStyle.ts`);
 *   - the case list has a tile layout — cells persist while the layout
 *     is off so switching back restores the drawing, but they describe
 *     nothing the wire renders until it is on;
 *   - the detail is the SHORT one. Tiles apply to the case list, the
 *     search-results list, and the persistent tile, all of which the
 *     short detail drives; the case-detail screen stays a plain field
 *     list.
 */
function tileStyleChildren(
	column: Column,
	ctx: CaseListEmitContext,
): readonly Element[] {
	// Which detail surface this is stays here — tiles apply to the short
	// detail, and the case-detail screen is a plain field list whatever the
	// case list does. WHETHER the column contributes a cell at all is
	// `tileCellFor`'s single decision, shared with the HQ JSON writer and the
	// preview renderer so the three cannot disagree.
	//
	// Long-detail tiles are out of scope by contract — see
	// `docs/architecture/contracts.md`, deliberate target gaps:
	// "Tiles apply to the short and search details; the case-detail view emits
	// a plain field list." CommCare would accept a `custom` tile there, so
	// nothing upstream forbids it; this branch is what makes the excluded case
	// unrepresentable rather than merely unreached. `longDetail.ts` also never
	// puts a `tileLayout` on its context, but that is the same rule applied a
	// second time, not the reason for this one.
	if (ctx.detailKind !== "short") return [];
	const cell = tileCellFor(column, ctx.tileLayout);
	if (cell === undefined) return [];
	return [buildTileStyleBlock(cell)];
}

/**
 * Build one `<field>` Element for a column. The `position` is 1-based
 * — the surrounding orchestrator passes the column's position in the
 * complete Results or Details sequence plus 1 so the locale-id suffix
 * matches CCHQ's `detail_column_header_locale` convention.
 *
 * The dispatch routes calculated columns through the inline-variable
 * template path (CCHQ's `useXpathExpression` branch); every other kind
 * goes through the standard `<header>` / `<template>` pair. May carry a
 * `<template>` `form` attribute (long-detail phone columns, image maps,
 * links) and, on the short detail, the `<sort>` of a field that keeps a
 * sort key.
 *
 * A field hidden from Results (`hidden`) is HQ's `invisible` column, byte
 * for byte: an empty header with no locale id at width 0, and a template at
 * width 0 over the raw wire path, never a label expression or variables; a
 * calculated one keeps its calculation. It contributes no app string and no
 * translation unit.
 */
export function buildColumnField(args: {
	readonly column: Column;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
	/** The field is hidden from Results: HQ's `invisible` column. */
	readonly hidden?: boolean;
}): CaseListFieldEmission {
	const { column, position, ctx, hidden = false } = args;

	if (column.kind === "calculated") {
		return buildCalculatedField({ column, position, ctx, hidden });
	}

	if (hidden) {
		const raw = casePropertyPath(column.field);
		const fieldChildren: Element[] = [
			buildHiddenHeaderBlock(),
			buildTemplateBlock(raw, ctx.wire, undefined, "0"),
		];
		const sortEl = resolveSortElement(column, ctx, () => ({
			xpath: raw,
			variables: [],
		}));
		if (sortEl !== undefined) fieldChildren.push(sortEl);
		return {
			element: el("field", {}, fieldChildren),
			strings: {},
			translationUnits: {},
		};
	}

	const display = propertyDisplayProjection(column, ctx, position);
	const headerLocaleId = detailHeaderLocaleId(
		ctx.target,
		ctx.detailKind,
		ctx.moduleIndex,
		column.field,
		position,
	);
	const width =
		column.kind === "image-map" &&
		imageMapShowsImages(column, ctx.assets !== undefined)
			? IMAGE_MAP_WIDTH
			: undefined;
	const fieldChildren: Element[] = [
		...tileStyleChildren(column, ctx),
		buildHeaderBlock(headerLocaleId, width),
		buildTemplateBlock(
			display.xpath,
			ctx.wire,
			templateFormFor(column, ctx.detailKind, ctx.assets),
			width,
			display.variables,
		),
	];
	const sortEl = resolveSortElement(column, ctx, () => {
		// A fresh projection: the sort's variables are elements of their own,
		// never the template's.
		const again = propertyDisplayProjection(column, ctx, position);
		return { xpath: again.xpath, variables: again.variables };
	});
	if (sortEl !== undefined) fieldChildren.push(sortEl);
	const altText = imageMapAltText(column, position, ctx);
	if (altText !== undefined) fieldChildren.push(altText.element);

	return {
		element: el("field", {}, fieldChildren),
		strings: {
			[headerLocaleId]: column.header,
			...display.strings,
			...altText?.strings,
		},
		translationUnits: {
			[headerLocaleId]: makeTranslationUnitId("column", column.uuid, "header"),
			...display.translationUnits,
		},
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
 * `calculated_property` for the property name). A calculated field hidden
 * from Results keeps its calculation at width 0 under the empty header of
 * every hidden field, with no string.
 */
function buildCalculatedField(args: {
	readonly column: Extract<Column, { kind: "calculated" }>;
	readonly position: number;
	readonly ctx: CaseListEmitContext;
	readonly hidden?: boolean;
}): CaseListFieldEmission {
	const { column, position, ctx, hidden = false } = args;
	// `toWire` lowers the AST against the surrounding
	// detail's storage-instance root — `instance('casedb')` for the
	// case-target detail (default), `instance('results')` for the
	// search-target detail. Property-rooted refs (no `via` walk) emit
	// bare property names with no prefix, so the parameter is a no-op
	// for them; cross-case `count(...)` calls and `via`-walked property
	// refs both thread the root through to the relation-walk anchor
	// builders in `lib/commcare/xpath/wire/fromExpression.ts`.
	const calcXpath = toWire(column.expression, {
		target: "suite",
		root: instanceRootFor(ctx),
		types: ctx.expressions({
			slot: "case_list_column_expression",
			member: { columnUuid: column.uuid },
		}),
		bindings: lookupTermContext(ctx),
	});
	const sortEl = resolveSortElement(column, ctx, () => ({
		xpath: calcXpath,
		variables: [],
	}));
	if (hidden) {
		const fieldChildren: Element[] = [
			buildHiddenHeaderBlock(),
			buildCalculatedTemplateBlock(calcXpath, ctx.wire, "0"),
		];
		if (sortEl !== undefined) fieldChildren.push(sortEl);
		return {
			element: el("field", {}, fieldChildren),
			strings: {},
			translationUnits: {},
		};
	}
	const headerLocaleId = detailCalculatedHeaderLocaleId(
		ctx.target,
		ctx.detailKind,
		ctx.moduleIndex,
		position,
	);
	const fieldChildren: Element[] = [
		...tileStyleChildren(column, ctx),
		buildHeaderBlock(headerLocaleId),
		buildCalculatedTemplateBlock(calcXpath, ctx.wire),
	];
	if (sortEl !== undefined) fieldChildren.push(sortEl);

	return {
		element: el("field", {}, fieldChildren),
		strings: { [headerLocaleId]: column.header },
		translationUnits: {
			[headerLocaleId]: makeTranslationUnitId("column", column.uuid, "header"),
		},
	};
}

/**
 * The field CommCare HQ's build appends for a sort row no stored column
 * takes (`util.py::create_temp_sort_column`, an `invisible` column with an
 * empty display): an empty header at width 0, a width 0 template over the
 * raw wire path, and the rule's `<sort>`. It is never stored and carries no
 * tile cell, and the list's search matches its raw value.
 */
export function buildCarrierField(
	property: string,
	directive: ResolvedSortDirective,
	context: WireElementContext,
): Element {
	const raw = casePropertyPath(property);
	return el("field", {}, [
		buildHiddenHeaderBlock(),
		buildTemplateBlock(raw, context, undefined, "0"),
		buildSortBlock(
			directive,
			sortText(directive, () => ({ xpath: raw, variables: [] }), context),
			context,
		),
	]);
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
	const { element, strings, translationUnits } = buildColumnField(args);
	return {
		xml: serializeXml(element),
		strings,
		translationUnits,
		instances: args.ctx.wire.instances.declarations(),
	};
}
