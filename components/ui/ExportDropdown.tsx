/**
 * Export dropdown — trigger button that opens a menu of export format options.
 *
 * Two variants via `compact` prop:
 * - **Default**: labeled button with chevron, for standalone use.
 * - **Compact**: icon-only button, for toolbar placement alongside other icon actions.
 */

"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDownload from "@iconify-icons/tabler/download";
import { useState } from "react";
import {
	DropdownMenu,
	type DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import { Tooltip } from "@/components/ui/Tooltip";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

export interface ExportOption {
	label: string;
	description: string;
	icon: IconifyIcon;
	onClick: () => void;
}

interface ExportDropdownProps {
	options: ExportOption[];
	/** Icon-only trigger button for compact toolbar placement. */
	compact?: boolean;
}

export function ExportDropdown({ options, compact }: ExportDropdownProps) {
	const [open, setOpen] = useState(false);

	/** Map ExportOption[] to the shared DropdownMenuItem shape. */
	const items: DropdownMenuItem[] = options.map((opt, i) => ({
		key: `${i}-${opt.label}`,
		label: opt.label,
		description: opt.description,
		icon: opt.icon,
		onClick: () => {
			opt.onClick();
			setOpen(false);
		},
	}));

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Tooltip content="Export">
				<Popover.Trigger
					aria-label="Export"
					className={
						compact
							? "inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer"
							: "inline-flex items-center gap-1.5 px-3 py-1.5 text-lg font-medium rounded-lg bg-nova-surface text-nova-text border border-nova-border hover:border-nova-border-bright hover:bg-nova-elevated transition-all duration-200 cursor-pointer"
					}
				>
					<Icon
						icon={tablerDownload}
						width={compact ? 18 : 14}
						height={compact ? 18 : 14}
						className={compact ? "" : "opacity-70"}
					/>
					{!compact && (
						<>
							Export
							<Icon
								icon={tablerChevronDown}
								width="10"
								height="10"
								className={`opacity-50 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
							/>
						</>
					)}
				</Popover.Trigger>
			</Tooltip>

			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="end"
					sideOffset={6}
					className={POPOVER_POSITIONER_GLASS_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<DropdownMenu items={items} minWidth="180px" />
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
