/**
 * FieldEditorSection — renders one Data / Logic / UI section of the
 * declarative field inspector.
 *
 * Reads its entries from the schema (passed in by the panel, which
 * knows the kind → schema mapping). For each entry:
 *   - If `visible(field)` returns true (or is undefined), OR the
 *     entry is currently pending activation, render the entry's
 *     `component` with the typed value + onChange.
 *   - Otherwise, if `entry.addable === true`, queue the entry for
 *     the Add Property pill row below the editors.
 *   - Otherwise, the entry stays hidden silently (e.g. a kind
 *     doesn't currently expose this property and won't until
 *     another mutation flips visibility).
 *
 * Returns `null` when neither editors nor pills would render — the
 * parent (FieldEditorPanel) uses the null return to skip the
 * section's card chrome entirely.
 *
 * AnimatePresence wraps the visible editors so add/remove transitions
 * (opacity + height) animate smoothly when a pill is activated or an
 * entry's `visible()` flips false. Keys are the entry `key` string so
 * React keeps editor instances stable across visibility flips — an
 * editor that toggles off and back on retains its internal state.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Field, FieldPatch } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import { AddPropertyButton } from "./AddPropertyButton";
import {
	type PartitionedEntries,
	partitionEditorEntries,
} from "./partitionEditorEntries";
import {
	type EditorSectionName,
	useEntryActivation,
} from "./useEntryActivation";

/**
 * Prop shape for the section. Generic on the field variant so the
 * component dispatch is precisely typed — the panel narrows `field`
 * to a single kind via `Extract<Field, { kind: K }>` and passes the
 * matching entries list.
 */
interface FieldEditorSectionProps<F extends Field> {
	field: F;
	section: EditorSectionName;
	entries: readonly FieldEditorEntry<F>[];
}

export function FieldEditorSection<F extends Field>({
	field,
	section,
	entries,
}: FieldEditorSectionProps<F>) {
	const { updateField } = useBlueprintMutations();
	// `field.uuid` is already branded `Uuid` — the activation hook
	// scopes by the raw string so component identity persists across
	// hover/unfocus cycles without caring about branded types.
	const activation = useEntryActivation(field.uuid, section);

	// Generic setter: write exactly one key on this field. `FieldPatch`
	// is the union-wide partial — the reducer merges known scalar props
	// and ignores the rest. The cast to `FieldPatch` is necessary because
	// the per-entry key type is a string literal but the patch input is
	// the union-of-partials shape.
	const setKey = useCallback(
		<K extends keyof F & string>(key: K, value: F[K]) => {
			updateField(field.uuid, {
				[key]: value,
			} as FieldPatch);
		},
		[updateField, field.uuid],
	);

	// Partition entries via the shared helper. The panel uses the same
	// partition (with a no-op pending predicate) to decide whether to
	// mount the section's card at all — keeping the partition logic in
	// one place ensures the panel's "would this render anything?" check
	// agrees with what the section actually renders.
	const partitioned: PartitionedEntries<F> = partitionEditorEntries(
		field,
		entries,
		(key) => activation.pending(key),
	);
	const { visible, pills } = partitioned;

	// Activation is a one-shot "just-activated, take focus" intent. As
	// soon as the pending entry is ALSO visible by its own `visible()`
	// predicate (value committed, undo/redo restored it, sibling
	// predicate flipped it true), the intent is satisfied and we clear
	// it. This avoids a stuck-pending state where a value arrives by a
	// non-onChange path (LLM mutation, undo, parent-key flip) and the
	// next unrelated rerender would steal keyboard focus with a stale
	// autoFocus=true.
	const anyVisibleAndPending = visible.some(
		({ autoFocus, independentlyVisible }) => autoFocus && independentlyVisible,
	);
	useEffect(() => {
		if (anyVisibleAndPending) activation.clear();
	}, [anyVisibleAndPending, activation]);

	// Section contributes nothing — let the panel skip the card chrome.
	if (visible.length === 0 && pills.length === 0) return null;

	const hasContent = visible.length > 0;

	return (
		<>
			{/* initial={false} so entries already visible on mount don't
			 *  replay their entrance animation. Only flips that happen
			 *  after mount (pill click, undo/redo, value clear) animate. */}
			<AnimatePresence initial={false}>
				{visible.map(({ entry, autoFocus }) => {
					// The per-entry component type is
					// `FieldEditorComponent<F, K>` for the entry's specific K.
					// We've already narrowed via the `visible` partition; the
					// cast lets the single render path accept any K without
					// per-entry branching.
					const key = entry.key as keyof F & string;
					const Component = entry.component as React.ComponentType<{
						field: F;
						value: F[typeof key];
						onChange: (next: F[typeof key]) => void;
						label: string;
						keyName: typeof key;
						autoFocus?: boolean;
					}>;
					const value = field[key];
					return (
						<motion.div
							key={key}
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<Component
								field={field}
								value={value}
								label={entry.label}
								keyName={key}
								autoFocus={autoFocus}
								onChange={(next) => setKey(key, next)}
							/>
						</motion.div>
					);
				})}
			</AnimatePresence>

			{pills.length > 0 && (
				<div
					className={hasContent ? "pt-2 border-t border-nova-border/40" : ""}
				>
					<div className="flex flex-wrap gap-1.5">
						{pills.map((entry) => (
							<AddPropertyButton
								key={entry.key as string}
								label={entry.label}
								onClick={() => activation.activate(entry.key as string)}
							/>
						))}
					</div>
				</div>
			)}
		</>
	);
}
