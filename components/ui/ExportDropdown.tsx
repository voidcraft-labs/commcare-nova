/**
 * Export dropdown — icon-only or labeled trigger button that opens a
 * frosted-glass menu of export format options (Web/JSON, Mobile/CCZ).
 *
 * Two variants via `compact` prop:
 * - **Default**: labeled button with chevron, for standalone use.
 * - **Compact**: icon-only 32px button, for toolbar placement alongside other icon actions.
 *
 * Uses the shared `DropdownMenu` for the popover surface so all dropdown
 * menus in the app share the same POPOVER_GLASS styling.
 */

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDownload from "@iconify-icons/tabler/download";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import {
	DropdownMenu,
	type DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import { useDismissRef } from "@/hooks/useDismissRef";

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
	const dismissRef = useDismissRef(() => setOpen(false));

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
		<div ref={dismissRef} className="relative">
			<motion.button
				whileTap={{ scale: 0.98 }}
				onClick={() => setOpen(!open)}
				title="Export"
				className={
					compact
						? "inline-flex items-center justify-center w-8 h-8 rounded-lg text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer"
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
			</motion.button>

			<AnimatePresence>
				{open && (
					<motion.div
						initial={{ opacity: 0, y: -4, scale: 0.97 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: -4, scale: 0.97 }}
						transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
						className="absolute right-0 top-[calc(100%+6px)] z-popover"
					>
						<DropdownMenu items={items} minWidth="180px" />
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
