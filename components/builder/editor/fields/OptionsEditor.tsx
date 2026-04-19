/**
 * OptionsEditor — declarative editor for the `options` array on
 * single-select / multi-select fields.
 *
 * Two exports:
 *   - `OptionsEditor` — the FieldEditorComponent adapter. Accepts
 *     `FieldEditorComponentProps` and enforces the schema's `min(2)`
 *     invariant at the adapter boundary: drafts smaller than two
 *     entries collapse to `undefined` (which the reducer treats as a
 *     removal patch) rather than writing through a list the schema
 *     would reject on the next validation pass.
 *   - `OptionsEditorWidget` — the underlying fieldset widget with the
 *     `{ options, onSave }` shape. Callers that already hold a
 *     persistence strategy and simply want the label/value rows + add
 *     button use this directly.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId, useRef, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import type { Field, SelectOption } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

/**
 * Draft option with a stable identity for React key management.
 * The `id` is component-local and never persisted — it exists purely
 * so that reordering or editing doesn't cause React to lose input
 * state.
 */
interface DraftOption extends SelectOption {
	id: number;
}

interface OptionsEditorWidgetProps {
	options: SelectOption[];
	onSave: (options: SelectOption[]) => void;
	/** When true, the first option label input receives focus on mount (undo/redo restore). */
	autoFocus?: boolean;
}

/** Counter for generating monotonically increasing draft IDs. */
let nextDraftId = 0;

/**
 * Stable ref callback that focuses the element on mount. Defined at
 * module scope so React doesn't see a new function identity each
 * render — if it did, React would unmount and remount the ref on
 * every parent update and steal focus.
 */
const focusOnMount = (el: HTMLInputElement | null) =>
	el?.focus({ preventScroll: true });

/** Wrap raw options with stable draft IDs. */
function toDraftOptions(options: SelectOption[]): DraftOption[] {
	return options.map((o) => ({ ...o, id: nextDraftId++ }));
}

/** Strip draft IDs before persisting. */
function toOptions(draft: DraftOption[]): SelectOption[] {
	return draft.map(({ value, label }) => ({ value, label }));
}

/**
 * Canonical key used to compare two `SelectOption[]` values. The
 * draft-sync gate uses it to detect external changes without
 * regenerating draft ids on every round-trip.
 */
function serializeOptions(options: SelectOption[]): string {
	return JSON.stringify(options);
}

/**
 * Low-level widget: renders the label+value inputs, add/remove row
 * affordances, and commits on group blur / Enter keypress.
 */
