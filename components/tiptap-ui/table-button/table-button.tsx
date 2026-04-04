"use client";

import { forwardRef, useCallback, useState } from "react";
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon";
import type { UseTableConfig } from "@/components/tiptap-ui/table-button";
import { useTable } from "@/components/tiptap-ui/table-button";
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button";
import { Button } from "@/components/tiptap-ui-primitive/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/tiptap-ui-primitive/dropdown-menu";
import { useTiptapEditor } from "@/hooks/use-tiptap-editor";

/** Maximum grid dimensions for the picker. */
const MAX_ROWS = 6;
const MAX_COLS = 6;

export interface TableButtonProps
	extends Omit<ButtonProps, "type">,
		UseTableConfig {
	onOpenChange?: (isOpen: boolean) => void;
	modal?: boolean;
}

// ── Grid picker ─────────────────────────────────────────────────────

/**
 * Visual grid picker for selecting table dimensions. Renders a MAX_ROWS × MAX_COLS
 * grid of cells — hovering highlights the top-left region to preview the selection,
 * clicking inserts a table with those dimensions. A label below shows the current
 * "rows × cols" count. Always inserts with a header row (GFM requirement).
 */
function TableGridPicker({
	onSelect,
}: {
	onSelect: (rows: number, cols: number) => void;
}) {
	/* -1 = no hover. Using 0 would collide with the first row/col index. */
	const [hoverRow, setHoverRow] = useState(-1);
	const [hoverCol, setHoverCol] = useState(-1);

	return (
		<div className="flex flex-col items-center gap-1.5 p-2" data-inline-toolbar>
			<fieldset
				className="grid gap-0.5 border-none m-0 p-0 min-w-0"
				aria-label="Table size"
				style={{ gridTemplateColumns: `repeat(${MAX_COLS}, 1fr)` }}
				onMouseLeave={() => {
					setHoverRow(-1);
					setHoverCol(-1);
				}}
			>
				{Array.from({ length: MAX_ROWS * MAX_COLS }, (_, i) => {
					const row = Math.floor(i / MAX_COLS);
					const col = i % MAX_COLS;
					const isHighlighted = row <= hoverRow && col <= hoverCol;

					return (
						<button
							key={`${row}-${col}`}
							type="button"
							className={`w-4 h-4 rounded-[2px] border transition-colors ${
								isHighlighted
									? "bg-nova-violet/40 border-nova-violet/60"
									: "bg-nova-void/60 border-nova-text/10 hover:border-nova-text/25"
							}`}
							onMouseEnter={() => {
								setHoverRow(row);
								setHoverCol(col);
							}}
							onClick={() => onSelect(row + 1, col + 1)}
						/>
					);
				})}
			</fieldset>
			<span className="text-[10px] text-nova-text-muted tabular-nums">
				{hoverRow >= 0 ? `${hoverRow + 1} × ${hoverCol + 1}` : "Select size"}
			</span>
		</div>
	);
}

// ── Dropdown button ─────────────────────────────────────────────────

/**
 * Dropdown menu for inserting tables with a visual grid size picker.
 * The trigger shows the table icon + chevron. Opening the dropdown reveals
 * a grid of cells — hover to preview dimensions, click to insert.
 */
export const TableButton = forwardRef<HTMLButtonElement, TableButtonProps>(
	(
		{
			editor: providedEditor,
			hideWhenUnavailable = false,
			onInserted,
			onOpenChange,
			children,
			modal = false,
			...buttonProps
		},
		ref,
	) => {
		const { editor } = useTiptapEditor(providedEditor);
		const [isOpen, setIsOpen] = useState(false);
		const { isVisible, isActive, canInsert, handleInsert, label, Icon } =
			useTable({ editor, hideWhenUnavailable, onInserted });

		const handleOpenChange = useCallback(
			(open: boolean) => {
				if (!editor || !canInsert) return;
				setIsOpen(open);
				onOpenChange?.(open);
			},
			[canInsert, editor, onOpenChange],
		);

		const handleSelect = useCallback(
			(rows: number, cols: number) => {
				handleInsert(rows, cols);
				setIsOpen(false);
			},
			[handleInsert],
		);

		if (!isVisible) return null;

		return (
			<DropdownMenu modal={modal} open={isOpen} onOpenChange={handleOpenChange}>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						data-active-state={isActive ? "on" : "off"}
						role="button"
						tabIndex={-1}
						disabled={!canInsert}
						data-disabled={!canInsert}
						aria-label={label}
						aria-pressed={isActive}
						tooltip="Table"
						{...buttonProps}
						ref={ref}
					>
						{children ?? (
							<>
								<Icon className="tiptap-button-icon" />
								<ChevronDownIcon className="tiptap-button-dropdown-small" />
							</>
						)}
					</Button>
				</DropdownMenuTrigger>

				<DropdownMenuContent align="start">
					<TableGridPicker onSelect={handleSelect} />
				</DropdownMenuContent>
			</DropdownMenu>
		);
	},
);

TableButton.displayName = "TableButton";
