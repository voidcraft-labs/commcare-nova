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
import { useCallback } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Field, FieldPatchFor } from "@/lib/domain";
import type { FieldEditorEntry } from "@/lib/domain/kinds";
import { AddPropertyButton } from "./AddPropertyButton";
import type { EditorSectionName } from "./useEntryActivation";
import { useSectionActivation } from "./useSectionActivation";

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
	// `useSectionActivation` owns activation state, the partition, and
	// both clear paths (pending-satisfied + empty-commit). The section
	// is a pure renderer over the returned `visible` / `pills` arrays
	// plus the `activate` / `onCommit` callbacks.
	const { visible, pills, activate, onCommit } = useSectionActivation(
		field,
		section,
		entries,
	);

	// Generic setter: write exactly one key on this field, then notify
	// the activation hook so it can clear pending state on empty-commit.
	// The field's `kind` discriminates the patch type — every per-key
	// editor in this section is mounted only when the schema entry's
	// `visible(field)` returns true, so `key` is always a property the
	// kind's schema declares. The cast on `updateField`'s patch arg
	// folds the generic key/value pair back to the variant's partial
	// shape; TypeScript can't infer the per-arm patch shape from a
	// single-key literal whose key is `K extends keyof F` because each
	// per-kind arm sees `K` distributively.
	const setKey = useCallback(
		<K extends keyof F & string>(key: K, value: F[K]) => {
			// `unknown` widening: the runtime patch shape is a single
			// arbitrary key/value pair, but the hook's type-level patch
			// shape is per-kind partial; TS can't bridge a generic `K
			// extends keyof F` to a specific arm of the discriminated
			// union. Every editor that mounts here is gated on
			// `entry.visible(field)`, so `key` is always a property the
			// kind's schema declares.
			updateField(field.uuid, field.kind, {
				[key]: value,
			} as unknown as FieldPatchFor<F["kind"]>);
			onCommit(key, value);
		},
		[updateField, field.uuid, field.kind, onCommit],
	);

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
								// Two pill-click flows. Entries with `valueOnAdd`
								// (e.g. the Required toggle) write the on-state
								// directly — adding the property already encodes
								// the user's intent, so an empty editor + manual
								// flip would just be two clicks for one
								// decision. Entries without it (XPath / text
								// editors) take the pending-activation path so
								// the empty editor mounts in autoFocus mode and
								// the user can immediately start typing.
								onClick={() => {
									if (entry.valueOnAdd !== undefined) {
										setKey(
											entry.key as keyof F & string,
											entry.valueOnAdd as F[keyof F & string],
										);
										return;
									}
									activate(entry.key as string);
								}}
							/>
						))}
					</div>
				</div>
			)}
		</>
	);
}
