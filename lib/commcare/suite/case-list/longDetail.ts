// lib/commcare/suite/case-list/longDetail.ts
//
// Suite-XML emission for the case-list long detail —
// `<detail id="m{n}_case_long">`. Walks `module.caseListConfig`
// in two passes (regular source-list columns, then calculated
// columns) and concatenates one `<field>` per displayed column
// into the surrounding `<detail>` shell.
//
// Source list resolution: the long detail's columns come from
// `caseListConfig.detailColumns` if present, falling back to
// `caseListConfig.columns` otherwise. The schema declares
// `detailColumns` as the optional long-detail override —
// authoring "no separate long detail" mirrors the short
// detail's column list. Calculated columns share a single
// authoring slot (`caseListConfig.calculatedColumns`); both
// surfaces render the same calc list.
//
// Per-column wire shape lives in `columns.ts`. Long-detail
// divergences flow through the `CaseListEmitContext.detailKind`
// discriminator:
//
//   - Locale ids carry the `case_long` substring per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
//     helper.
//   - `<sort>` blocks are suppressed on the non-nodeset long
//     detail per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
//     short-circuit. The canonical fixture
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
//     confirms zero `<sort>` blocks despite a multi-key sort
//     active on the parent module's short detail.
//   - `phone` columns emit `<template form="phone">` per
//     `detail_screen.py::Phone.template_form` — verified at
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
//     phone field.
//   - `search-only` columns produce no `<field>` (Nova's
//     authoring vocabulary defines them as a search/filter
//     target with no display affordance; the case-detail screen
//     has no search/filter affordance). The 1-based position
//     counter still advances for the skipped slot, matching
//     CCHQ's `column.id` convention which keys off the source
//     array's index regardless of which surfaces actually emit
//     a field.
//
// The emitter does NOT register the `<title>` text into
// app_strings — `cchq.case` is CCHQ's built-in locale with a
// runtime fallback (registered with `default="Case"` at
// `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`).
// Same pattern as the short-detail emitter so both `<detail>`
// blocks display a consistent runtime title without app-strings
// entries.

import type { Module } from "@/lib/domain";
import { emitCalculatedColumnField, emitColumnField } from "./columns";
import type { CaseListEmission, CaseListEmitContext } from "./types";

/**
 * Compose the suite-XML `<detail>` block for one module's case-
 * list long detail. Returns the concatenated XML plus the
 * locale-id → header-string map the surrounding compiler
 * threads into `app_strings.txt`.
 *
 * When `module.caseListConfig` is absent OR the module has no
 * case type, the emitter returns a minimal title-only
 * `<detail>` block. The validator's `columnReferences` rule
 * (and its sibling rules) gate non-empty configs against
 * presence of `mod.caseType`, so a populated config without a
 * case type would fail validation upstream — the absence-arm
 * here is the structural fallback.
 */
export function emitLongDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
}): CaseListEmission {
	const { module: mod, moduleIndex } = args;
	const detailId = `m${moduleIndex}_case_long`;

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title — CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Detail`
	// model declares `title` as a non-optional `NodeField`, so a
	// zero-field detail still emits the `<title>` element.
	if (!mod.caseType || !mod.caseListConfig) {
		return {
			xml: emitDetailShell(detailId, []),
			strings: {},
		};
	}

	const config = mod.caseListConfig;
	const ctx: CaseListEmitContext = {
		moduleIndex,
		sort: config.sort,
		detailKind: "long",
	};

	// Source list resolution per the schema's authoring contract:
	// `detailColumns` is the optional long-detail override. When
	// present, it replaces the short-detail's column list. When
	// absent, the long detail mirrors the short detail. Falling
	// back to `columns` keeps the case-detail screen populated by
	// default; authors who want a different long-detail layout
	// supply `detailColumns`.
	const sourceColumns = config.detailColumns ?? config.columns;

	const fields: string[] = [];
	const strings: Record<string, string> = {};

	// Pass 1 — regular columns. Position is 1-based, consumed by
	// the per-column header-locale composer. The 1-based counter
	// advances for every source-array slot, including skipped
	// search-only-on-long entries — `emitColumnField` returns
	// `undefined` for those, the orchestrator skips the
	// concatenation, and the next column's position is `i + 2`
	// rather than `previous + 1`. The convention matches CCHQ's
	// `id_strings.py::detail_column_header_locale` whose
	// `column.id + 1` reads the source-array index (config-time)
	// rather than a render-time visible-column counter.
	for (let i = 0; i < sourceColumns.length; i++) {
		const emission = emitColumnField({
			column: sourceColumns[i],
			position: i + 1,
			ctx,
		});
		if (emission === undefined) continue;
		fields.push(emission.xml);
		Object.assign(strings, emission.strings);
	}

	// Pass 2 — calculated columns. Position continues the global
	// 1-based count from the regular-column pass, including
	// skipped slots: a calc at index 0 receives
	// `position = sourceColumns.length + 1`. CCHQ's
	// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`
	// computes the suffix as `column.id + 1` where `column.id`
	// is the global per-detail position across regular AND calc
	// columns; the canonical fixture
	// `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml`
	// renders three calc fields under `<detail id="m0_case_long">`
	// at locale ids `case_calculated_property_10/11/12.header`,
	// continuing the count after the (regular-and-skipped) source
	// columns.
	const regularCount = sourceColumns.length;
	for (let i = 0; i < config.calculatedColumns.length; i++) {
		const emission = emitCalculatedColumnField({
			calculated: config.calculatedColumns[i],
			position: regularCount + i + 1,
			ctx,
		});
		fields.push(emission.xml);
		Object.assign(strings, emission.strings);
	}

	return {
		xml: emitDetailShell(detailId, fields),
		strings,
	};
}

/**
 * Build the surrounding `<detail>` element. The title routes
 * through the built-in `cchq.case` locale; field lines slot in
 * between the title and the closing tag.
 *
 * The two-line indent style mirrors the surrounding compiler's
 * suite-XML layout — `<detail>` and its children indent by two
 * spaces from the `<suite>` root; nested `<field>` content adds
 * two more.
 */
function emitDetailShell(detailId: string, fields: readonly string[]): string {
	const titleBlock = [
		`    <title>`,
		`      <text>`,
		`        <locale id="cchq.case"/>`,
		`      </text>`,
		`    </title>`,
	].join("\n");

	if (fields.length === 0) {
		return `  <detail id="${detailId}">\n${titleBlock}\n  </detail>`;
	}

	return [
		`  <detail id="${detailId}">`,
		titleBlock,
		fields.join("\n"),
		`  </detail>`,
	].join("\n");
}
