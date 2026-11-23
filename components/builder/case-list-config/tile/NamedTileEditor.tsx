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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import {
	type CaseListConfig,
	NAMED_TILE_SLOTS,
	type NamedTileSlot,
	orderedColumns,
	type Uuid,
} from "@/lib/domain";
import { columnLabel } from "../canvas/ColumnInventory";

const labels: Record<NamedTileSlot, string> = {
	topLeftImage: "Top left image",
	topLeftText: "Top left text",
	topRightImage: "Top right image",
	topRightText: "Top right text",
	middleLeftImage: "Middle left image",
	middleLeftText: "Middle left text",
	middleRightImage: "Middle right image",
	middleRightText: "Middle right text",
	bottomLeftImage: "Bottom left image",
	bottomLeftText: "Bottom left text",
};
export function NamedTileEditor({
	config,
	onSave,
}: {
	config: CaseListConfig;
	onSave: (
		assignments: Record<NamedTileSlot, Uuid>,
		rawSlots: NamedTileSlot[],
	) => string | undefined;
}) {
	const columns = orderedColumns(config, "list").filter(
		(column) => column.visibleInList !== false && !column.notOnList,
	);
	const [draft, setDraft] = useState<Partial<
		Record<NamedTileSlot, Uuid>
	> | null>(null);
	const [raw, setRaw] = useState<NamedTileSlot[]>([]);
	const [error, setError] = useState("");
	function save() {
		if (!draft || NAMED_TILE_SLOTS.some((slot) => !draft[slot])) return;
		const issue = onSave(draft as Record<NamedTileSlot, Uuid>, raw);
		if (issue) setError(issue);
		else setDraft(null);
	}
	const assigned = new Set(Object.values(draft ?? {}));
	return (
		<Dialog
			open={draft !== null}
			onOpenChange={(open) => {
				setError("");
				setRaw(config.tile?.rawSlots ?? []);
				setDraft(open ? { ...config.tile?.namedSlots } : null);
			}}
		>
			<DialogTrigger render={<Button variant="outline" />}>
				{config.tile?.namedSlots
					? "Edit image and text layout"
					: "Arrange image and text pairs"}
			</DialogTrigger>
			{draft && (
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Image and text pairs</DialogTitle>
						<DialogDescription>
							Choose a different Results field for each position. Workers see
							five pairs on each case tile. On Android, icon fields show their
							stored image path.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="space-y-3">
						{columns.length < 10 && (
							<p className="text-sm text-nova-text-muted">
								This layout needs ten fields shown in Results. You can add more
								fields in Results.
							</p>
						)}
						{NAMED_TILE_SLOTS.map((slot) => (
							<div
								key={slot}
								className="grid grid-cols-2 items-center gap-2 text-sm"
							>
								{labels[slot]}
								<Select
									value={draft[slot] ?? null}
									onValueChange={(value) => {
										if (value) setDraft({ ...draft, [slot]: value as Uuid });
									}}
								>
									<SelectTrigger aria-label={labels[slot]}>
										<SelectValue placeholder="Choose a field" />
									</SelectTrigger>
									<SelectContent>
										{columns.map((column) => (
											<SelectItem
												key={column.uuid}
												value={column.uuid}
												disabled={
													assigned.has(column.uuid) &&
													draft[slot] !== column.uuid
												}
											>
												{columnLabel(column)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<label className="col-span-2 flex items-center gap-2">
									<input
										type="checkbox"
										checked={raw.includes(slot)}
										onChange={(event) =>
											setRaw(
												event.target.checked
													? [...raw, slot]
													: raw.filter((item) => item !== slot),
											)
										}
									/>
									Show the stored value for {labels[slot].toLowerCase()}
								</label>
							</div>
						))}
						{error && <p role="alert">{error}</p>}
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDraft(null)}>
							Cancel
						</Button>
						<Button disabled={assigned.size !== 10} onClick={save}>
							Save layout
						</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}
