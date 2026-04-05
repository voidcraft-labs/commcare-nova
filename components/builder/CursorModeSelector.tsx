/**
 * Three-segment cursor mode selector with two layout variants:
 *
 * - **`horizontal`** (default): Segmented control with icon + label for
 *   embedding in toolbars. `h-[34px]`, `rounded-lg`, `bg-nova-deep` border.
 * - **`vertical`**: Icon-only stacked buttons with title tooltips for
 *   compact contexts where horizontal space is limited.
 *
 * Both share the same segments, mode colors, and animated sliding indicator
 * (via `layoutId`). The `layoutId` is unique per variant to avoid cross-animation.
 *
 * Modes:
 * - **Pointer**: live form experience (no edit chrome)
 * - **Text**: click text surfaces to edit inline with WYSIWYG toolbar
 * - **Inspect**: click questions to expand inline settings panel
 */

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCursorText from "@iconify-icons/tabler/cursor-text";
import tablerHandFinger from "@iconify-icons/tabler/hand-finger";
import tablerPointer from "@iconify-icons/tabler/pointer";
import { motion } from "motion/react";
import type { CursorMode } from "@/lib/services/builder";

interface CursorModeSelectorProps {
	mode: CursorMode;
	onChange: (mode: CursorMode) => void;
	/** Layout variant. `horizontal` shows icon + label in a segmented control;
	 *  `vertical` stacks icon-only buttons with title tooltips. */
	variant?: "horizontal" | "vertical";
	/** When true, strips background/border so the parent can provide a
	 *  glassmorphic wrapper (POPOVER_GLASS) without visual doubling. */
	glass?: boolean;
}

/** Color per mode — pointer uses emerald (live), text uses violet (edit), inspect uses neutral white (examine).
 *  Glass variants use higher-opacity fills so the indicator reads against the translucent backdrop. */
const MODE_COLORS: Record<
	CursorMode,
	{ bg: string; glassBg: string; text: string }
> = {
	pointer: {
		bg: "bg-nova-emerald/15",
		glassBg: "bg-nova-emerald/25",
		text: "text-nova-emerald",
	},
	text: {
		bg: "bg-nova-violet/15",
		glassBg: "bg-nova-violet/25",
		text: "text-nova-violet-bright",
	},
	inspect: {
		bg: "bg-white/[0.08]",
		glassBg: "bg-white/15",
		text: "text-nova-text",
	},
};

const segments: { key: CursorMode; label: string; icon: IconifyIcon }[] = [
	{ key: "pointer", label: "Pointer", icon: tablerPointer },
	{ key: "text", label: "Text", icon: tablerCursorText },
	{ key: "inspect", label: "Inspect", icon: tablerHandFinger },
];

/** Shared animation transition for the sliding mode indicator. */
const INDICATOR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

export function CursorModeSelector({
	mode,
	onChange,
	variant = "horizontal",
	glass = false,
}: CursorModeSelectorProps) {
	const vertical = variant === "vertical";

	return (
		<div
			className={
				vertical
					? "flex flex-col items-center gap-1 rounded-xl bg-nova-deep border border-nova-border p-1"
					: glass
						? "flex items-center h-[34px] p-0.5"
						: "flex items-center h-[34px] bg-nova-deep border border-nova-border rounded-lg p-0.5"
			}
		>
			{segments.map(({ key, label, icon }) => {
				const isActive = mode === key;
				const colors = MODE_COLORS[key];
				return (
					<button
						type="button"
						key={key}
						onClick={() => onChange(key)}
						title={vertical ? label : undefined}
						className={
							vertical
								? "relative w-8 h-8 rounded-lg transition-colors cursor-pointer"
								: `relative h-full px-2.5 text-[13px] font-medium rounded-md transition-colors cursor-pointer ${
										!isActive && glass ? "hover:bg-white/[0.08]" : ""
									}`
						}
					>
						{isActive && (
							<motion.div
								layoutId={
									vertical
										? "cursor-mode-bar-indicator"
										: "cursor-mode-indicator"
								}
								className={`absolute inset-0 ${vertical ? "rounded-lg" : "rounded-md"} ${glass ? colors.glassBg : colors.bg}`}
								transition={INDICATOR_TRANSITION}
							/>
						)}
						<span
							className={`relative z-10 flex items-center ${vertical ? "justify-center w-full h-full" : "gap-2"} ${
								isActive
									? colors.text
									: "text-nova-text-muted hover:text-nova-text-secondary"
							}`}
						>
							<Icon
								icon={icon}
								width={vertical ? 18 : 16}
								height={vertical ? 18 : 16}
							/>
							{!vertical && label}
						</span>
					</button>
				);
			})}
		</div>
	);
}
