// lib/commcare/suite/case-list/types.ts
//
// Shared structural types for the case-list short-detail emitter
// stack. The orchestrator (`shortDetail.ts`) walks
// `module.caseListConfig` and dispatches per-`Column` /
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
 * `cchq.case` as a built-in locale with `default="Case"` per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py:78-80` —
 * the runtime falls back to the registered default and the
 * emitter doesn't need to register the value itself.
 */
export interface CaseListEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
}

/**
 * Per-emit invocation context. The orchestrator constructs one
 * instance per module and forwards it through every per-column
 * call so individual emitters never need to know the parent
 * module's index.
 *
 *   - `moduleIndex` is the 0-based index of the module in
 *     `doc.moduleOrder`. The wire layer uses it to compose
 *     locale ids (`m{moduleIndex}.case_short.case_<field>_<i>.header`)
 *     and the `<detail>` block's `id` attribute
 *     (`m{moduleIndex}_case_short`). The locale-id pattern
 *     matches CCHQ's `detail_column_header_locale` at
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py:105-117`
 *     (the `@pattern` decorator on line 105 + the function body
 *     through line 117); the `<detail>` block id matches CCHQ's
 *     `detail()` helper at the same file's lines 466-467
 *     (`m{module.id}_{detail_type}`).
 *   - `sort` is the module's sort-key array. Per-column emitters
 *     resolve the matching key via `findSortKey(sort, target)`
 *     (in `sortKeys.ts`) — when one matches, the column's `<field>`
 *     receives an inline `<sort>` block; otherwise no sort element
 *     is emitted.
 */
export interface CaseListEmitContext {
	readonly moduleIndex: number;
	readonly sort: readonly SortKey[];
}
