// components/builder/case-list-config/tile/TileGroupingSection.tsx
//
// Grouping, on the tile canvas: show the cases that share a connection
// together, under one heading drawn from the first of them.
//
// Two things this surface has to say out loud, because neither is
// visible from the arrangement:
//
//   1. **A group is one choice.** Web Apps keeps only the group's first
//      case in the rendered collection
//      (`views.js::CaseTileGroupedListView.initialize`), so the rows
//      beneath the heading carry no id and no handler and choosing
//      anywhere in the group opens that first case. Nova shows what the
//      device does rather than inventing per-row selection.
//   2. **Cases with no such connection land in one group.** The device
//      evaluates the connection to the empty string for them and treats
//      it as an ordinary key, so they cluster together. Which cases
//      those are is stored data, not document structure, so the commit
//      gate cannot speak to it: the surface MEASURES it and states the
//      consequence instead (`docs/plans/complex-app/00-contracts.md`
//      § What the commit gate may read). Measured, measured zero, and
//      not-yet-known stay three different sentences.
//
// The heading depth offers only depths that cut the tile cleanly —
// `tileGroupHeaderRowChoices`, the same arithmetic the validator refuses
// on — so an author never reaches a rejected commit to discover a depth
// was unavailable.

"use client";

import { useId, useRef, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	type CaseListConfig,
	type CaseTileGrouping,
	type CaseTileLayout,
	type CaseType,
	orderedColumns,
	type TileCell,
	tileCellFor,
	tileGroupHeaderRowChoices,
} from "@/lib/domain";
import { XML_ELEMENT_NAME_PATTERN } from "@/lib/domain/predicate/types";
import { useMissingConnectionCount } from "@/lib/preview/hooks/useCaseDataBinding";

/** What a new grouping starts as: the connection nearly every case list
 *  means, and the shallowest heading its tile can carry. */
const DEFAULT_CONNECTION = "parent";

