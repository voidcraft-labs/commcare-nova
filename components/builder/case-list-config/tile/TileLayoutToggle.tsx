// components/builder/case-list-config/tile/TileLayoutToggle.tsx
//
// The Results arrangement switch. It sits beside the "Information shown"
// heading rather than in Module settings because it changes the
// composition surface directly underneath it — the same reason row order
// is dragged on the canvas and never set from a panel. Module settings
// stays the home for the module's menu appearance, and it isn't even
// reachable from this workspace on a module that has forms.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerLayoutGrid from "@iconify-icons/tabler/layout-grid";
import tablerLayoutRows from "@iconify-icons/tabler/layout-rows";
import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

export type CaseListArrangement = "rows" | "tile";

export function TileLayoutToggle({
	value,
	tileDisabledReason,
	onChange,
}: {
	readonly value: CaseListArrangement;
	/** Present when the case list cannot currently be laid out as a tile;
	 *  the option stays visible and explains itself. */
	readonly tileDisabledReason: string | undefined;
	readonly onChange: (next: CaseListArrangement) => void;
}) {
	const legendId = useId();
	const reasonId = useId();

	return (
		<div className="min-w-0">
			<fieldset
				className="m-0 flex gap-1 rounded-lg border border-white/[0.06] bg-nova-deep/50 p-1"
				aria-describedby={
					tileDisabledReason === undefined ? undefined : reasonId
				}
			>
				<legend id={legendId} className="sr-only">
					How Results arranges its information
				</legend>
				<ArrangementOption
					label="Rows"
					icon={tablerLayoutRows}
					active={value === "rows"}
					hint="One line per field, in the order you arrange them"
					onClick={() => onChange("rows")}
				/>
				<ArrangementOption
					label="Tile"
					icon={tablerLayoutGrid}
					active={value === "tile"}
					hint={
						tileDisabledReason ??
						"Lay the fields out on a grid, the way a worker sees them"
					}
					disabled={tileDisabledReason !== undefined}
					onClick={() => onChange("tile")}
				/>
			</fieldset>
			{tileDisabledReason !== undefined && (
				<p
					id={reasonId}
					className="mt-2 max-w-xs text-[13px] leading-relaxed text-nova-text-muted"
				>
					{tileDisabledReason}
				</p>
			)}
		</div>
	);
}

function ArrangementOption({
	label,
	icon,
	active,
	hint,
	disabled = false,
	onClick,
}: {
	readonly label: string;
	readonly icon: Parameters<typeof Icon>[0]["icon"];
	readonly active: boolean;
	readonly hint: string;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<SimpleTooltip content={hint}>
			<Button
				type="button"
				variant="ghost"
				size="xl"
				onClick={onClick}
				disabled={disabled}
				aria-pressed={active}
				className={`min-h-11 gap-2 rounded-md px-3 text-[14px] active:translate-y-0 ${
					active
						? "bg-nova-violet/[0.18] font-medium text-nova-violet-bright shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
						: "text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text dark:not-disabled:hover:bg-white/[0.04]"
				}`}
			>
				<Icon icon={icon} width="15" height="15" />
				{label}
			</Button>
		</SimpleTooltip>
	);
}
