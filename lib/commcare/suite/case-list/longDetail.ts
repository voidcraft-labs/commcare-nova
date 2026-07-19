// lib/commcare/suite/case-list/longDetail.ts
//
// Suite-XML emission for the case-list long detail —
// `<detail id="m{n}_<target>_long">`. Walks
// `module.caseListConfig.columns`, filters by `column.visibleInDetail`
// (absent ≡ visible), and concatenates one `<field>` per surviving
// column into the surrounding `<detail>` shell.
//
// One emitter, two targets. The `target` parameter
// (`"case"` / `"search"`) selects which of the two CCHQ wire ids
// the same `caseListConfig` projects onto. The case-rooted block
// renders against `instance('casedb')`; the search-rooted block
// renders against `instance('results')`. Calc-column cross-case
// references rewrite their root accordingly. The canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`
// pins the structural identity between `m0_case_long` and
// `m0_search_long`.
//
// Per-column wire shape lives in `columns.ts`. Long-detail
// divergences flow through the `CaseListEmitContext.detailKind`
// discriminator:
//
//   - Locale ids carry the `case_long` substring per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
//     helper.
//
//   - `<sort>` blocks are suppressed on the non-nodeset long
//     detail per CCHQ's
//     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
//     short-circuit. The canonical fixture
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
//     confirms zero `<sort>` blocks despite a multi-key sort active
//     on the parent module's short detail.
//
//   - `phone` columns emit `<template form="phone">` per
//     `detail_screen.py::Phone.template_form` — verified at
//     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
//     phone field.
//
// Fields walk independent Details order (`detailOrder ?? order`, then uuid),
// so rearranging Results cannot disturb the confirmation screen. Position
// counter convention: the 1-based position passed to the per-column header-
// locale composer is the column's index in the complete Details-ordered source
// sequence plus one. The visibility filter affects which fields render, not
// their position numbers — toggling `visibleInDetail` doesn't churn locale ids.
// Mirrors CCHQ's
// `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`'s
// `column.id`-keyed numbering convention.
//
// The emitter does NOT register the `<title>` text into
// app_strings — `cchq.case` is CCHQ's built-in locale with a
// runtime fallback (registered with `default="Case"` at
// `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`).
// Same pattern as the short-detail emitter so both `<detail>`
// blocks display a consistent runtime title without app-strings
// entries.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import { byDetailColumnOrder } from "@/lib/doc/order/compare";
import {
	type BlueprintDoc,
	effectiveCaseTypes,
	type Module,
	type Uuid,
} from "@/lib/domain";
import type { AssetManifest } from "../../multimedia/assetWirePath";
import { buildColumnField } from "./columns";
import type { ResolvedSortDirective } from "./sortKeys";
import type {
	CaseListEmission,
	CaseListEmitContext,
	DetailTarget,
} from "./types";

/**
 * Empty sort-directive map for long-detail emission. The long-detail
 * surface emits no `<sort>` blocks regardless of authored sort
 * directives, so wiring a sort lookup map at this layer would just
 * burn cycles for an answer the per-column emitter ignores. The
 * `CaseListEmitContext` shape carries the slot uniformly across
 * surfaces; long detail passes this empty map and the per-column
 * emitter's long-detail short-circuit guards the unused lookup.
 */
const EMPTY_SORT_DIRECTIVES: ReadonlyMap<Uuid, ResolvedSortDirective> =
	new Map();

