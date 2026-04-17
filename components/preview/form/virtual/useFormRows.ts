/**
 * useFormRows — hook that produces the flattened row list for a form.
 *
 * Subscribes to the two doc slices the walker reads (`fields`,
 * `fieldOrder`) with shallow equality so unrelated mutations don't
 * churn the walker. The walker output is memoized on its inputs —
 * `useMemo` bails when the source slices and the collapsed set are
 * reference-equal.
 *
 * Unlike the legacy implementation, there is no "freeze on drag" mode.
 * Pragmatic DnD uses the browser's native drag preview (snapshotted at
 * drag start), so the underlying list can mutate freely during a drag
 * without fighting the overlay.
 */

import { useMemo } from "react";
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
}

/** Shared empty-set constant for callers that aren't tracking collapse. */
export const EMPTY_COLLAPSE: CollapseState = new Set();

export function useFormRows(options: UseFormRowsOptions): FormRow[] {
	const { formUuid, includeInsertionPoints, collapsed } = options;

	// Subscribe only to the slices the walker reads. Shallow-equality
	// skips re-renders when unrelated parts of the doc change.
	const source = useBlueprintDocShallow<RowSource>((s) => ({
		fields: s.fields,
		fieldOrder: s.fieldOrder,
	}));

	return useMemo(
		() =>
			buildFormRows(source, formUuid, {
				includeInsertionPoints,
				collapsed,
			}),
		[source, formUuid, includeInsertionPoints, collapsed],
	);
}
