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
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useStableListIdentity } from "@/components/builder/shared/useStableListIdentity";
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
	useMappingRemovalFocus,
} from "./mappingChrome";

interface IdMappingCardProps {
	readonly value: Extract<Column, { kind: "id-mapping" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function IdMappingCard({ value, onChange, errors }: IdMappingCardProps) {
	const { rootRef, removeWithFocus } = useMappingRemovalFocus();
	const rowIdentity = useStableListIdentity(value.mapping);
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
		const next = value.mapping.map((entry, entryIndex) =>
			entryIndex === index ? { ...entry, ...patch } : entry,
		);
		rowIdentity.stage(next, { kind: "replace" });
		setMapping(next);
	};

	const removeEntry = (index: number) => {
		const next = value.mapping.filter((_, i) => i !== index);
		rowIdentity.stage(next, {
			kind: "splice",
			index,
			deleteCount: 1,
			insertCount: 0,
		});
		setMapping(next);
	};

	const moveEntry = (from: number, to: number) => {
		// Bounds check — the buttons disable at the boundaries, but
		// the guard catches any caller that bypasses the disabled
		// state (programmatic test invocations, keyboard sequencing).
		if (to < 0 || to >= value.mapping.length || from === to) return;
		const next = [...value.mapping];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		rowIdentity.stage(next, {
			kind: "move",
			fromIndex: from,
			toIndex: to,
		});
		setMapping(next);
	};

	const appendEntry = () => {
		const next = [...value.mapping, idMappingEntry("", "")];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.mapping.length,
			deleteCount: 0,
			insertCount: 1,
		});
		setMapping(next);
	};

	return (
		<div className="space-y-4">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				errors={errors}
			/>
			<div ref={rootRef} className="space-y-3 [&_input]:!text-[14px]">
				<MappingSectionLabel />
				{value.mapping.length === 0 && (
					<MappingEmptyNotice>
						Without replacements, values appear as saved
					</MappingEmptyNotice>
				)}
				{value.mapping.map((entry, i) => (
					<MappingRow
						// Clone-safe sidecar identity preserves same-slot edits,
						// moves with reorders, and mints only for true inserts. Row
						// drafts follow their authored entry, not array position.
						key={rowIdentity.keys[i]}
						index={i}
						entry={entry}
						isFirst={i === 0}
						isLast={i === value.mapping.length - 1}
						onUpdate={(patch) => updateEntry(i, patch)}
						onRemove={() => removeWithFocus(i, () => removeEntry(i))}
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
			<div className="grid grid-cols-1 gap-3">
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Saved value</div>
					<BlurCommitTextInput
						value={entry.value}
						onCommit={(next) => onUpdate({ value: next })}
						ariaLabel={`Value ${index + 1} saved value`}
					/>
				</div>
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Label shown</div>
					{/* Both sides use ordinary body type. A stored value can be
					 *  human-readable data, so Nova does not style it like code. */}
					<BlurCommitTextInput
						value={entry.label}
						onCommit={(next) => onUpdate({ label: next })}
						ariaLabel={`Value ${index + 1} display label`}
					/>
				</div>
			</div>
		</MappingRowShell>
	);
}
