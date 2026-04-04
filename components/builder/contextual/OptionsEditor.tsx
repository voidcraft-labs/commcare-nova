"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useId, useRef, useState } from "react";
import { AddPropertyButton } from "./AddPropertyButton";

interface Option {
	value: string;
	label: string;
}

/**
 * Draft option with a stable identity for React key management.
 * The `id` is component-local and never persisted — it exists purely
 * so that reordering or editing doesn't cause React to lose input state.
 */
interface DraftOption extends Option {
	id: number;
}

interface OptionsEditorProps {
	options: Option[];
	onSave: (options: Option[]) => void;
}

/** Counter for generating monotonically increasing draft IDs. */
let nextDraftId = 0;

/** Wrap raw options with stable draft IDs. */
function toDraftOptions(options: Option[]): DraftOption[] {
	return options.map((o) => ({ ...o, id: nextDraftId++ }));
}

/** Strip draft IDs before persisting. */
function toOptions(draft: DraftOption[]): Option[] {
	return draft.map(({ value, label }) => ({ value, label }));
}

export function OptionsEditor({ options, onSave }: OptionsEditorProps) {
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
								ref={focusIndex === i ? (el) => el?.focus() : undefined}
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
