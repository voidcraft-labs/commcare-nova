// components/builder/case-list-config/cards/column/IdMappingCard.tsx
//
// Renders the `id-mapping` Column kind: looks up a label for
// each property value via an explicitly-authored value→label
// table. The runtime renders mapped labels and leaves unmatched
// values blank, matching CommCare's enum display.
//
// Slots:
//   - `field`: case-property name. Accepts every property type;
//     authors typically use this with `single_select` /
//     `multi_select` / `text` codes.
//   - `header`: column display label.
//   - `mapping`: variadic list of `{ value, label }` entries.
//     Order is significant: the runtime walks the list top-to-
//     bottom and renders the first match, and the list orders the
//     column by entry position, so the table's order is the sort
//     order. A saved value can be blank or hold spaces. The five
//     characters CommCare HQ's ID mapping can't store (`&`, `<`,
//     `>`, `"`, `'`; the validator's
//     `CASE_LIST_ID_MAPPING_KEY_CHARACTERS`) are refused before staging.
//
// Why move-up / move-down (not drag-and-drop): mapping tables
// are typically 2-10 entries authored once. The complexity of
// pragmatic-drag-and-drop's monitor + per-row preview wiring is
// disproportionate to the gain. Manual buttons fit the use case
// cleanly.

"use client";
import { useState } from "react";
import { v4 } from "uuid";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useStableListIdentity } from "@/components/builder/shared/useStableListIdentity";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	type Column,
	type IdMappingEntry,
	idMappingEntry,
	idMappingValueHoldsForbiddenCharacter,
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

