// components/builder/case-list-config/cards/column/ImageMapColumnCard.tsx
//
// Renders the `image-map` Column kind — looks up an IMAGE for each
// property value via an explicitly-authored value→image table (the
// image analogue of `id-mapping`). The runtime renders the matched
// image; no entry matches => no image. Used for case-row status icons
// driven by a case property's value (e.g. a triage-color swatch).
//
// Slots:
//   - `field` — case-property name (same shape as id-mapping).
//   - `header` — column display label.
//   - `mapping` — variadic list of `{ value, assetId }` entries. Order
//     is significant: the runtime renders the first matching entry, so
//     authors place more-specific values above more-general ones.
//
// Mirrors `IdMappingCard` exactly except each row's display cell is an
// image `SingleAssetSlot` (pick / replace / clear) instead of a text
// label input. Move-up / move-down (not drag-and-drop) for the same
// reason id-mapping uses them: tables are short and authored once.

"use client";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useStableListIdentity } from "@/components/builder/shared/useStableListIdentity";
import {
	type Column,
	type ImageMapEntry,
	imageMapColumn,
	imageMapEntry,
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

interface ImageMapColumnCardProps {
	readonly value: Extract<Column, { kind: "image-map" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function ImageMapColumnCard({
	value,
	onChange,
	errors,
}: ImageMapColumnCardProps) {
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
			imageMapColumn(value.uuid, next, value.header, value.mapping, slots),
		);
	const setHeader = (next: string) =>
		onChange(
			imageMapColumn(value.uuid, value.field, next, value.mapping, slots),
		);
	const setMapping = (next: readonly ImageMapEntry[]) =>
		onChange(
			imageMapColumn(value.uuid, value.field, value.header, next, slots),
		);

	const updateEntry = (index: number, patch: Partial<ImageMapEntry>) => {
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
		// Bounds check — the buttons disable at the boundaries, but the
		// guard catches callers that bypass the disabled state.
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
		// Seed an empty row — value blank, no image yet. The row's
		// `SingleAssetSlot` shows the "+ Image" pill until the author
		// picks one; the schema's required `assetId` keeps the column
		// flagged incomplete (via the validity propagator) until then.
		const next = [...value.mapping, imageMapEntry("", "")];
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
						Add a value and image to show images in this field
					</MappingEmptyNotice>
				)}
				{value.mapping.map((entry, i) => (
					<MappingRow
						// Clone-safe sidecar identity preserves same-slot edits,
						// moves with reorders, and mints only for true inserts. Row
						// draft and media state follow the authored entry.
						key={rowIdentity.keys[i]}
						index={i}
						entry={entry}
						// Keep an in-flight picker/upload bound to this entry even
						// when the author reorders the mapping while it is open.
						slotKey={`imagemap:${value.uuid}:${rowIdentity.keys[i]}`}
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
	readonly entry: ImageMapEntry;
	/** Staged-upload identity for this row's image slot. */
	readonly slotKey: string;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onUpdate: (patch: Partial<ImageMapEntry>) => void;
	readonly onRemove: () => void;
	readonly onMoveUp: () => void;
	readonly onMoveDown: () => void;
}

/** One mapping row: a value input + an image slot in the shared row
 *  shell. The value input uses the shared blur-commit pattern; the
 *  image slot is the standalone `SingleAssetSlot` (pick / preview /
 *  replace / clear) bound to the entry's `assetId`. */
function MappingRow({
	index,
	entry,
	slotKey,
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
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Image shown</div>
					{/* `assetId` is stored as a string; an empty string is the
					 *  unfilled state (slot shows the "+ Image" pill). Clearing
					 *  maps `undefined` back to "" so the row stays present. */}
					<SingleAssetSlot
						value={entry.assetId || undefined}
						onChange={(next) => onUpdate({ assetId: next ?? "" })}
						kind="image"
						slotKey={slotKey}
						ariaLabel={`Value ${index + 1} image`}
					/>
				</div>
			</div>
		</MappingRowShell>
	);
}
