// components/builder/case-list-config/cards/column/mappingChrome.tsx
//
// Shared chrome for the two value→display mapping tables
// (`IdMappingCard` value→label, `ImageMapColumnCard` value→image).
// Both render the same list shape — etched section label, dashed
// empty notice, ordered entry rows with move/remove controls, and a
// full-width Add CTA — and differ only in each row's display cell.
// One home for the chrome keeps the row controls at full size (44px
// targets, tooltips) in both cards without drift.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import type { ReactNode } from "react";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

/** Etched console label above the mapping list. */
export function MappingSectionLabel() {
	return (
		<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
			Mapping
		</div>
	);
}

/** Dashed notice when the mapping has no entries — the consumer
 *  supplies the consequence ("values show exactly as they're
 *  stored", "rows show no image"). */
export function MappingEmptyNotice({ children }: { children: ReactNode }) {
	return (
		<div className="text-[11px] leading-snug text-nova-text-muted px-2 py-1.5 rounded-md border border-dashed border-white/[0.06] bg-nova-deep/30">
			{children}
		</div>
	);
}

/** Full-width dashed Add CTA — the same shape as every other Add
 *  affordance in the inspector. */
export function AddMappingButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full inline-flex items-center justify-center gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-dashed border-white/[0.10] text-nova-text-muted hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
		>
			<Icon icon={tablerPlus} width="14" height="14" />
			<span>Add Mapping</span>
		</button>
	);
}

export interface MappingRowShellProps {
	readonly index: number;
	readonly isFirst: boolean;
	readonly isLast: boolean;
	readonly onMoveUp: () => void;
	readonly onMoveDown: () => void;
	readonly onRemove: () => void;
	/** The row's two-cell body (value input + display cell). */
	readonly children: ReactNode;
}

/**
 * One mapping entry's card: etched "Entry N" eyebrow, move/remove
 * controls at full size, then the consumer's body cells. Order is
 * significant in both mapping kinds (first match wins), which is why
 * the move controls earn their space.
 */
export function MappingRowShell({
	index,
	isFirst,
	isLast,
	onMoveUp,
	onMoveDown,
	onRemove,
	children,
}: MappingRowShellProps) {
	return (
		<div className="rounded-md border border-white/[0.05] bg-nova-surface/30 px-2 py-2 space-y-1.5">
			<div className="flex items-center gap-1">
				<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
					Entry {index + 1}
				</span>
				<div className="flex-1" />
				<SimpleTooltip content="Move up — earlier entries match first">
					<button
						type="button"
						aria-label="Move entry up"
						onClick={onMoveUp}
						disabled={isFirst}
						className="size-11 grid place-items-center rounded-md text-nova-text-muted not-disabled:hover:text-nova-violet-bright not-disabled:hover:bg-white/[0.05] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
					>
						<Icon icon={tablerArrowUp} width="13" height="13" />
					</button>
				</SimpleTooltip>
				<SimpleTooltip content="Move down">
					<button
						type="button"
						aria-label="Move entry down"
						onClick={onMoveDown}
						disabled={isLast}
						className="size-11 grid place-items-center rounded-md text-nova-text-muted not-disabled:hover:text-nova-violet-bright not-disabled:hover:bg-white/[0.05] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
					>
						<Icon icon={tablerArrowDown} width="13" height="13" />
					</button>
				</SimpleTooltip>
				<SimpleTooltip content="Remove this entry">
					<button
						type="button"
						aria-label="Remove entry"
						onClick={onRemove}
						className="size-11 grid place-items-center rounded-md text-nova-text-muted hover:text-nova-rose hover:bg-white/[0.05] transition-colors cursor-pointer"
					>
						<Icon icon={tablerTrash} width="13" height="13" />
					</button>
				</SimpleTooltip>
			</div>
			{children}
		</div>
	);
}
