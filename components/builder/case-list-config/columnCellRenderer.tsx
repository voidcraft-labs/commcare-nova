// components/builder/case-list-config/columnCellRenderer.tsx
//
// Shared per-cell render helpers for the running case-list Preview. Edit mode
// composes labels and reading order without inventing a sample row; real case
// values reach this renderer only in Preview, where their full row context is
// available.
//
// Each column kind has its own render path. This is the running Preview, so
// interactions and formatting follow the same authored semantics Nova emits:
// phone values are actionable, date patterns use JavaRosa's supported tokens,
// and interval thresholds share the emitter's exact unit divisors.
//
// Calculated columns project their result through the case-store's
// `query` SELECT slot (under the optional `calculated` projection
// arg); the value lands on `row.calculated[col.uuid]` per the v2
// case-store contract. The dispatcher reads the slot and routes
// through `renderCalculatedCell`.

"use client";
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { Column } from "@/lib/domain";
import {
	type CalculatedTemporalType,
	type ColumnDisplayContext,
	isOpenableAddress,
	type PreviewFormattedValue,
	projectCalculatedValue,
	projectColumnDisplay,
} from "@/lib/preview/columnDisplay";
import { caseRowDisplayValue } from "@/lib/preview/engine/caseDataBindingClient";
import type {
	CalculatedValue,
	CaseRowWithCalculated,
} from "@/lib/preview/engine/caseDataBindingTypes";
/**
 * Render one column's cell for one row. Dispatches on the
 * column's `kind` discriminator; each branch handles the
 * authored shape with a best-effort runtime-mirroring format.
 *
 * The exhaustive `switch` forces a branch per kind: adding a
 * new column kind to the discriminated union surfaces here as a
 * type error first, not a silent rendering regression.
 *
 * Calculated arm reads `row.calculated[column.uuid]`: the case-
 * store's `query` keys results by the column's uuid (the wire-side
 * stable handle). Other arms read the case property named by
 * `column.field` via the shared display-value helper.
 */
export function renderColumnCell(
	column: Column,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): React.ReactNode {
	const displayed = projectColumnDisplay(column, row, context);
	if (column.kind === "link") {
		// The address is the raw property value, not the projected text —
		// which is the label. An empty property renders an empty cell rather
		// than a link to nowhere, matching what the emitted `if(… = '', '', …)`
		// guard does on the device.
		const address = caseRowDisplayValue(row, column.field).trim();
		return isOpenableAddress(address) ? (
			<a
				href={address}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex min-h-11 min-w-11 items-center text-nova-violet-bright underline decoration-current/50 underline-offset-2 [overflow-wrap:anywhere]"
			>
				{displayed.text}
			</a>
		) : address ? (
			// A value that is not a web address still shows, as text. The
			// property holds what a worker submitted, so the honest render
			// of an unopenable value is the value — never a dead link, and
			// never a blank cell that hides real case data.
			address
		) : (
			renderEmptyCell()
		);
	}
	if (column.kind === "phone") {
		const phoneNumber = displayed.text.trim();
		return phoneNumber ? (
			<a
				href={`tel:${phoneNumber}`}
				aria-label={`Call ${phoneNumber}`}
				className="inline-flex min-h-11 min-w-11 items-center text-nova-violet-bright underline decoration-current/50 underline-offset-2 [overflow-wrap:anywhere]"
			>
				{displayed.text}
			</a>
		) : (
			renderEmptyCell()
		);
	}
	return renderPreviewValue(displayed);
}

export function renderCalculatedCell(
	value: CalculatedValue | undefined,
	temporalType?: CalculatedTemporalType,
): React.ReactNode {
	return renderPreviewValue(projectCalculatedValue(value, temporalType));
}

function renderPreviewValue(value: PreviewFormattedValue): React.ReactNode {
	if (value.kind === "image") {
		return (
			<SimpleTooltip content={value.text}>
				<ProjectMediaImage
					assetId={value.assetId}
					alt={value.text}
					className="inline-block size-5 rounded-sm object-cover"
				/>
			</SimpleTooltip>
		);
	}
	if (value.kind === "value") {
		if (!value.text) return renderEmptyCell();
		return value.dateTime === undefined ? (
			<span>{value.text}</span>
		) : (
			<time dateTime={value.dateTime}>{value.text}</time>
		);
	}
	return (
		<Popover>
			<PopoverTrigger
				render={
					// The value itself is the affordance: a cell reads as its own
					// text, and a keycap around it would claim the row. The dotted
					// underline is what says there is more to see.
					<button
						type="button"
						className="nova-focusable inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center rounded-lg text-left underline decoration-nova-text-muted decoration-dotted [overflow-wrap:anywhere]"
					/>
				}
				aria-label={`${value.text}. More information`}
			>
				{value.text}
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64">
				<PopoverHeader>
					<PopoverTitle>Why this value is shown</PopoverTitle>
				</PopoverHeader>
				<PopoverDescription>{value.message}</PopoverDescription>
			</PopoverContent>
		</Popover>
	);
}

function renderEmptyCell(): React.ReactNode {
	return (
		<span>
			<span aria-hidden="true" className="text-nova-text-muted">
				–
			</span>
			<span className="sr-only">No value</span>
		</span>
	);
}
