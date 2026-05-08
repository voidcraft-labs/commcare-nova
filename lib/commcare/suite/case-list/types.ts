// lib/commcare/suite/case-list/types.ts
//
// Shared structural types for the case-list detail emitter stack.
// Two orchestrators (`shortDetail.ts`, `longDetail.ts`) walk
// `module.caseListConfig.columns` and dispatch per-`Column` slots
// through `columns.ts`; the per-column sort-directive lookup map
// is built once by `sortKeys.ts::buildSortDirectives` and threaded
// through the context. Keeping the cross-module shapes here lets
// each emitter import only the type it needs without circling
// back through the orchestrator.

import type { Uuid } from "@/lib/domain";
import type { ResolvedSortDirective } from "./sortKeys";

/**
 * The two-component result every emitter at this layer hands back.
 * `xml` is the literal suite-XML fragment (a fully-formed `<field>`
 * block, or a complete `<detail>` block at the top level).
 * `strings` collects the per-detail locale-id → display-string
 * pairs the caller writes into `app_strings.txt`. The detail
 * title doesn't contribute to `strings` because CCHQ ships
 * `cchq.case` as a built-in locale registered with
 * `default="Case"` (see
 * `commcare-hq/corehq/apps/app_manager/id_strings.py::_case_detail_title_locale`)
 * — the runtime falls back to the registered default and the
 * emitter doesn't need to register the value itself.
 */
export interface CaseListEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
}

/**
 * Discriminator selecting which CCHQ detail surface a `<field>`
 * is being composed for. Three things diverge between the two
 * surfaces in CCHQ's wire shape:
 *
 *   - **Locale-id substring.** Short-detail headers register
 *     under `m{n}.case_short.case_<field>_<i>.header`; long-detail
 *     headers register under `m{n}.case_long.case_<field>_<i>.header`.
 *     The substring matches CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail_column_header_locale`
 *     `@pattern('m%d.%s.%s_%s_%d.header')` decorator with
 *     `detail_type` set to `case_short` / `case_long` per the
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
 *     helper.
 *
 *   - **`<sort>` block presence.** Short detail emits `<sort>`
 *     blocks for every column that carries `column.sort`. Long
 *     detail emits NO `<sort>` blocks for the non-nodeset case —
 *     CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
 *     short-circuits when `self.detail.display != 'short'` unless
 *     the column rides on a related-case-tab nodeset. The canonical
 *     fixture
 *     `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
 *     confirms zero `<sort>` blocks despite a multi-key sort active
 *     on the parent module's short detail.
 *
 *   - **Phone template `form` attribute.** CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`
 *     returns `'phone'` only on the long detail. The short
 *     detail's phone column emits a bare `<template>`; the long
 *     detail's phone column emits `<template form="phone">`,
 *     verified at
 *     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`
 *     where the phone field's `<template>` carries `form="phone"`.
 */
export type DetailKind = "short" | "long";

/**
 * Per-emit invocation context. The orchestrator constructs one
 * instance per module-detail pair and forwards it through every
 * per-column call so individual emitters never need to know the
 * parent module's index or which detail surface they're
 * composing for.
 *
 *   - `moduleIndex` — 0-based index of the module in
 *     `doc.moduleOrder`. Composes the surrounding `<detail>` block
 *     id (`m{moduleIndex}_case_<short|long>`) per CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
 *     helper, and feeds the per-column header-locale composer.
 *
 *   - `sortByUuid` — resolved sort directives keyed by
 *     `column.uuid`. Built once per module by
 *     `sortKeys.ts::buildSortDirectives` and threaded through here.
 *     Per-column emitters look up their directive in O(1) without
 *     walking the array. Long detail's emitter ignores the map per
 *     the `DetailKind`-described divergence above; passing it
 *     uniformly keeps the context shape symmetric across surfaces.
 *
 *   - `detailKind` — selects between the two surfaces' divergent
 *     emission behaviors.
 */
export interface CaseListEmitContext {
	readonly moduleIndex: number;
	readonly sortByUuid: ReadonlyMap<Uuid, ResolvedSortDirective>;
	readonly detailKind: DetailKind;
}
