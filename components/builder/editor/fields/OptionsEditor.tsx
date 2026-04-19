/**
 * OptionsEditor — declarative editor for the `options` array on
 * single-select / multi-select fields.
 *
 * Public surface:
 *   - `OptionsEditor` (default export shape for the declarative
 *     panel) — takes FieldEditorComponentProps and dispatches via
 *     `onChange`.
 *   - `OptionsEditorWidget` — the underlying fieldset widget with the
 *     `{ options, onSave }` shape. Kept exported during the panel
 *     transition so the legacy contextual panel can reuse it; will
 *     be inlined as a private helper once that panel is deleted.
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
 * so that reordering or editing doesn't cause React to lose input state.
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

/** Stable ref callback that focuses the element on mount. Defined at module
 *  scope so React doesn't see a new function identity each render. */
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
 * Low-level widget: renders the label+value inputs, add/remove row
 * affordances, and commits on group blur / Enter keypress. Kept
 * distinct from the declarative adapter so ContextualEditorData can
 * consume it with the legacy `{ options, onSave }` shape during the
 * phase-5 transition.
 */
export function OptionsEditorWidget({
	options,
	onSave,
	autoFocus,
}: OptionsEditorWidgetProps) {
	const [draft, setDraft] = useState<DraftOption[]>(() =>
		toDraftOptions(options),
	);
	const [focusIndex, setFocusIndex] = useState<number | null>(null);
	const groupLabelId = useId();

	/* Sync draft state when props change externally (e.g. undo, tool call). */
	const optionsKey = JSON.stringify(options);
	const prevKeyRef = useRef(optionsKey);
	if (optionsKey !== prevKeyRef.current) {
		prevKeyRef.current = optionsKey;
		setDraft(toDraftOptions(options));
		setFocusIndex(null);
	}

	/** Commit current draft to parent, stripping empty rows. */
	const commit = useCallback(
		(updated: DraftOption[]) => {
			const cleaned = toOptions(updated).filter(
				(o) => o.label.trim() || o.value.trim(),
			);
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

	/** Commit when focus leaves the entire option group. */
	const handleBlur = useCallback(
		(e: React.FocusEvent) => {
			const container = e.currentTarget;
			requestAnimationFrame(() => {
				if (!container.contains(document.activeElement)) {
					commit(draft);
					setFocusIndex(null);
				}
			});
		},
		[draft, commit],
	);

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
 * Declarative FieldEditorComponent adapter. Narrows the generic
 * onChange(next: F[K]) to the widget's SelectOption[] callback:
 * empty arrays become `undefined` (the reducer treats undefined as
 * removal, and `min(2)` in the schema would reject a persisted `[]`).
 *
 * The `as F["options" & keyof F]` cast is the registry-narrowing
 * invariant — this component is only wired on kinds whose `options`
 * key is declared as `SelectOption[] | undefined`.
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
					onChange(
						(next.length > 0 ? next : undefined) as F["options" & keyof F],
					);
				}}
			/>
		</div>
	);
}
