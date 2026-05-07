// components/builder/case-list-config/cards/column/IdMappingCard.tsx
//
// Renders the `id-mapping` Column kind — looks up a label for
// each property value via an explicitly-authored value→label
// table. The runtime renders the matched label or falls back to
// the raw value when no mapping entry matches.
//
// Slots:
//   - `field` — case-property name. Accepts every property type;
//     authors typically use this with `single_select` /
//     `multi_select` / `text` codes.
//   - `header` — column display label.
//   - `mapping` — variadic list of `{ value, label }` entries.
//     Order is significant: the runtime walks the list top-to-
//     bottom and renders the first match, so authors can place
//     more-specific entries above more-general ones.
//
// Why move-up / move-down (not drag-and-drop): mapping tables
// are typically 2-10 entries authored once. The complexity of
// pragmatic-drag-and-drop's monitor + per-row preview wiring is
// disproportionate to the gain — and the existing
// `useReorderableExpressionList` hook is typed to a closed set
// of expression-side container kinds (`concat` / `coalesce` /
// `switch`). Extending that union with `"id-mapping"` would couple
// the column-side editor to an expression-side hook for a
// secondary use case. Manual buttons fit the use case cleanly.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Column, IdMappingEntry } from "@/lib/domain";
import { idMappingColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { nodeId } from "../../nodeIdentity";
import { ColumnFieldRow } from "./ColumnFieldRow";

interface IdMappingCardProps {
	readonly value: Extract<Column, { kind: "id-mapping" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function IdMappingCard({ value, onChange, errors }: IdMappingCardProps) {
	const setField = (next: string) =>
		onChange(idMappingColumn(next, value.header, value.mapping));
	const setHeader = (next: string) =>
		onChange(idMappingColumn(value.field, next, value.mapping));
	const setMapping = (next: readonly IdMappingEntry[]) =>
		onChange(idMappingColumn(value.field, value.header, next));

	const updateEntry = (index: number, patch: Partial<IdMappingEntry>) => {
		const next = value.mapping.map((entry, i) =>
			i === index ? { ...entry, ...patch } : entry,
		);
		setMapping(next);
	};

	const removeEntry = (index: number) => {
		setMapping(value.mapping.filter((_, i) => i !== index));
	};

	const moveEntry = (from: number, to: number) => {
		// Bounds check — the buttons disable at the boundaries, but
		// the guard catches any caller that bypasses the disabled
		// state (programmatic test invocations, keyboard sequencing).
		if (to < 0 || to >= value.mapping.length || from === to) return;
		const next = [...value.mapping];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setMapping(next);
	};

	const appendEntry = () => {
		setMapping([...value.mapping, { value: "", label: "" }]);
	};

	return (
		<div className="space-y-2">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				errors={errors}
			/>
			<div className="space-y-1.5">
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
					Mapping
				</div>
				{value.mapping.length === 0 && (
					<div className="text-[11px] leading-snug text-nova-text-muted/70 italic px-2 py-1.5 rounded-md border border-dashed border-white/[0.06] bg-nova-deep/30">
						No entries — values render as their raw text until you add a
						mapping.
					</div>
				)}
				{value.mapping.map((entry, i) => (
					<MappingRow
						// Per-entry identity from `nodeId(entry)` —
						// `nodeIdentity.ts` keeps a `WeakMap<object, string>`
						// allocating a stable id on first lookup. The reorder
						// path produces new arrays whose entry references are
						// reused verbatim (the spread + splice on
						// `value.mapping` keeps each entry's reference identity);
						// remove drops the reference and the WeakMap entry is
						// collected. Each row's local draft state is keyed by
						// the entry's reference identity, so a remove of an
						// earlier row doesn't shift another row's draft into
						// its slot.
						key={nodeId(entry)}
						index={i}
						entry={entry}
						isFirst={i === 0}
						isLast={i === value.mapping.length - 1}
						onUpdate={(patch) => updateEntry(i, patch)}
						onRemove={() => removeEntry(i)}
						onMoveUp={() => moveEntry(i, i - 1)}
						onMoveDown={() => moveEntry(i, i + 1)}
					/>
				))}
				<button
					type="button"
					onClick={appendEntry}
					className="inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
				>
					<Icon icon={tablerPlus} width="11" height="11" />
					<span>Add mapping</span>
				</button>
			</div>
		</div>
	);
}

interface MappingRowProps {
	readonly index: number;
	readonly entry: IdMappingEntry;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onUpdate: (patch: Partial<IdMappingEntry>) => void;
	readonly onRemove: () => void;
	readonly onMoveUp: () => void;
	readonly onMoveDown: () => void;
}

/** One mapping row: value + label inputs, with up / down / remove
 *  controls. Both inputs use the same blur-commit pattern as
 *  `BlurCommitTextInput` — local draft + late commit. Inlined here
 *  rather than reusing the shared helper because the row needs a
 *  tighter layout (two inputs side-by-side, smaller per-input
 *  padding to fit the row chrome) than the standard helper
 *  provides. */
function MappingRow({
	index,
	entry,
	isFirst,
	isLast,
	onUpdate,
	onRemove,
	onMoveUp,
	onMoveDown,
}: MappingRowProps) {
	return (
		<div className="rounded-md border border-white/[0.05] bg-nova-surface/30 px-2 py-2 space-y-1.5">
			<div className="flex items-center gap-1.5">
				<span className="text-[10px] uppercase tracking-wider text-nova-text-muted/80">
					Entry {index + 1}
				</span>
				<div className="flex-1" />
				<button
					type="button"
					aria-label="Move entry up"
					onClick={onMoveUp}
					disabled={isFirst}
					className="rounded p-0.5 text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
				>
					<Icon icon={tablerArrowUp} width="12" height="12" />
				</button>
				<button
					type="button"
					aria-label="Move entry down"
					onClick={onMoveDown}
					disabled={isLast}
					className="rounded p-0.5 text-nova-text-muted/60 hover:text-nova-violet-bright hover:bg-white/[0.05] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
				>
					<Icon icon={tablerArrowDown} width="12" height="12" />
				</button>
				<button
					type="button"
					aria-label="Remove entry"
					onClick={onRemove}
					className="rounded p-0.5 text-nova-text-muted/60 hover:text-nova-error hover:bg-white/[0.05] transition-colors cursor-pointer"
				>
					<Icon icon={tablerTrash} width="12" height="12" />
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Value
					</div>
					<MappingInput
						value={entry.value}
						placeholder="Property value"
						ariaLabel={`Mapping ${index + 1} value`}
						onCommit={(next) => onUpdate({ value: next })}
					/>
				</div>
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Label
					</div>
					<MappingInput
						value={entry.label}
						placeholder="Display label"
						ariaLabel={`Mapping ${index + 1} label`}
						onCommit={(next) => onUpdate({ label: next })}
					/>
				</div>
			</div>
		</div>
	);
}

interface MappingInputProps {
	readonly value: string;
	readonly placeholder: string;
	readonly ariaLabel: string;
	readonly onCommit: (next: string) => void;
}

/** Tight blur-commit text input scoped to the mapping row layout
 *  — slightly smaller chrome than `BlurCommitTextInput`. Same
 *  draft / commit handshake; the local draft holds the in-flight
 *  edit, the commit fires on blur, and the draft re-syncs to the
 *  external `value` only when the input isn't focused. */
function MappingInput({
	value,
	placeholder,
	ariaLabel,
	onCommit,
}: MappingInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		if (value !== draft && document.activeElement !== inputRef.current) {
			setDraft(value);
		}
	}, [value, draft]);
	const commit = useCallback(() => {
		if (draft === value) return;
		onCommit(draft);
	}, [draft, value, onCommit]);
	return (
		<input
			ref={inputRef}
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder={placeholder}
			aria-label={ariaLabel}
			className="w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text font-mono placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
		/>
	);
}