function OptionsEditorWidget({
	options,
	onSave,
	autoFocus,
}: OptionsEditorWidgetProps) {
	const [draft, setDraft] = useState<DraftOption[]>(() =>
		toDraftOptions(options),
	);
	const [focusIndex, setFocusIndex] = useState<number | null>(null);
	const groupLabelId = useId();

	// Ref on the fieldset element — used by the blur handler to check
	// whether focus moved outside the group. Checking
	// `fieldsetRef.current?.contains(...)` after an rAF is resilient
	// to the element unmounting mid-blur (common when the group's
	// last input is deleted during focus), because the ref nulls out
	// when the DOM detaches.
	const fieldsetRef = useRef<HTMLFieldSetElement | null>(null);

	// Remember the key of the last *local* commit so we can
	// distinguish "parent echoed our own write back" from "external
	// mutation" (undo/redo, tool call, another editor). Only external
	// mutations should regenerate draft ids + clear the focus index;
	// echoes of our own commits would otherwise unmount the
	// currently-focused input between keystrokes and drop caret/focus.
	const lastCommittedKeyRef = useRef<string>(serializeOptions(options));
	const currentKey = serializeOptions(options);
	if (currentKey !== lastCommittedKeyRef.current) {
		// External change — the prop no longer matches what we last
		// wrote. Resync the draft and drop any pending focus hint.
		lastCommittedKeyRef.current = currentKey;
		setDraft(toDraftOptions(options));
		setFocusIndex(null);
	}

	// Commit the draft to the parent, stripping empty rows. Records
	// the committed key before dispatch so the sync block above
	// recognizes the echoed prop as a self-write.
	const commit = useCallback(
		(updated: DraftOption[]) => {
			const cleaned = toOptions(updated).filter(
				(o) => o.label.trim() || o.value.trim(),
			);
			lastCommittedKeyRef.current = serializeOptions(cleaned);
			onSave(cleaned);
		},
		[onSave],
	);

	const updateOption = useCallback(
		(index: number, field: "label" | "value", val: string) => {
			setDraft((prev) => {
				const next = [...prev];
				next[index] = { ...next[index], [field]: val };
				return next;
			});
		},
		[],
	);

	const removeOption = useCallback(
		(index: number) => {
			const next = draft.filter((_, i) => i !== index);
			setDraft(next);
			commit(next);
		},
		[draft, commit],
	);

	const addOption = useCallback(() => {
		const num = draft.length + 1;
		const next: DraftOption[] = [
			...draft,
			{ id: nextDraftId++, value: `option_${num}`, label: `Option ${num}` },
		];
		setDraft(next);
		commit(next);
		setFocusIndex(next.length - 1);
	}, [draft, commit]);

	/**
	 * Commit when focus leaves the entire option group.
	 *
	 * The check runs in the next frame (rAF) because `blur` fires
	 * before React processes the focus move to the new element —
	 * without the deferral, `document.activeElement` is still `body`
	 * even when the user is tabbing between inputs inside the same
	 * fieldset. `fieldsetRef.current?.contains(...)` is nullable to
	 * survive the case where the fieldset itself unmounted between
	 * blur and the rAF callback (e.g. the options array dropped to
	 * zero rows and a parent hid the section).
	 */
	const handleBlur = useCallback(() => {
		requestAnimationFrame(() => {
			const el = fieldsetRef.current;
			if (!el) return;
			if (!el.contains(document.activeElement)) {
				commit(draft);
				setFocusIndex(null);
			}
		});
	}, [draft, commit]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				(e.target as HTMLElement).blur();
				commit(draft);
			}
		},
		[draft, commit],
	);

	return (
		<fieldset
			ref={fieldsetRef}
			onBlur={handleBlur}
			aria-labelledby={groupLabelId}
			className="border-none p-0 m-0"
		>
			<legend
				id={groupLabelId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block p-0"
			>
				Options
			</legend>
			<div className="space-y-1.5">
				{draft.map((opt, i) => (
					<div key={opt.id} className="flex items-center gap-1.5 group">
						<div className="flex-1 min-w-0 flex gap-1">
							<input
								value={opt.label}
								onChange={(e) => updateOption(i, "label", e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="Label"
								ref={
									focusIndex === i || (autoFocus && i === 0)
										? focusOnMount
										: undefined
								}
								className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-md bg-nova-deep/50 border border-white/[0.06] focus:border-nova-violet/50 focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)] text-nova-text outline-none transition-colors"
								autoComplete="off"
								data-1p-ignore
							/>
							<input
								value={opt.value}
								onChange={(e) => updateOption(i, "value", e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="value"
								className="w-24 shrink-0 text-xs font-mono px-2 py-1.5 rounded-md bg-nova-deep/50 border border-white/[0.06] focus:border-nova-violet/50 focus:shadow-[0_0_0_1px_rgba(139,92,246,0.1)] text-nova-text-muted outline-none transition-colors"
								autoComplete="off"
								data-1p-ignore
							/>
						</div>
						<button
							type="button"
							onClick={() => removeOption(i)}
							className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
							tabIndex={-1}
						>
							<Icon icon={tablerTrash} width="12" height="12" />
						</button>
					</div>
				))}
			</div>
			<AddPropertyButton
				label="Add option"
				onClick={addOption}
				className="mt-2"
			/>
		</fieldset>
	);
}

/**
 * Declarative FieldEditorComponent adapter.
 *
 * Empties and single-option drafts collapse to `undefined`; the
 * single-select / multi-select schemas declare `.min(2)` on
 * `options`, so any smaller list would fail re-validation on the
 * next write. Treating `undefined` as "not set yet" is the only
 * round-trip-safe value for a sub-minimum draft — the reducer
 * interprets it as a removal patch.
 *
 * The `as F["options" & keyof F]` cast is needed because the generic
 * `onChange(next: F[K])` is an indexed-access write; every kind that
 * declares `options` carries it as `SelectOption[] | undefined`, so
 * both branches are valid values at runtime.
 */
export function OptionsEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "options" & keyof F>,
) {
	const { value, onChange, autoFocus } = props;
	const current = Array.isArray(value) ? (value as SelectOption[]) : [];
	return (
		<div data-field-id="options">
			<OptionsEditorWidget
				options={current}
				autoFocus={autoFocus}
				onSave={(next) => {
					// Enforce the schema's `min(2)` at the adapter boundary —
					// any sub-minimum draft becomes `undefined` (removal patch).
					const persisted =
						next.length >= 2 ? next : (undefined as SelectOption[] | undefined);
					onChange(persisted as F["options" & keyof F]);
				}}
			/>
		</div>
	);
}
