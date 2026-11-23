// components/builder/case-list-config/cards/column/ImageMapColumnCard.tsx
//
// Renders the `image-map` Column kind: looks up an IMAGE for each
// property value via an explicitly-authored value→image table (the
// image analogue of `id-mapping`). The runtime renders the matched
// image; no entry matches => no image. Used for case-row status icons
// driven by a case property's value (e.g. a triage-color swatch).
//
// Slots:
//   - `field`: case-property name (same shape as id-mapping).
//   - `header`: column display label.
//   - `mapping`: variadic list of `{ value, assetId }` entries. Order
//     is significant: the runtime renders the first matching entry, so
//     authors place more-specific values above more-general ones.
//
// Mirrors `IdMappingCard` exactly except each row's display cell is an
// image `SingleAssetSlot` (pick / replace / clear) instead of a text
// label input. Move-up / move-down (not drag-and-drop) for the same
// reason id-mapping uses them: tables are short and authored once.

"use client";
import { useState } from "react";
import { v4 } from "uuid";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { SingleAssetSlot } from "@/components/builder/media/MediaSlot";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useStableListIdentity } from "@/components/builder/shared/useStableListIdentity";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	type Column,
	type ImageMapEntry,
	imageMapEntry,
	type MediaAssetId,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { columnWithSource } from "../../columnSources";
import { ColumnFieldRow } from "./ColumnFieldRow";
import { MappingSourceEditor } from "./MappingSourceEditor";
import {
	AddMappingButton,
	MappingEmptyNotice,
	MappingOrderNote,
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
	ctx,
	errors,
}: ImageMapColumnCardProps) {
	const { rootRef, removeWithFocus } = useMappingRemovalFocus();
	const rowIdentity = useStableListIdentity(value.mapping);
	const [adding, setAdding] = useState(false);
	const [pendingValue, setPendingValue] = useState("");
	const setField = (field: string) => onChange({ ...value, field });
	const setHeader = (header: string) => onChange({ ...value, header });
	const setMapping = (mapping: readonly ImageMapEntry[]) =>
		onChange({ ...value, mapping: [...mapping] });

	const updateEntry = (
		index: number,
		patch: Partial<ImageMapEntry>,
	): string | null => {
		const next = value.mapping.map((entry, entryIndex) =>
			entryIndex === index
				? (Object.fromEntries(
						Object.entries({ ...entry, ...patch }).filter(
							([, v]) => v !== undefined,
						),
					) as ImageMapEntry)
				: entry,
		);
		const issue = next[index].when
			? null
			: imageMapValueIssue(next[index].value ?? "", next, index);
		if (issue !== null) return issue;
		rowIdentity.stage(next, { kind: "replace" });
		setMapping(next);
		return null;
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
		// Bounds check: the buttons disable at the boundaries, but the
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

	const appendEntry = (assetId?: MediaAssetId) => {
		if (imageMapValueIssue(pendingValue, value.mapping, -1)) {
			return;
		}
		const next = [
			...value.mapping,
			{
				...imageMapEntry(pendingValue, assetId),
				uuid: asUuid(v4()),
			},
		];
		rowIdentity.stage(next, {
			kind: "splice",
			index: value.mapping.length,
			deleteCount: 0,
			insertCount: 1,
		});
		setMapping(next);
		setPendingValue("");
		setAdding(false);
	};
	const pendingValueIssue = imageMapValueIssue(pendingValue, value.mapping, -1);

	return (
		<div className="space-y-4">
			<ColumnFieldRow
				via={value.via}
				readFrom={value.readFrom}
				showOwner={value.showOwner}
				onSourceChange={(via, field, readFrom, showOwner) =>
					onChange(columnWithSource(value, via, field, readFrom, showOwner))
				}
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
						ctx={ctx}
						column={value}
						// Clone-safe sidecar identity preserves same-slot edits,
						// moves with reorders, and mints only for true inserts. Row
						// draft and media state follow the authored entry.
						key={entry.uuid ?? rowIdentity.keys[i]}
						index={i}
						entry={entry}
						// Keep an in-flight picker/upload bound to this entry even
						// when the author reorders the mapping while it is open.
						slotKey={`imagemap:${value.uuid}:${entry.uuid ?? rowIdentity.keys[i]}`}
						isFirst={i === 0}
						isLast={i === value.mapping.length - 1}
						onUpdate={(patch) => updateEntry(i, patch)}
						onRemove={() => removeWithFocus(i, () => removeEntry(i))}
						onMoveUp={() => moveEntry(i, i - 1)}
						onMoveDown={() => moveEntry(i, i + 1)}
					/>
				))}
				{adding ? (
					<MappingRowShell
						index={value.mapping.length}
						isFirst
						isLast
						onMoveUp={() => undefined}
						onMoveDown={() => undefined}
						onRemove={() => {
							setPendingValue("");
							setAdding(false);
						}}
					>
						<div className="grid grid-cols-1 gap-3">
							<div>
								<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Saved value</div>
								<Input
									type="text"
									value={pendingValue}
									onChange={(event) => setPendingValue(event.target.value)}
									aria-label={`Value ${value.mapping.length + 1} saved value`}
									autoComplete="off"
									data-1p-ignore
								/>
							</div>
							<div>
								<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Image shown</div>
								{pendingValueIssue === null ? (
									<>
										<SingleAssetSlot
											value={undefined}
											onChange={(assetId) => {
												if (assetId) appendEntry(assetId);
											}}
											kind="image"
											slotKey={`imagemap:${value.uuid}:new`}
											ariaLabel={`Value ${value.mapping.length + 1} image`}
										/>
										<Button
											type="button"
											variant="ghost"
											onClick={() => appendEntry()}
										>
											Show no image
										</Button>
									</>
								) : (
									<p className="text-[13px] leading-relaxed text-nova-text-muted">
										{pendingValueIssue}
									</p>
								)}
							</div>
						</div>
					</MappingRowShell>
				) : (
					<AddMappingButton onClick={() => setAdding(true)} />
				)}
				{ctx.ordersByMapping === true && <MappingOrderNote />}
			</div>
		</div>
	);
}

