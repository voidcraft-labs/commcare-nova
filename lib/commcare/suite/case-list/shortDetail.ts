// lib/commcare/suite/case-list/shortDetail.ts
//
// Suite-XML emission for the case-list short detail —
// `<detail id="m{n}_case_short">`. Walks
// `module.caseListConfig.columns`, filters by `column.visibleInList`
// (absent ≡ visible), and concatenates one `<field>` per surviving
// column into the surrounding `<detail>` shell.
//
// The `<detail>` shell carries:
//
//   - `id="m{moduleIndex}_case_short"` — the canonical short-detail
//     identifier CCHQ binds entries against. CCHQ's
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
//     helper returns the same `m{module.id}_{detail_type}` shape;
//     the surrounding entry's `detail-select="m0_case_short"`
//     attribute references this id.
//
//   - `<title>` referencing `<locale id="cchq.case"/>` — CCHQ's
//     built-in case-detail title locale, registered with
//     `default="Case"` at
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`.
//     No app-strings entry needed; the runtime resolves the
//     fallback.
//
//   - One `<field>` per column where `visibleInList ?? true`, in
//     `caseListConfig.columns` order.
//
// Per-column sort directives are resolved once by
// `sortKeys.ts::buildSortDirectives(mod, doc)` and threaded through
// the per-column emitter via `CaseListEmitContext.sortByUuid`. The
// per-column emitter looks up its directive by `column.uuid` and
// emits the matching `<sort>` block on short detail.
//
// Position counter convention: the 1-based position passed to the
// per-column header-locale composer is the column's source-array
// index plus one. The visibility filter affects which fields render,
// not their position numbers — toggling `visibleInList` doesn't
// churn locale ids. Mirrors CCHQ's
// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`'s
// `column.id`-keyed numbering convention.
//
// The emitter does NOT register the `<title>` text into app_strings
// — `cchq.case` is CCHQ's built-in locale with a runtime fallback.
// Authors who want to override the title register `cchq.case`
// themselves at the app-strings layer (Nova has no such authoring
// surface today; the runtime fallback is the rendered title).

import type { BlueprintDoc, Module } from "@/lib/domain";
import { emitColumnField } from "./columns";
import { buildSortDirectives } from "./sortKeys";
import type { CaseListEmission, CaseListEmitContext } from "./types";

/**
 * Compose the suite-XML `<detail>` block for one module's case-list
 * short detail. Returns the concatenated XML plus the locale-id →
 * header-string map the surrounding compiler threads into
 * `app_strings.txt`.
 *
 * `doc` is the source `BlueprintDoc`. The emitter consults it for
 * two reasons: (1) `buildSortDirectives` walks the doc's case-type
 * declarations to resolve the comparator type for property-rooted
 * sort directives, (2) `buildSortDirectives` runs the predicate AST
 * type checker against the same admission set as the validator
 * (declared properties + writer-derived + standard) for calculated-
 * column sort directives. Tests that don't exercise sort behavior
 * pass an empty doc.
 *
 * When `module.caseListConfig` is absent OR the module has no case
 * type, the emitter returns a minimal title-only `<detail>` block.
 * The validator's `columnReferences` rule (and its sibling rules)
 * gate non-empty configs against presence of `mod.caseType`, so a
 * populated config without a case type would fail validation
 * upstream — the absence-arm here is the structural fallback.
 */
export function emitShortDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
}): CaseListEmission {
	const { module: mod, moduleIndex, doc } = args;
	const detailId = `m${moduleIndex}_case_short`;

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
		sortByUuid: buildSortDirectives(mod, doc),
		detailKind: "short",
	};

	const fields: string[] = [];
	const strings: Record<string, string> = {};

	// Walk every column in source-array order. Position is 1-based
	// against the source array — the 1-based counter advances for
	// every slot, including columns hidden from this surface, so the
	// header-locale suffix matches CCHQ's
	// `id_strings.py::detail_column_header_locale` convention which
	// keys off `column.id` (the source-array index regardless of
	// visibility).
	for (let i = 0; i < config.columns.length; i++) {
		const column = config.columns[i];
		// Visibility filter: absent slot ≡ visible. The schema
		// preserves the slot's presence so the editor can distinguish
		// "user explicitly toggled off" from "user never toggled".
		if (column.visibleInList === false) continue;
		const emission = emitColumnField({
			column,
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
