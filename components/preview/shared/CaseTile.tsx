// components/preview/shared/CaseTile.tsx
//
// One case drawn as a tile — the running app's grid layout, used
// verbatim by both surfaces the short detail drives: a Results row and
// the tile pinned above a module's forms. One component, so the two can
// never disagree about geometry.
//
// Everything positional comes from `lib/preview/caseTileRendering.ts`,
// which reads the Web Apps templates; this file owns only what a
// renderer must own — the DOM, the Nova tokens that stand in for
// CommCare's literal border and shading colors, and the assistive text a
// tile needs because it draws no header row.

"use client";
import {
	type ColumnDisplayContext,
	renderColumnCell,
} from "@/components/builder/case-list-config/columnCellRenderer";
import type { CaseProperty } from "@/lib/domain";
import type { TileGridProjection } from "@/lib/preview/caseTileLayout";
import {
	planTileCell,
	type TileResultsColumn,
	tileGridStyle,
} from "@/lib/preview/caseTileRendering";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { caseColumnLabel } from "./caseColumnLabel";

/**
 * Where the tile is drawn. The geometry is identical either way; the
 * surface decides what the cells are FOR.
 *
 *   - `results` — the tile is a row in a chooser. Its cells sit above
 *     the row's own full-size action and let authored controls (a phone
 *     link, a value explanation) take pointer input back as independent
 *     siblings, never as children of that action.
 *   - `persistent` — the tile is the context above a form. Nothing in it
 *     chooses anything, so its cells stay ordinary content.
 */
export type CaseTileSurface = "results" | "persistent";

interface CaseTileProps {
	readonly projection: TileGridProjection;
	/** The columns the tile carries, in the order the projection placed them. */
	readonly columns: readonly TileResultsColumn[];
	readonly row: CaseRowWithCalculated;
	readonly caseProperties: readonly CaseProperty[];
	readonly displayContext: ColumnDisplayContext;
	readonly surface: CaseTileSurface;
	readonly className?: string;
}

/** Visible tile content sits above the Results row's stretched primary
 *  button. Ordinary text passes pointer input through to that button;
 *  authored cell controls opt back in as independent siblings with their
 *  own focus and touch behavior. Mirrors the row layout's rule exactly —
 *  a tile changes a row's shape, not what may be nested inside it.
 *
 *  This has to sit on the GRID, not on each cell. Unlike the row layout's
 *  cells, the grid is one box covering the whole row: leaving it
 *  hit-testable swallows every click meant for the action beneath, so a
 *  worker taps a case and nothing happens. */
const RESULTS_TILE_INTERACTION =
	"pointer-events-none [&_a]:pointer-events-auto [&_a]:relative [&_a]:z-20 [&_button]:pointer-events-auto [&_button]:relative [&_button]:z-20";

export function CaseTile({
	projection,
	columns,
	row,
	caseProperties,
	displayContext,
	surface,
	className,
}: CaseTileProps) {
	const byUuid = new Map<string, TileResultsColumn>(
		columns.map((entry) => [entry.column.uuid, entry]),
	);
	return (
		<div
			data-case-tile={surface}
			data-tile-columns={projection.columns}
			data-tile-rows={projection.rows}
			style={tileGridStyle(projection)}
			className={`w-full max-w-3xl text-[14px] text-nova-text-secondary ${
				surface === "results" ? RESULTS_TILE_INTERACTION : ""
			} ${className ?? ""}`}
		>
			{projection.cells.map((cell) => {
				const entry = byUuid.get(cell.columnUuid);
				if (entry === undefined) return null;
				const plan = planTileCell(cell);
				const label = caseColumnLabel(
					entry.column,
					caseProperties,
					displayContext.projectProse,
				);
				return (
					<div
						key={cell.columnUuid}
						{...(surface === "results" && {
							"data-case-result-field": cell.columnUuid,
						})}
						data-tile-cell={cell.mode}
						style={plan.style}
						className={`min-w-0 break-words [overflow-wrap:anywhere] ${
							plan.bordered ? "border border-pv-input-focus" : ""
						} ${plan.shaded ? "bg-pv-elevated" : ""}`}
					>
						{/* A hidden column that still orders the list holds its square
						 *  and shows nothing — the device's zero-width sort carrier. */}
						{!entry.valueHidden && (
							<>
								<span className="sr-only">{label}: </span>
								{renderColumnCell(entry.column, row, displayContext)}
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}