interface MappingRowProps {
	readonly ctx: ColumnEditContext;
	readonly column: Extract<Column, { kind: "image-map" }>;
	readonly index: number;
	readonly entry: ImageMapEntry;
	/** Staged-upload identity for this row's image slot. */
	readonly slotKey: string;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onUpdate: (patch: Partial<ImageMapEntry>) => string | null;
	readonly onRemove: () => void;
	readonly onMoveUp: () => void;
	readonly onMoveDown: () => void;
}

/** One mapping row: a value input + an image slot in the shared row
 *  shell. The value input uses the shared blur-commit pattern; the
 *  image slot is the standalone `SingleAssetSlot` (pick / preview /
 *  replace / clear) bound to the entry's `assetId`. */
function MappingRow({
	ctx,
	column,
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
				<MappingSourceEditor
					column={column}
					row={entry}
					index={index}
					ctx={ctx}
					onChange={onUpdate}
				/>
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Image description</div>
					<BlurCommitTextInput
						value={entry.altText ?? ""}
						ariaLabel={`Value ${index + 1} image description`}
						onCommit={(next) => {
							onUpdate({ altText: next });
						}}
					/>
				</div>
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Image shown</div>
					<SingleAssetSlot
						value={entry.assetId}
						onChange={(next) => {
							onUpdate({ assetId: next ?? undefined });
						}}
						kind="image"
						slotKey={slotKey}
						ariaLabel={`Value ${index + 1} image`}
					/>
				</div>
			</div>
		</MappingRowShell>
	);
}

function imageMapValueIssue(
	candidate: string,
	entries: readonly ImageMapEntry[],
	candidateIndex: number,
): string | null {
	return entries.some(
		(entry, index) =>
			index !== candidateIndex &&
			entry.value === candidate &&
			entry.match === entries[candidateIndex]?.match,
	)
		? "That saved value already has an image."
		: null;
}
