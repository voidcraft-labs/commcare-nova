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
// disproportionate to the gain. Manual buttons fit the use case
// cleanly.

"use client";
import { nodeId } from "@/components/builder/shared/nodeIdentity";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import {
	type Column,
	type IdMappingEntry,
	idMappingColumn,
	idMappingEntry,
} from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";
import {
	AddMappingButton,
	MappingEmptyNotice,
	MappingRowShell,
	MappingSectionLabel,
} from "./mappingChrome";

interface IdMappingCardProps {
	readonly value: Extract<Column, { kind: "id-mapping" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function IdMappingCard({ value, onChange, errors }: IdMappingCardProps) {
	const slots = {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
		listOrder: value.listOrder,
		detailOrder: value.detailOrder,
	};
	const setField = (next: string) =>
		onChange(
			idMappingColumn(value.uuid, next, value.header, value.mapping, slots),
		);
	const setHeader = (next: string) =>
		onChange(
			idMappingColumn(value.uuid, value.field, next, value.mapping, slots),
		);
	const setMapping = (next: readonly IdMappingEntry[]) =>
		onChange(
			idMappingColumn(value.uuid, value.field, value.header, next, slots),
		);

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
		setMapping([...value.mapping, idMappingEntry("", "")]);
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
				<MappingSectionLabel />
				{value.mapping.length === 0 && (
					<MappingEmptyNotice>
						No entries yet — values show exactly as they're stored.
					</MappingEmptyNotice>
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
				<AddMappingButton onClick={appendEntry} />
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

/** One mapping row: value + label inputs in the shared row shell.
 *  Both inputs use the same blur-commit pattern as
 *  `BlurCommitTextInput` — local draft + late commit. */
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
		<MappingRowShell
			index={index}
			isFirst={isFirst}
			isLast={isLast}
			onMoveUp={onMoveUp}
			onMoveDown={onMoveDown}
			onRemove={onRemove}
		>
			<div className="grid grid-cols-2 gap-2">
				<div>
					<div className="mb-1.5 text-[11px] font-medium text-nova-text-muted">
						Saved value
					</div>
					<BlurCommitTextInput
						value={entry.value}
						onCommit={(next) => onUpdate({ value: next })}
						placeholder="Property value"
						ariaLabel={`Value rule ${index + 1} saved value`}
						monospace
					/>
				</div>
				<div>
					<div className="mb-1.5 text-[11px] font-medium text-nova-text-muted">
						Show as
					</div>
					{/* The `value` cell holds the wire-form code (monospace
					 *  matches the case-list-runtime's per-row value rendering);
					 *  the `label` cell holds display text rendered in the
					 *  case list's proportional font. Dropping `monospace`
					 *  here keeps the authoring surface visually congruent
					 *  with what the user sees at runtime. */}
					<BlurCommitTextInput
						value={entry.label}
						onCommit={(next) => onUpdate({ label: next })}
						placeholder="Display label"
						ariaLabel={`Value rule ${index + 1} display label`}
					/>
				</div>
			</div>
		</MappingRowShell>
	);
}
