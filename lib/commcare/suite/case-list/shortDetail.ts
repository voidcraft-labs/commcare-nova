// lib/commcare/suite/case-list/shortDetail.ts
//
// Suite-XML emission for the case-list short detail —
// `<detail id="m{n}_case_short">`. Walks `module.caseListConfig`
// in three passes and concatenates one `<field>` per Column /
// CalculatedColumn into the surrounding `<detail>` shell.
//
// The `<detail>` shell carries:
//
//   - `id="m{moduleIndex}_case_short"` — the canonical short-
//     detail identifier CCHQ binds entries against (see
//     `commcare-hq/corehq/apps/app_manager/id_strings.py:111-118`'s
//     `detail_short_locale`; the surrounding entry's
//     `detail-select="m0_case_short"` attribute references this
//     id).
//   - `<title>` referencing `<locale id="cchq.case"/>` — CCHQ's
//     built-in case-detail title locale, registered with
//     `default="Case"` at
//     `commcare-hq/corehq/apps/app_manager/id_strings.py:78-80`.
//     No app-strings entry needed; the runtime resolves the
//     fallback.
//   - One `<field>` per displayed `Column`, in
//     `caseListConfig.columns` order.
//   - One `<field>` per `CalculatedColumn`, in
//     `caseListConfig.calculatedColumns` order, AFTER the regular
//     columns. CCHQ's wire convention places calc fields at the
//     end of the field list; the canonical fixture pair at
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml:160-170`
//     (regular columns followed by `case_indicator` calcs)
//     pins the order.
//
// Search-only columns route through their own emit path that
// produces a `width="0"` `<field>` body — the column stays
// declared at the detail layer so search-input emission can
// bind against it, but the runtime hides it from the visible
// case list.
//
// The emitter does NOT register the `<title>` text into
// app_strings — `cchq.case` is CCHQ's built-in locale with a
// runtime fallback. Authors who want to override the title
// register `cchq.case` themselves at the app-strings layer
// (Nova has no such authoring surface today; the runtime
// fallback is the rendered title).
//
// Calculated columns share the regular columns' `<sort>` lookup
// path through `findSortKey` — a sort key whose
// `source.kind === "calculated"` targets the calc by id and
// the wire layer routes the matching key into the calc's
// inline-variable sort block.

import type { Module } from "@/lib/domain";
import { emitCalculatedColumnField, emitColumnField } from "./columns";
import type { CaseListEmission, CaseListEmitContext } from "./types";

/**
 * Compose the suite-XML `<detail>` block for one module's case-
 * list short detail. Returns the concatenated XML plus the
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
export function emitShortDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
}): CaseListEmission {
	const { module: mod, moduleIndex } = args;
	const detailId = `m${moduleIndex}_case_short`;

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title (CCHQ requires one
	// per `<detail>` block — Detail's `<title>` is non-optional in
	// the suite XSD per `xml_models.py:935-958`).
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
	};

	const fields: string[] = [];
	const strings: Record<string, string> = {};

	// Pass 1 — regular columns. Position is 1-based, consumed by
	// the per-column header-locale composer.
	for (let i = 0; i < config.columns.length; i++) {
		const emission = emitColumnField({
			column: config.columns[i],
			position: i + 1,
			ctx,
		});
		fields.push(emission.xml);
		Object.assign(strings, emission.strings);
	}

	// Pass 2 — calculated columns. Position resets at 1 per the
	// CCHQ canonical convention (the `case_calculated_property_<i>`
	// suffix counts within the calculated subset, not across the
	// full field list — `id_strings.py:88-103`'s
	// `detail_column_header_locale` calls `column.id + 1` against
	// the column's per-detail position, but CCHQ's authoring
	// model treats calc columns as their own ordering).
	for (let i = 0; i < config.calculatedColumns.length; i++) {
		const emission = emitCalculatedColumnField({
			calculated: config.calculatedColumns[i],
			position: i + 1,
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
 * The two-line indent style mirrors the existing compiler.ts
 * `generateDetail` layout so the swap-in lands a structurally
 * familiar block at the suite-XML level. Indentation in the
 * resulting suite.xml follows the parent-compiler convention:
 * `<detail>` and its children indent by two spaces from the
 * `<suite>` root; nested `<field>` content adds two more.
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