/**
 * Compose the suite-XML `<detail>` block for one module's case-list
 * long detail. Returns the concatenated XML plus the locale-id →
 * header-string map the surrounding compiler threads into
 * `app_strings.txt`.
 *
 * `doc` is accepted as part of the uniform per-detail emission
 * surface — both short and long detail emitters take the same
 * arg shape. Long detail doesn't read it (no sort directives, no
 * per-property type lookup needed for the non-nodeset case) but
 * the symmetry simplifies the compiler's call site.
 *
 * `target` selects between the two wire ids the same
 * `caseListConfig` projects onto — `"case"` (the local case-list
 * detail) or `"search"` (the search-results detail; emitted only
 * when the parent module has `caseSearchConfig`). The orchestrator
 * at `lib/commcare/compiler.ts` calls this once per active target.
 * Defaults to `"case"` so existing callers (and tests) that don't
 * thread a target stay on the case-list path unchanged.
 *
 * When `module.caseListConfig` is absent OR the module has no case
 * type, the emitter returns a minimal title-only `<detail>` block.
 * The validator's `columnReferences` rule (and its sibling rules)
 * gate non-empty configs against presence of `mod.caseType`, so a
 * populated config without a case type would fail validation
 * upstream — the absence-arm here is the structural fallback.
 */
export function buildLongDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
	readonly assets?: AssetManifest;
}): { readonly element: Element; readonly strings: Record<string, string> } {
	const { module: mod, moduleIndex } = args;
	const target: DetailTarget = args.target ?? "case";
	const detailId = `m${moduleIndex}_${target}_long`;

	// Early-exit shape: no caseListConfig OR no case type. The
	// resulting detail still carries a title — CCHQ's
	// `commcare-hq/corehq/apps/app_manager/suite_xml/xml_models.py::Detail`
	// model declares `title` as a non-optional `NodeField`, so a
	// zero-field detail still emits the `<title>` element.
	if (!mod.caseType || !mod.caseListConfig) {
		return { element: buildDetailShell(detailId, []), strings: {} };
	}

	const config = mod.caseListConfig;
	const caseProperties =
		effectiveCaseTypes(args.doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	const ctx: CaseListEmitContext = {
		moduleIndex,
		sortByUuid: EMPTY_SORT_DIRECTIVES,
		detailKind: "long",
		target,
		caseProperties,
		caseTypes: effectiveCaseTypes(args.doc),
		currentCaseType: mod.caseType,
		...(args.assets && { assets: args.assets }),
	};

	const fields: Element[] = [];
	const strings: Record<string, string> = {};

	// Walk every column in Details order (`detailOrder ?? order`, then uuid),
	// independently of Results. Position is 1-based against the complete long-
	// detail sequence, including fields hidden from this surface, because CCHQ's
	// header-locale suffix keys off the column's position in that array.
	const sortedColumns = [...config.columns].sort(byDetailColumnOrder);
	for (let i = 0; i < sortedColumns.length; i++) {
		const column = sortedColumns[i];
		// Visibility filter: absent slot ≡ visible. The schema
		// preserves the slot's presence so the editor can distinguish
		// "user explicitly toggled off" from "user never toggled".
		if (column.visibleInDetail === false) continue;
		const emission = buildColumnField({
			column,
			position: i + 1,
			ctx,
		});
		fields.push(emission.element);
		Object.assign(strings, emission.strings);
	}

	return { element: buildDetailShell(detailId, fields), strings };
}

/**
 * String adapter — serializes `buildLongDetail`'s Element for callers
 * that assert against the rendered XML string (the test surface).
 * `compileCcz` itself calls `buildLongDetail` directly.
 */
export function emitLongDetail(args: {
	readonly module: Module;
	readonly moduleIndex: number;
	readonly doc: BlueprintDoc;
	readonly target?: DetailTarget;
}): CaseListEmission {
	const { element, strings } = buildLongDetail(args);
	return { xml: render(element, RENDER_OPTS), strings };
}

/**
 * Build the surrounding `<detail>` Element. The title routes through
 * the built-in `cchq.case` locale; the field Elements slot in between
 * the title and the closing tag.
 */
function buildDetailShell(
	detailId: string,
	fields: readonly Element[],
): Element {
	const titleEl = el("title", {}, [
		el("text", {}, [el("locale", { id: "cchq.case" })]),
	]);
	return el("detail", { id: detailId }, [titleEl, ...fields]);
}
