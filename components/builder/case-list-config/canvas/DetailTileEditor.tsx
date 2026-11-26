"use client";

import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type CaseListConfig,
	type Column,
	detailsTileFieldCount,
	TILE_GRID_COLUMNS,
	type TileCell,
	tileCell,
	tileRowLimit,
	type Uuid,
} from "@/lib/domain";
import { detailTabSpans } from "@/lib/domain/detailTabs";
import { TileCellInspector } from "../tile/TileCellInspector";
import { TileGridEditor } from "../tile/TileGridEditor";

type Layout = NonNullable<CaseListConfig["detailTile"]>;
interface Draft {
	layout: Layout;
	source: CaseListConfig;
	selected: Uuid | null;
}

export function DetailTileEditor({
	moduleUuid,
	config,
	columns,
	canEdit,
	onSave,
}: {
	moduleUuid: Uuid;
	config: CaseListConfig;
	columns: readonly Column[];
	canEdit: boolean;
	onSave: (layout: Layout | null) => string | undefined;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState("");
	if (!columns.length) return null;
	if (!canEdit)
		return config.detailTile ? (
			<p className="mb-4 text-sm">Web Apps shows these fields on a tile.</p>
		) : null;
	const groups = (
		config.detailTabs && detailTabSpans(config.detailTabs, columns)
	)?.map(({ tab, start, end }) => ({
		title: tab.title,
		fields: columns.slice(start, end),
	})) ?? [{ title: "", fields: columns }];
	/* The rows CommCare HQ's Case Detail page keeps: one for each field and
	 * tab it shows, at least six (`tileRowLimit`). Each tab's grid is drawn
	 * against the whole screen's. */
	const rows = tileRowLimit(detailsTileFieldCount(config));
	function open() {
		const cells: Layout["cells"] = {};
		const across = Math.min(
			TILE_GRID_COLUMNS,
			Math.ceil(columns.length / TILE_GRID_COLUMNS),
		);
		const width = Math.floor(TILE_GRID_COLUMNS / across);
		columns.forEach((col, i) => {
			cells[col.uuid] =
				config.detailTile?.cells[col.uuid] ??
				tileCell((i % across) * width, Math.floor(i / across), width, 1);
		});
		setError("");
		setDraft({
			layout: { cells },
			source: config,
			selected: columns[0]?.uuid ?? null,
		});
	}
	function save(next: Layout | null) {
		if (!draft) return;
		if (
			!deepEqual(draft.source.detailTile, config.detailTile) ||
			!deepEqual(draft.source.detailTabs, config.detailTabs) ||
			!deepEqual(draft.source.detailColumnOrder, config.detailColumnOrder)
		) {
			setError(
				"The Details layout changed while you were arranging it. Close and reopen the layout to use the latest fields.",
			);
			return;
		}
		const issue = onSave(next);
		if (issue) setError(issue);
		else setDraft(null);
	}
	function place(uuid: Uuid, cell: TileCell) {
		setDraft(
			(current) =>
				current && {
					...current,
					layout: { cells: { ...current.layout.cells, [uuid]: cell } },
				},
		);
	}
	return (
		<Dialog
			open={draft !== null}
			onOpenChange={(state) => (state ? open() : setDraft(null))}
		>
			<DialogTrigger render={<Button variant="outline" className="mb-6" />}>
				{config.detailTile ? "Edit detail tile" : "Arrange detail tile"}
			</DialogTrigger>
			{draft && (
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Detail tile</DialogTitle>
						<DialogDescription>
							Choose where fields appear in Web Apps. On Android, workers see
							these fields in order.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="space-y-4">
						{groups.map(({ title, fields }) => {
							const arranged = fields.map((col) => ({
								...col,
								visibleInList: undefined,
								notOnList: undefined,
								tile: draft.layout.cells[col.uuid],
							}));
							const order = arranged.map((col) => col.uuid);
							const slice: CaseListConfig = {
								columns: arranged,
								listColumnOrder: order,
								detailColumnOrder: order,
								searchInputs: [],
								tile: {},
							};
							const selected = arranged.find(
								(col) => col.uuid === draft.selected,
							);
							return (
								<section key={fields[0].uuid}>
									{title && <h3 className="font-medium">{title}</h3>}
									<TileGridEditor
										config={slice}
										selectedUuid={draft.selected}
										issues={new Map()}
										rows={rows}
										canEdit
										onSelect={(uuid) => setDraft({ ...draft, selected: uuid })}
										onPlace={place}
										onPlaceUnplaced={(uuid) =>
											setDraft({ ...draft, selected: uuid })
										}
									/>
									{selected && (
										<TileCellInspector
											details
											rows={rows}
											moduleUuid={moduleUuid}
											column={selected}
											config={slice}
											tileOn
											issues={[]}
											canEdit
											onPlace={(cell) => place(selected.uuid, cell)}
											onClearPlace={() =>
												setError("Each field on a detail tile needs a place.")
											}
											onPutOnTile={() => {}}
										/>
									)}
								</section>
							);
						})}
						{error && <p role="alert">{error}</p>}
					</DialogBody>
					<DialogFooter>
						{config.detailTile && (
							<Button variant="outline" onClick={() => save(null)}>
								Use ordinary rows
							</Button>
						)}
						<Button variant="outline" onClick={() => setDraft(null)}>
							Cancel
						</Button>
						<Button onClick={() => save(draft.layout)}>Save layout</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}
