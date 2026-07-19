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
import { type ReactNode, useRef } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";

/** Friendly section label above the value-rule list. */
export function MappingSectionLabel() {
	return <div className={INSPECTOR_LABEL_CLS}>Values shown as</div>;
}

/** Dashed notice when the mapping has no entries — the consumer
 *  supplies the consequence ("values show exactly as they're
 *  stored", "rows show no image"). */
export function MappingEmptyNotice({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-md border border-dashed border-white/[0.06] bg-nova-deep/30 p-3 text-[13px] leading-5 text-nova-text-muted">
			{children}
		</div>
	);
}

/** Full-width dashed Add CTA — the same shape as every other Add
 *  affordance in the inspector. */
export function AddMappingButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			type="button"
			variant="ghost"
			onClick={onClick}
			data-mapping-add
			className="min-h-11 w-full gap-2 border border-dashed border-white/[0.10] px-3 text-[14px] text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-transparent not-disabled:hover:text-nova-violet-bright dark:not-disabled:hover:bg-transparent"
		>
			<Icon icon={tablerPlus} width="14" height="14" />
			<span>Add value</span>
		</Button>
	);
}

/** Keep keyboard focus inside a mapping table after a row disappears. React
 * preserves the neighboring row by identity, but the browser cannot infer
 * where the removed row's focused action should go. Prefer the saved-value
 * control now occupying the same position, then the previous row, then Add. */
export function useMappingRemovalFocus() {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const removeWithFocus = (index: number, remove: () => void) => {
		remove();
		requestAnimationFrame(() => {
			const root = rootRef.current;
			if (root === null) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && root.contains(active)) return;
			const rows = root.querySelectorAll<HTMLElement>("[data-mapping-row]");
			const target = rows[Math.min(index, rows.length - 1)];
			const control =
				target?.querySelector<HTMLElement>("input, button") ??
				root.querySelector<HTMLElement>("[data-mapping-add]");
			control?.focus();
		});
	};
	return { rootRef, removeWithFocus };
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
 * One mapping entry's card. Its visible hierarchy is the semantic
 * stored-value → shown-result pair; the row index lives only in the
 * accessible group and action names. Order is significant in both
 * mapping kinds (first match wins), so the move controls remain in a
 * quiet footer.
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
		<fieldset
			data-mapping-row
			className="w-full min-w-0 space-y-3 rounded-md border border-white/[0.05] bg-nova-surface/30 p-3"
		>
			<legend className="sr-only">Value {index + 1}</legend>
			{children}
			<div className="flex items-center justify-end gap-1 border-t border-white/[0.05] pt-2">
				<SimpleTooltip content="Move earlier">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={`Move value ${index + 1} earlier`}
						onClick={onMoveUp}
						disabled={isFirst}
						className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-violet-bright dark:not-disabled:hover:bg-white/[0.05]"
					>
						<Icon icon={tablerArrowUp} width="13" height="13" />
					</Button>
				</SimpleTooltip>
				<SimpleTooltip content="Move later">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={`Move value ${index + 1} later`}
						onClick={onMoveDown}
						disabled={isLast}
						className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-violet-bright dark:not-disabled:hover:bg-white/[0.05]"
					>
						<Icon icon={tablerArrowDown} width="13" height="13" />
					</Button>
				</SimpleTooltip>
				<SimpleTooltip content="Remove value">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={`Remove value ${index + 1}`}
						onClick={onRemove}
						className="size-11 rounded-md text-nova-text-muted not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-rose dark:not-disabled:hover:bg-white/[0.05]"
					>
						<Icon icon={tablerTrash} width="13" height="13" />
					</Button>
				</SimpleTooltip>
			</div>
		</fieldset>
	);
}