interface IdMappingCardProps {
	readonly value: Extract<Column, { kind: "id-mapping" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function IdMappingCard({
	value,
	onChange,
	ctx,
	errors,
}: IdMappingCardProps) {
	const { rootRef, removeWithFocus } = useMappingRemovalFocus();
	const rowIdentity = useStableListIdentity(value.mapping);
	const [adding, setAdding] = useState(false);
	const [pendingValue, setPendingValue] = useState("");
	const [pendingLabel, setPendingLabel] = useState("");
	const setField = (field: string) => onChange({ ...value, field });
	const setHeader = (header: string) => onChange({ ...value, header });
	const setMapping = (mapping: readonly IdMappingEntry[]) =>
		onChange({ ...value, mapping: [...mapping] });

	const updateEntry = (
		index: number,
		patch: Partial<IdMappingEntry>,
	): string | null => {
		const next = value.mapping.map((entry, entryIndex) =>
			entryIndex === index
				? (Object.fromEntries(
						Object.entries({ ...entry, ...patch }).filter(
							([, v]) => v !== undefined,
						),
					) as IdMappingEntry)
				: entry,
		);
		const issue = next[index].when
			? null
			: mappingValueIssue(next[index].value ?? "", next, index, value.behavior);
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
		// Bounds check: the buttons disable at the boundaries, but
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
		const issue = mappingValueIssue(
			pendingValue,
			value.mapping,
			value.mapping.length,
			value.behavior,
		);
		if (issue !== null) return;
		const next = [
			...value.mapping,
			{
				...idMappingEntry(pendingValue, pendingLabel),
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
		setPendingLabel("");
		setAdding(false);
	};
	const pendingValueIssue = mappingValueIssue(
		pendingValue,
		value.mapping,
		value.mapping.length,
		value.behavior,
	);

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
			<div>
				<div className={INSPECTOR_LABEL_CLS}>Which labels to show</div>
				<Select
					value={value.behavior ?? "each"}
					onValueChange={(choice) => {
						if (!choice) return;
						const { behavior: _behavior, ...rest } = value;
						onChange(
							choice === "first-match"
								? { ...rest, behavior: "first-match" }
								: rest,
						);
					}}
				>
					<SelectTrigger aria-label="Which labels to show">
						<SelectValue>
							{value.behavior === "first-match"
								? "The first matching label"
								: "A label for each saved choice"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem
							value="each"
							disabled={value.mapping.some((row) => row.when)}
						>
							A label for each saved choice
						</SelectItem>
						<SelectItem value="first-match">
							The first matching label
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div ref={rootRef} className="space-y-3 [&_input]:!text-[14px]">
				<MappingSectionLabel />
				{value.mapping.length === 0 && (
					<MappingEmptyNotice>
						Add a saved value and label to show replacement text
					</MappingEmptyNotice>
				)}
				{value.mapping.map((entry, i) => (
					<MappingRow
						ctx={ctx}
						column={value}
						// Clone-safe sidecar identity preserves same-slot edits,
						// moves with reorders, and mints only for true inserts. Row
						// drafts follow their authored entry, not array position.
						key={entry.uuid ?? rowIdentity.keys[i]}
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
				{adding ? (
					<MappingRowShell
						index={value.mapping.length}
						isFirst
						isLast
						onMoveUp={() => undefined}
						onMoveDown={() => undefined}
						onRemove={() => {
							setPendingValue("");
							setPendingLabel("");
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
									placeholder="Blank value"
									autoComplete="off"
									data-1p-ignore
								/>
								{pendingValueIssue !== null ? (
									<p className="mt-1.5 text-[13px] leading-5 text-nova-rose">
										{pendingValueIssue}
									</p>
								) : null}
							</div>
							<div>
								<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Label shown</div>
								<Input
									type="text"
									value={pendingLabel}
									onChange={(event) => setPendingLabel(event.target.value)}
									aria-label={`Value ${value.mapping.length + 1} display label`}
									autoComplete="off"
									data-1p-ignore
								/>
							</div>
							<Button
								type="button"
								variant="secondary"
								disabled={pendingValueIssue !== null}
								onClick={appendEntry}
								className="w-full"
							>
								Save value
							</Button>
						</div>
					</MappingRowShell>
				) : (
					<AddMappingButton onClick={() => setAdding(true)} />
				)}
				{ctx.ordersByMapping === true && (
					<MappingOrderNote byLabel={value.behavior === "first-match"} />
				)}
			</div>
		</div>
	);
}

interface MappingRowProps {
	readonly ctx: ColumnEditContext;
	readonly column: Extract<Column, { kind: "id-mapping" }>;
	readonly index: number;
	readonly entry: IdMappingEntry;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onUpdate: (patch: Partial<IdMappingEntry>) => string | null;
	readonly onRemove: () => void;
	readonly onMoveUp: () => void;
	readonly onMoveDown: () => void;
}

/** One mapping row: value + label inputs in the shared row shell.
 *  Both inputs use the same blur-commit pattern as
 *  `BlurCommitTextInput`: local draft + late commit. */
function MappingRow({
	ctx,
	column,
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
				<MappingSourceEditor
					column={column}
					row={entry}
					index={index}
					ctx={ctx}
					onChange={onUpdate}
				/>
				<div>
					<div className={`mb-2 ${INSPECTOR_LABEL_CLS}`}>Label shown</div>
					{/* Both sides use ordinary body type. A stored value can be
					 *  human-readable data, so Nova does not style it like code. */}
					<BlurCommitTextInput
						value={entry.label}
						onCommit={(next) => {
							onUpdate({ label: next });
						}}
						ariaLabel={`Value ${index + 1} display label`}
					/>
				</div>
			</div>
		</MappingRowShell>
	);
}

function mappingValueIssue(
	candidate: string,
	entries: readonly IdMappingEntry[],
	candidateIndex: number,
	behavior?: "first-match",
): string | null {
	if (
		behavior !== "first-match" &&
		idMappingValueHoldsForbiddenCharacter(candidate)
	) {
		return "Saved values can't hold &, <, >, \" or '.";
	}
	return entries.some(
		(entry, index) => index !== candidateIndex && entry.value === candidate,
	)
		? "That saved value already has a label."
		: null;
}
