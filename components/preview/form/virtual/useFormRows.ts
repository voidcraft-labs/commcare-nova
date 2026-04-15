/**
 * useFormRows — hook that produces the flattened row list for a form.
 *
 * Responsibilities:
 *
 * 1. Subscribe to the two doc slices the walker reads (`questions`,
 *    `questionOrder`) with shallow equality, so unrelated mutations (e.g.
 *    renaming a module name) don't churn the walker.
 * 2. Memoize the walker output on its real inputs (source, form uuid,
 *    collapsed set, insertion-point toggle). React-memo bails when none of
 *    these changed.
 * 3. Freeze the row list while a drag is in progress. The returned array
 *    identity is captured the first render where `frozen` becomes true and
 *    held until `frozen` flips back to false. This prevents the virtualizer
 *    from remounting rows underneath dnd-kit while the user drags.
 */

import { useMemo, useRef } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import {
	buildFormRows,
	type CollapseState,
	type FormRow,
	type RowSource,
} from "./rowModel";

export interface UseFormRowsOptions {
	/** The form's uuid — root parent for the walker. */
	readonly formUuid: Uuid;
	/** Whether to include insertion-point rows (edit mode = true). */
	readonly includeInsertionPoints: boolean;
	/** Currently collapsed group uuids. Pass `EMPTY_COLLAPSE` when none. */
	readonly collapsed: CollapseState;
	/**
	 * When `true`, freeze the row list at its live value. Flip to `false`
	 * to release. Typical use: set to `true` on drag start, `false` on
	 * drop — during drag the virtualizer must not remount rows, or dnd-kit
	 * loses the sortable mapping for the dragged item.
	 */
	readonly frozen: boolean;
}

/** Shared empty-set constant for callers that aren't tracking collapse. */
export const EMPTY_COLLAPSE: CollapseState = new Set();

export function useFormRows(options: UseFormRowsOptions): FormRow[] {
	const { formUuid, includeInsertionPoints, collapsed, frozen } = options;

	// Subscribe to only the slices the walker reads. Shallow compare lets
	// Zustand skip re-renders when unrelated parts of the doc (module
	// names, app metadata) change.
	const source = useBlueprintDocShallow<RowSource>((s) => ({
		questions: s.questions,
		questionOrder: s.questionOrder,
	}));

	// Live walker output. Recomputes only when one of its real inputs
	// changes. `collapsed` is a `Set` whose identity changes on toggle —
	// callers should create a new Set on mutation and hold a stable
	// reference otherwise (the `EMPTY_COLLAPSE` constant above is the
	// stable reference for "no collapse").
	const liveRows = useMemo(
		() =>
			buildFormRows(source, formUuid, {
				includeInsertionPoints,
				collapsed,
			}),
		[source, formUuid, includeInsertionPoints, collapsed],
	);

	// Freeze: hold onto the rows array that was live when `frozen` first
	// flipped to true. On subsequent renders while frozen, return the
	// captured array (same identity → virtualizer skips re-measurement).
	// When `frozen` flips back to false, clear the capture and return the
	// live rows (which may reflect the completed drop's mutation).
	const frozenRef = useRef<FormRow[] | null>(null);
	if (frozen) {
		if (frozenRef.current === null) {
			frozenRef.current = liveRows;
		}
		return frozenRef.current;
	}
	frozenRef.current = null;
	return liveRows;
}
