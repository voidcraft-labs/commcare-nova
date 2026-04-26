/**
 * partitionEditorEntries — single source of truth for "what does this
 * section actually render?" given a field value + entries list.
 *
 * Lives standalone so both the section (which renders the result)
 * and the panel (which decides whether to mount the section's card
 * chrome) agree on the partition. Any drift between them would
 * produce an empty card with only a label, or — worse — a section
 * that claims nothing to render but secretly would.
 *
 * The partition rules:
 *   1. If the entry is currently pending activation OR its
 *      `visible(field)` predicate returns truthy (default: true when
 *      no predicate), it goes into the `visible` bucket.
 *   2. Otherwise, if the entry is `addable`, it goes into the
 *      `pills` bucket (rendered as an Add Property button).
 *   3. Otherwise, it's silently dropped — a hidden non-addable entry
 *      contributes nothing to the section.
 *
 * `autoFocus` is strictly "pending AND NOT independently visible":
 * the pill click was the only reason this entry is in the visible
 * bucket. If the entry became visible by its own `visible()`
 * predicate (value committed by any path — user typing, undo/redo,
 * LLM mutation, sibling flip), autoFocus is false. This prevents
 * stealing keyboard focus on rerenders after the intent is satisfied.
 *
 * `independentlyVisible` is exposed on every visible entry so the
 * section can tell whether a pending-and-visible entry's intent has
 * been satisfied (in which case it clears activation).
 */

import type { Field } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";

/** A visible entry plus the flags that drive focus + activation-clear
 *  decisions in the section renderer. */
interface VisiblePartitionedEntry<F extends Field> {
	/** The entry definition from the schema. */
	entry: FieldEditorEntry<F>;
	/** True when the entry is visible solely because of pending activation.
	 *  Consumers pass this through to the editor's `autoFocus` prop. */
	autoFocus: boolean;
	/** True when the entry's own `visible(field)` predicate returns
	 *  truthy — i.e. it would render even without the pending flag.
	 *  The section uses this to decide when the one-shot pending
	 *  intent is satisfied and should be cleared. */
	independentlyVisible: boolean;
}

/** Result shape returned by `partitionEditorEntries`. */
export interface PartitionedEntries<F extends Field> {
	/** Entries whose editor component should mount this render. */
	visible: VisiblePartitionedEntry<F>[];
	/** Entries that should render as Add Property pills. */
	pills: FieldEditorEntry<F>[];
	/**
	 * True when at least one pending entry has become independently
	 * visible — the pill-click intent is satisfied (value landed by any
	 * path: user typing, undo/redo restore, LLM mutation, sibling
	 * predicate flip) so activation can safely clear. Without this
	 * signal, the pending flag would linger and a later value-clear
	 * would re-trigger autoFocus on the next render, hijacking focus
	 * after the user has moved on.
	 */
	pendingSatisfied: boolean;
}

/**
 * Walk the entries list once and bucket each entry per the rules above.
 *
 * @param field - The field value — passed to each entry's `visible(field)`
 *   predicate.
 * @param entries - The section's entry list from the per-kind schema.
 * @param isPending - Optional predicate answering "is this entry currently
 *   pending activation?" The section passes a real predicate here; the
 *   panel passes a no-op (pending doesn't change card-visibility
 *   because a pending entry still produces a visible editor, which
 *   the panel already handles identically to an independently-visible
 *   entry).
 */
export function partitionEditorEntries<F extends Field>(
	field: F,
	entries: readonly FieldEditorEntry<F>[],
	isPending: (key: string) => boolean = () => false,
): PartitionedEntries<F> {
	const visible: VisiblePartitionedEntry<F>[] = [];
	const pills: FieldEditorEntry<F>[] = [];
	let pendingSatisfied = false;

	for (const entry of entries) {
		const pending = isPending(entry.key as string);
		const independentlyVisible = entry.visible ? entry.visible(field) : true;
		if (independentlyVisible || pending) {
			visible.push({
				entry,
				// autoFocus only when pending is the SOLE reason this entry
				// is in the visible bucket. If the value is already
				// independently visible, the pill click isn't responsible
				// for mounting the editor and shouldn't steal focus.
				autoFocus: pending && !independentlyVisible,
				independentlyVisible,
			});
			// `pending && independentlyVisible` is the satisfaction signal:
			// the user requested activation AND the value has now landed.
			// One match across all entries is enough — activation is
			// section-scoped, so a single satisfied entry clears it for the
			// whole section.
			if (pending && independentlyVisible) pendingSatisfied = true;
		} else if (entry.addable) {
			pills.push(entry);
		}
	}

	return { visible, pills, pendingSatisfied };
}

/**
 * Cheap "does this section render anything?" check for the panel,
 * used to gate the section's card chrome. Uses the same partition
 * rules as `partitionEditorEntries` but ignores pending activation —
 * the panel mounts the section wrapper BEFORE activation state is
 * known to it, and a pending entry still produces a visible editor
 * (which the section handles).
 */
export function sectionHasContent<F extends Field>(
	field: F,
	entries: readonly FieldEditorEntry<F>[],
): boolean {
	const { visible, pills } = partitionEditorEntries(field, entries);
	return visible.length > 0 || pills.length > 0;
}
