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
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { nodeId } from "@/components/builder/shared/nodeIdentity";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import {
	type Column,
	type ImageMapEntry,
	imageMapColumn,
	imageMapEntry,
} from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

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
	const slots = {
		sort: value.sort,
		visibleInList: value.visibleInList,
		visibleInDetail: value.visibleInDetail,
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
		const next = value.mapping.map((entry, i) =>
			i === index ? { ...entry, ...patch } : entry,
		);
		setMapping(next);
	};

	const removeEntry = (index: number) => {
		setMapping(value.mapping.filter((_, i) => i !== index));
	};

	const moveEntry = (from: number, to: number) => {
		// Bounds check — the buttons disable at the boundaries, but the
		// guard catches callers that bypass the disabled state.
		if (to < 0 || to >= value.mapping.length || from === to) return;
		const next = [...value.mapping];
		const [moved] = next.splice(from, 1);
		next.splice(to, 0, moved);
		setMapping(next);
	};

	const appendEntry = () => {
		// Seed an empty row — value blank, no image yet. The row's
		// `SingleAssetSlot` shows the "+ Image" pill until the author
		// picks one; the schema's required `assetId` keeps the column
		// flagged incomplete (via the validity propagator) until then.
		setMapping([...value.mapping, imageMapEntry("", "")]);
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
						No entries — rows render no image until you map a value to one.
					</div>
				)}
				{value.mapping.map((entry, i) => (
					<MappingRow
						// Per-entry identity from `nodeId(entry)` — the same
						// WeakMap-backed reference-identity scheme `IdMappingCard`
						// uses, so a remove of an earlier row doesn't shift another
						// row's draft into its slot.
						key={nodeId(entry)}
						index={i}
						entry={entry}
						// Staged-upload identity: the column's uuid + the row's
						// position. Positional because a mapping entry has no stable
						// id of its own; the rows are short, authored once, and
						// rarely reordered mid-upload.
						slotKey={`imagemap:${value.uuid}:${i}`}
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

/** One mapping row: a value input + an image slot, with up / down /
 *  remove controls. The value input uses the shared blur-commit
 *  pattern; the image slot is the standalone `SingleAssetSlot` (pick /
 *  preview / replace / clear) bound to the entry's `assetId`. */
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
					<BlurCommitTextInput
						value={entry.value}
						onCommit={(next) => onUpdate({ value: next })}
						placeholder="Property value"
						ariaLabel={`Mapping ${index + 1} value`}
						monospace
					/>
				</div>
				<div>
					<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
						Image
					</div>
					{/* `assetId` is stored as a string; an empty string is the
					 *  unfilled state (slot shows the "+ Image" pill). Clearing
					 *  maps `undefined` back to "" so the row stays present. */}
					<SingleAssetSlot
						value={entry.assetId || undefined}
						onChange={(next) => onUpdate({ assetId: next ?? "" })}
						kind="image"
						slotKey={slotKey}
						ariaLabel={`Mapping ${index + 1} image`}
					/>
				</div>
			</div>
		</div>
	);
}
