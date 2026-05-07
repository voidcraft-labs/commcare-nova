// lib/commcare/suite/case-list/types.ts
//
// Shared structural types for the case-list detail emitter stack.
// Two orchestrators (`shortDetail.ts`, `longDetail.ts`) walk
// `module.caseListConfig` and dispatch per-`Column` /
// per-`CalculatedColumn` slots through `columns.ts`; sort-key
// resolution flows through `sortKeys.ts`. Keeping the cross-module
// shapes here lets each emitter import only the type it needs
// without circling back through the orchestrator.

import type { SortKey } from "@/lib/domain";

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
 *   - **`<sort>` block presence.** Short detail emits `<sort>`
 *     blocks for both property-rooted and calculated columns when
 *     `caseListConfig.sort` (or `CalculatedColumn.sort`) targets
 *     them. Long detail emits NO `<sort>` blocks for the
 *     non-nodeset case — CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/detail_screen.py::FormattedDetailColumn.sort_node`
 *     short-circuits when `self.detail.display != 'short'` unless
 *     the column rides on a related-case-tab nodeset (the
 *     schema's `caseListConfig.detailColumns` carries no nodeset
 *     binding). The canonical fixture
 *     `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
 *     confirms: four `<field>` blocks, zero `<sort>` blocks,
 *     despite the parent module carrying a multi-key sort that
 *     surfaces fully on `<detail id="m0_case_short">`.
 *   - **Phone template `form` attribute.** CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/detail_screen.py::Phone.template_form`
 *     returns `'phone'` only on the long detail. The short
 *     detail's phone column emits a bare `<template>`; the long
 *     detail's phone column emits `<template form="phone">`,
 *     which the runtime renders as a tappable-link affordance.
 *     Verified at
 *     `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`
 *     where the phone field's `<template>` carries `form="phone"`.
 *
 * `search-only` columns also diverge per Nova's authoring-layer
 * choice: the long detail emits no field for them. The
 * `search-only` kind's authoring intent is a search/filter
 * target with no case-list display affordance — the case-detail
 * screen has no search/filter affordance, so the kind has no
 * purpose there.
 */
export type DetailKind = "short" | "long";

/**
 * Per-emit invocation context. The orchestrator constructs one
 * instance per module-detail pair and forwards it through every
 * per-column call so individual emitters never need to know the
 * parent module's index or which detail surface they're
 * composing for.
 *
 *   - `moduleIndex` is the 0-based index of the module in
 *     `doc.moduleOrder`. Composes the surrounding `<detail>`
 *     block id (`m{moduleIndex}_case_<short|long>`) per CCHQ's
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py::detail`
 *     helper, and feeds the per-column header-locale composer.
 *   - `sort` is the module's sort-key array. Per-column emitters
 *     resolve the matching key via `findSortKey(sort, target)`
 *     (in `sortKeys.ts`) on short detail; long detail ignores
 *     the array per the `DetailKind`-described divergence above.
 *     Passing it uniformly keeps the context shape symmetric
 *     across surfaces.
 *   - `detailKind` selects between the two surfaces' divergent
 *     emission behaviors.
 */
export interface CaseListEmitContext {
	readonly moduleIndex: number;
	readonly sort: readonly SortKey[];
	readonly detailKind: DetailKind;
}
