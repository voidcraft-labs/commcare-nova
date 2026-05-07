// lib/commcare/suite/case-list/types.ts
//
// Shared structural types for the case-list short-detail emitter
// stack. The orchestrator (`shortDetail.ts`) walks
// `module.caseListConfig` and dispatches per-`Column` /
// per-`CalculatedColumn` slots through `columns.ts`; sort-key
// resolution flows through `sortKeys.ts`. Keeping the cross-module
// shapes here lets each emitter import only the type it needs
// without circling back through the orchestrator.

import type { CalculatedColumn, Column, SortKey } from "@/lib/domain";

/**
 * The two-component result every emitter at this layer hands back.
 * `xml` is the literal suite-XML fragment (a fully-formed `<field>`
 * block, or a complete `<detail>` block at the top level).
 * `strings` collects the per-detail locale-id → display-string
 * pairs the caller writes into `app_strings.txt`. Calculated
 * columns and the detail title don't contribute to `strings`
 * (calculated columns name themselves through CCHQ's
 * `case_calculated_property_<i>` convention via the same locale
 * id; the title resolves through CCHQ's built-in `cchq.case`
 * locale that ships with `default="Case"` per
 * `commcare-hq/corehq/apps/app_manager/id_strings.py:78-80`),
 * so emitters return only the entries they author.
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
 *     (`m{moduleIndex}_case_short`). The locale-id pattern matches
 *     CCHQ's canonical convention at
 *     `commcare-hq/corehq/apps/app_manager/id_strings.py:88-103`
 *     (`detail_column_header_locale`); the `<detail>` block id
 *     matches `:111-118` (`detail_short_locale`).
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

/**
 * Per-column slot identifier the orchestrator threads through to
 * the per-column emitter. Combines the position (1-based, used to
 * compose the locale id) and the column itself. Calculated columns
 * carry the same shape but with `kind: "calculated"` so the
 * dispatcher can branch on a single discriminator.
 */
export type ColumnSlot =
	| {
			readonly kind: "column";
			readonly position: number;
			readonly column: Column;
	  }
	| {
			readonly kind: "calculated";
			readonly position: number;
			readonly calculated: CalculatedColumn;
	  };
