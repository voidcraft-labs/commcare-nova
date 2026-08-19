// components/preview/shared/CaseTileGroup.tsx
//
// One GROUP drawn as a card: the tile's header rows once, from the
// group's first case, then the tile's body rows once for every case in
// the group. The geometry is `CaseTile`'s — this file owns only the
// stacking, so a grouped list and a flat list can never disagree about
// what a tile looks like.
//
// The shape is `commcare-hq/corehq/apps/cloudcare/templates/cloudcare/partials/case_list/tile_grouped_item.html`:
// a header grid, then a run of body grids, all sharing one grid style.
// The card is ONE target. That is not a simplification: Web Apps clones
// the group's models and removes every non-first one from the rendered
// collection
// (`…/formplayer/menus/views.js::CaseTileGroupedListView.initialize`),
// so only the first case's child view survives to carry the click, and
// the body rows the template draws have no id, no checkbox, and no
// handler of their own. A worker who taps anywhere in a group opens its
// first case, and Nova shows exactly that rather than inventing a
// per-row selection the device does not have.

"use client";

import type { ColumnDisplayContext } from "@/components/builder/case-list-config/columnCellRenderer";
import type { CaseProperty } from "@/lib/domain";
import type { GroupedTileProjection } from "@/lib/preview/caseTileGrouping";
import type { TileResultsColumn } from "@/lib/preview/caseTileRendering";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { CaseTile } from "./CaseTile";

export function CaseTileGroup({
	projection,
	columns,
	headerRow,
	rows,
	caseProperties,
	displayContext,
	className,
}: {
	readonly projection: GroupedTileProjection;
	/** The columns the tile carries, in the order the projection placed them. */
	readonly columns: readonly TileResultsColumn[];
	/** The case the header is drawn from: the group's own first case. */
	readonly headerRow: CaseRowWithCalculated;
	/** The group's cases, in the order the list sorted them. */
	readonly rows: readonly CaseRowWithCalculated[];
	readonly caseProperties: readonly CaseProperty[];
	readonly displayContext: ColumnDisplayContext;
	readonly className?: string;
}) {
	return (
		<div data-case-tile-group="" className={className}>
			<CaseTile
				projection={projection.header}
				columns={columns}
				row={headerRow}
				caseProperties={caseProperties}
				displayContext={displayContext}
				surface="results"
				className="relative z-10"
			/>
			{/* Every case in the group repeats the body rows, the first one
			 *  included: the surviving child view draws its own body row
			 *  alongside the header it also drew
			 *  (`views.js::CaseTileGroupedView.getIndexedRowDataList` walks the
			 *  whole `groupModelsList`). */}
			<div
				data-case-tile-group-rows=""
				className="relative z-10 mt-1 flex flex-col gap-1"
			>
				{rows.map((row) => (
					<CaseTile
						key={row.case_id}
						projection={projection.body}
						columns={columns}
						row={row}
						caseProperties={caseProperties}
						displayContext={displayContext}
						surface="results"
					/>
				))}
			</div>
		</div>
	);
}
