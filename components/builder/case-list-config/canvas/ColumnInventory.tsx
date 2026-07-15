// components/builder/case-list-config/canvas/ColumnInventory.tsx
//
// The secondary inventory shared by the Case List and Case Detail
// canvases. A column that is not shown on the active screen is still
// reachable here, but it never masquerades as visible app content.
// Selecting a row opens the ONE canonical configuration surface in
// the inspector rail; this inventory reports placement, it does not
// duplicate the inspector's visibility or sorting controls.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import { useEffect, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import type { Column } from "@/lib/domain";

export type ColumnInventorySurface = "list" | "detail";

export interface SupportingColumnInventoryProps {
	readonly columns: readonly Column[];
	readonly surface: ColumnInventorySurface;
	readonly selectedUuid: string | null;
	readonly brokenColumns: ReadonlySet<string>;
	readonly onSelect: (column: Column) => void;
}

/**
 * Fields omitted from the active screen, grouped away from the app-shaped
 * canvas. The group opens automatically when an inspector edit moves the
 * selected field out of the active surface, or when any supporting field
 * needs attention, so neither selection nor an error appears to vanish.
 */
export function SupportingColumnInventory({
	columns,
	surface,
	selectedUuid,
	brokenColumns,
	onSelect,
}: SupportingColumnInventoryProps) {
	const selectedIsSupporting = columns.some(
		(column) => column.uuid === selectedUuid,
	);
	const brokenCount = columns.reduce(
		(count, column) => count + (brokenColumns.has(column.uuid) ? 1 : 0),
		0,
	);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (selectedIsSupporting || brokenCount > 0) setOpen(true);
	}, [selectedIsSupporting, brokenCount]);

	if (columns.length === 0) return null;

	const screenName = surface === "list" ? "this list" : "case detail";

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div
				className="mt-5 overflow-hidden rounded-xl border border-nova-border bg-nova-surface/20"
				data-case-field-group="supporting"
				data-case-inventory-errors={brokenCount}
			>
				<CollapsibleTrigger className="group flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 text-left not-data-[disabled]:hover:bg-white/[0.025] transition-colors">
					<span className="grid size-8 shrink-0 place-items-center rounded-lg border border-nova-border bg-nova-deep/60 text-nova-text-muted">
						<Icon icon={tablerEyeOff} width="16" height="16" />
					</span>
					<span className="min-w-0 flex-1">
						<span className="block text-[13px] font-medium text-nova-text-secondary">
							Supporting fields
						</span>
						{brokenCount > 0 ? (
							<span className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] leading-relaxed text-nova-rose">
								<span
									aria-hidden="true"
									className="size-1.5 shrink-0 rounded-full bg-nova-rose"
								/>
								{brokenCount}{" "}
								{brokenCount === 1 ? "field needs" : "fields need"} attention
							</span>
						) : (
							<span className="block text-[11px] leading-relaxed text-nova-text-muted">
								Not shown in {screenName}; used elsewhere or behind the scenes.
							</span>
						)}
					</span>
					<span className="rounded-full border border-nova-border px-2 py-0.5 font-mono text-[10px] text-nova-text-muted">
						{columns.length}
					</span>
					<Icon
						icon={tablerChevronDown}
						width="15"
						height="15"
						className="shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-180"
					/>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<div className="border-t border-nova-border/80 p-2">
						<p className="px-2 pb-2 pt-1 text-[11px] leading-relaxed text-nova-text-muted">
							Select a field to change where it appears in the right panel.
						</p>
						<div className="space-y-1">
							{columns.map((column) => {
								const selected = column.uuid === selectedUuid;
								return (
									<button
										type="button"
										key={column.uuid}
										onClick={() => onSelect(column)}
										className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
											selected
												? "border-nova-violet bg-nova-violet/[0.09]"
												: "border-transparent hover:bg-white/[0.03]"
										}`}
										data-case-field-role="supporting"
										data-column-uuid={column.uuid}
									>
										<span className="min-w-0 flex-1">
											<span className="flex items-center gap-2">
												<span className="truncate text-[13px] font-medium text-nova-text-secondary">
													{columnLabel(column)}
												</span>
												{brokenColumns.has(column.uuid) && (
													<span
														role="img"
														className="size-1.5 shrink-0 rounded-full bg-nova-rose"
														aria-label="This field has a configuration error"
													/>
												)}
											</span>
											<span className="block truncate font-mono text-[10px] text-nova-text-muted">
												{columnSource(column)}
											</span>
										</span>
										<span className="max-w-[45%] text-right text-[10px] leading-snug text-nova-text-muted">
											{usageDescription(column, surface)}
										</span>
									</button>
								);
							})}
						</div>
					</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}

export function columnLabel(column: Column): string {
	return column.kind === "calculated"
		? column.header || "Untitled field"
		: column.header || column.field || "Untitled field";
}

export function columnSource(column: Column): string {
	return column.kind === "calculated" ? "calculated value" : column.field;
}

function usageDescription(
	column: Column,
	surface: ColumnInventorySurface,
): string {
	const otherSurfaceVisible =
		surface === "list"
			? column.visibleInDetail !== false
			: column.visibleInList !== false;
	const sorted = column.sort !== undefined;
	if (otherSurfaceVisible && sorted) {
		return `${surface === "list" ? "Shown in detail" : "Shown in list"} · used to sort`;
	}
	if (otherSurfaceVisible) {
		return surface === "list" ? "Shown in detail" : "Shown in list";
	}
	if (sorted) return "Used to sort";
	return "Behind the scenes";
}