export function TileGroupingSection({
	config,
	tile,
	caseType,
	appId,
	onGroupingChange,
}: {
	readonly config: CaseListConfig;
	readonly tile: CaseTileLayout;
	readonly caseType: CaseType | undefined;
	readonly appId: string;
	readonly onGroupingChange: (next: CaseTileGrouping | undefined) => void;
}) {
	const grouping = tile.grouping;
	// The cells the tile SHOWS. `tileCellFor` is the one decision about
	// that, shared with both emitters: a hidden, order-driving column
	// keeps a stored cell but is not on the tile, so it must not widen
	// this arithmetic either.
	const cells: TileCell[] = orderedColumns(config, "list").flatMap((column) => {
		const cell = tileCellFor(column, tile);
		return cell === undefined ? [] : [cell];
	});
	const choices = tileGroupHeaderRowChoices(cells);

	if (choices.length === 0 && grouping === undefined) {
		return (
			<p className="text-[13px] leading-relaxed text-nova-text-muted">
				To group cases, the tile needs a line across it that no field crosses,
				with something above the line and something below it. Move or resize a
				field to open one up.
			</p>
		);
	}

	return (
		<div className="space-y-3">
			<ToggleRow
				label="Group cases under a connected case"
				description="Cases that share a connection appear together, under one heading."
				checked={grouping !== undefined}
				onChange={(on) =>
					onGroupingChange(
						on
							? {
									identifier: DEFAULT_CONNECTION,
									headerRows: choices[0] ?? 1,
								}
							: undefined,
					)
				}
			/>
			{grouping !== undefined && (
				<div className="space-y-4 rounded-lg border border-white/[0.04] bg-nova-deep/30 px-3 py-3">
					<ConnectionNameField
						value={grouping.identifier}
						caseType={caseType}
						onCommit={(identifier) =>
							onGroupingChange({ ...grouping, identifier })
						}
					/>
					<HeadingDepthField
						value={grouping.headerRows}
						choices={choices}
						onChange={(headerRows) =>
							onGroupingChange({ ...grouping, headerRows })
						}
					/>
					<p className="text-[13px] leading-relaxed text-nova-text-muted">
						Choosing a group opens its first case. The rows below the heading
						are there to read.
					</p>
					<div className="text-[13px] leading-relaxed text-nova-text-muted">
						<p>
							Cases with no {grouping.identifier} connection appear together in
							one group.
						</p>
						<MissingConnectionCount
							appId={appId}
							caseType={caseType?.name}
							identifier={grouping.identifier}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The saved name of the connection to group by, the same field
 * `shared/primitives/RelationPathBuilder.tsx` uses for the same thing,
 * so grouping coins no second word for it. Committed on blur or Enter,
 * abandoned on Escape, and never committed while malformed: the name is
 * written straight into the grouping expression, so its shape is what
 * makes that expression total.
 */
function ConnectionNameField({
	value,
	caseType,
	onCommit,
}: {
	readonly value: string;
	readonly caseType: CaseType | undefined;
	readonly onCommit: (next: string) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(value);
	const skipNextBlurCommit = useRef(false);
	const normalized = draft.trim();
	const valid = XML_ELEMENT_NAME_PATTERN.test(normalized);
	const guidanceId = `${id}-guidance`;
	const errorId = `${id}-error`;
	const commit = () => {
		if (!valid || normalized === value) {
			setDraft(value);
			return;
		}
		setDraft(normalized);
		onCommit(normalized);
	};
	const parentType = caseType?.parent_type;

	return (
		<Field>
			<FieldLabel htmlFor={id}>Connection name</FieldLabel>
			<Input
				id={id}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					if (skipNextBlurCommit.current) {
						skipNextBlurCommit.current = false;
						return;
					}
					commit();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						skipNextBlurCommit.current = true;
						commit();
						event.currentTarget.blur();
					} else if (event.key === "Escape") {
						event.preventDefault();
						skipNextBlurCommit.current = true;
						setDraft(value);
						event.currentTarget.blur();
					}
				}}
				autoComplete="off"
				data-1p-ignore
				aria-invalid={!valid}
				aria-describedby={valid ? guidanceId : `${guidanceId} ${errorId}`}
				className="h-11"
			/>
			<FieldDescription id={guidanceId}>
				{parentType === undefined
					? "Use the saved name that distinguishes this connection, such as parent or host"
					: `Use the saved name that distinguishes this connection. These cases are connected to ${parentType} through parent.`}
			</FieldDescription>
			{!valid && (
				<p id={errorId} role="alert" className="text-sm text-nova-rose">
					Start with a letter or underscore, then use only letters, numbers, and
					underscores
				</p>
			)}
		</Field>
	);
}

/**
 * How many of the tile's top rows the heading takes. Only depths that
 * cut the tile cleanly are offered: a depth that split a field would be
 * refused at commit, and a field split across the line is drawn wholly
 * in the heading, from the group's first case, so every other case's
 * value in it would disappear.
 */
function HeadingDepthField({
	value,
	choices,
	onChange,
}: {
	readonly value: number;
	readonly choices: readonly number[];
	readonly onChange: (next: number) => void;
}) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>Rows in the heading</FieldLabel>
			<Select
				value={String(value)}
				onValueChange={(next) => {
					const parsed = Number(next);
					if (Number.isInteger(parsed) && parsed !== value) onChange(parsed);
				}}
			>
				<SelectTrigger
					id={id}
					aria-label="Rows in the heading"
					className="h-11 w-full"
				>
					<SelectValue>{rowLabel(value)}</SelectValue>
				</SelectTrigger>
				<SelectContent align="start">
					{choices.map((choice) => (
						<SelectItem key={choice} value={String(choice)}>
							{rowLabel(choice)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<FieldDescription>
				The top rows are drawn once for the whole group, from its first case.
				The rows below them are drawn for every case.
			</FieldDescription>
		</Field>
	);
}

function rowLabel(rows: number): string {
	return rows === 1 ? "Top row" : `Top ${rows} rows`;
}

/**
 * The measured population with no such connection. Three distinct
 * sentences, never collapsed: a measured number, a measured zero, and
 * a not-yet-known. Rendering an unknown as zero would tell an author
 * their data is clean when nothing has counted it.
 */
function MissingConnectionCount({
	appId,
	caseType,
	identifier,
}: {
	readonly appId: string;
	readonly caseType: string | undefined;
	readonly identifier: string;
}) {
	const { state } = useMissingConnectionCount({ appId, caseType, identifier });
	if (state.kind === "count") {
		return (
			<p className="mt-1">
				{state.count === 0
					? `Every case has a ${identifier} connection right now.`
					: `${state.count.toLocaleString()} ${state.count === 1 ? "case has" : "cases have"} no ${identifier} connection right now.`}
			</p>
		);
	}
	if (state.kind === "error" || state.kind === "unauthenticated") {
		return (
			<p className="mt-1">
				How many cases have no {identifier} connection is not available right
				now.
			</p>
		);
	}
	return <p className="mt-1">Counting the cases with no connection.</p>;
}
