/**
 * useSectionActivation — bundles activation lifecycle for a field-editor
 * section.
 *
 * The section renders a partition of its schema entries (visible vs
 * addable pills) and tracks one-shot "just-activated, take focus"
 * intent. Three rules wire activation to the user's actions:
 *
 *   1. Click an Add Property pill → `activate(key)` flips the entry
 *      into the visible bucket with `autoFocus=true`.
 *   2. Value lands by any path (user typing, undo/redo, LLM mutation,
 *      sibling-flip) → the partition's `pendingSatisfied` flag fires
 *      and we clear activation. Without this, a later value-clear
 *      would re-arm autoFocus and steal keyboard focus.
 *   3. User commits an empty value on a pending entry →
 *      `onCommit(key, undefined)` clears activation immediately. The
 *      partition would otherwise keep the editor in the visible bucket
 *      because `pending=true` overrides the now-falsy `visible()`
 *      predicate, leaving an empty editor stuck on screen.
 *
 * The hook owns the activation state, the partition computation, and
 * both clear paths. The section component is a pure renderer over the
 * returned `visible` / `pills` arrays plus the two callbacks.
 */
"use client";
import { useCallback, useEffect } from "react";
import type { Field } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import {
	type PartitionedEntries,
	partitionEditorEntries,
} from "./partitionEditorEntries";
import {
	type EditorSectionName,
	useEntryActivation,
} from "./useEntryActivation";

interface SectionActivation<F extends Field> {
	/** Entries to render with their editor component. */
	visible: PartitionedEntries<F>["visible"];
	/** Entries to render as Add Property pills. */
	pills: PartitionedEntries<F>["pills"];
	/** Activate a hidden-but-addable entry's pending intent. */
	activate: (key: string) => void;
	/**
	 * Notify the hook that the user committed `value` for `key`. When the
	 * value is `undefined` AND the entry was pending, activation clears so
	 * the editor unmounts and the Add Property pill returns. Returns the
	 * value unchanged so callers can chain it through their writer.
	 */
	onCommit: (key: string, value: unknown) => void;
}

export function useSectionActivation<F extends Field>(
	field: F,
	section: EditorSectionName,
	entries: readonly FieldEditorEntry<F>[],
): SectionActivation<F> {
	const activation = useEntryActivation(field.uuid, section);

	const partition = partitionEditorEntries(field, entries, (key) =>
		activation.pending(key),
	);

	// Effect: when the partition reports a pending entry has become
	// independently visible, the user's pill-click intent is satisfied
	// and we clear activation. Single source for both the
	// landed-by-typing and landed-by-undo-or-LLM paths.
	useEffect(() => {
		if (partition.pendingSatisfied) activation.clear();
	}, [partition.pendingSatisfied, activation]);

	// Synchronous clear when the user commits an empty value on a pending
	// entry. The partition's `pendingSatisfied` flag won't fire here
	// because the predicate flips falsy on the same render the value
	// clears; without this branch, `pending=true` would override the
	// falsy predicate and keep the editor visible.
	const onCommit = useCallback(
		(key: string, value: unknown) => {
			if (value === undefined && activation.pending(key)) {
				activation.clear();
			}
		},
		[activation],
	);

	return {
		visible: partition.visible,
		pills: partition.pills,
		activate: activation.activate,
		onCommit,
	};
}
