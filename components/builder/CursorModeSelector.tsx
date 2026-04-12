/**
 * Two-segment icon-only cursor mode selector with animated sliding indicator.
 *
 * Self-subscribes to `store.cursorMode` — only re-renders when the cursor
 * mode actually changes, not when BuilderLayout re-renders for unrelated
 * reasons (chat updates, sidebar toggles, undo/redo state).
 *
 * Accepts an `onChange` callback for coordination logic that must happen
 * before the mode switch (e.g., scroll anchor capture in BuilderLayout).
 *
 * Modes:
 * - **Pointer** (`V`): live form experience (no edit chrome)
 * - **Edit** (`E`): click-to-select questions + click-to-edit text inline
 */

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerPencil from "@iconify-icons/tabler/pencil";
import tablerPointer from "@iconify-icons/tabler/pointer";
import { motion } from "motion/react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBuilderStore } from "@/hooks/useBuilder";
import type { CursorMode } from "@/lib/services/builder";
import { selectCursorMode } from "@/lib/services/builderSelectors";

interface CursorModeSelectorProps {
	/** Callback invoked when the user clicks a mode button. BuilderLayout
	 *  wraps this to capture scroll anchors before the store update. */
	onChange: (mode: CursorMode) => void;
	/** Layout variant. `horizontal` renders a pill-shaped row for toolbar embedding;
	 *  `vertical` stacks buttons for compact sidebar placement. */
	variant?: "horizontal" | "vertical";
	/** When true, strips background/border so the parent can provide a
	 *  glassmorphic wrapper (POPOVER_GLASS) without visual doubling. */
	glass?: boolean;
}

/** Both modes share the same violet-tinted indicator — matches the lavender
 *  glass pill surface. Active state is a warmer violet fill; text brightens. */
const MODE_COLORS: Record<
	CursorMode,
	{ bg: string; glassBg: string; text: string }
> = {
	pointer: {
		bg: "bg-nova-violet/15",
		glassBg: "bg-nova-violet/20",
		text: "text-nova-text",
	},
	edit: {
		bg: "bg-nova-violet/15",
		glassBg: "bg-nova-violet/20",
		text: "text-nova-text",
	},
};

const segments: {
	key: CursorMode;
	label: string;
	shortcut: string;
	icon: IconifyIcon;
}[] = [
	{ key: "pointer", label: "Interact", shortcut: "V", icon: tablerPointer },
	{ key: "edit", label: "Edit", shortcut: "E", icon: tablerPencil },
];

/** Shared animation transition for the sliding mode indicator. */
const INDICATOR_TRANSITION = {
	duration: 0.2,
	ease: [0.4, 0, 0.2, 1],
} as const;

export function CursorModeSelector({
	onChange,
	variant = "horizontal",
	glass = false,
}: CursorModeSelectorProps) {
	const mode = useBuilderStore(selectCursorMode);
	const vertical = variant === "vertical";

	return (
		<div
			className={
				vertical
					? "flex flex-col items-center gap-1 rounded-xl bg-nova-deep border border-nova-border p-1"
					: glass
						? "flex items-center h-8 p-0.5 gap-0.5"
						: "flex items-center h-10 bg-nova-deep border border-nova-border rounded-lg p-1 gap-0.5"
			}
		>
			{segments.map(({ key, label, shortcut, icon }, index) => {
				const isActive = mode === key;
				const colors = MODE_COLORS[key];
				const isFirst = index === 0;
				const isLast = index === segments.length - 1;
				const pillRounding = glass
					? isFirst
						? "rounded-l-full rounded-r-md"
						: isLast
							? "rounded-r-full rounded-l-md"
							: "rounded-md"
					: "rounded-md";

				/* Tooltip content: mode name + keyboard shortcut badge */
				const tooltipContent = (
					<span className="flex items-center gap-2">
						{label}
						<kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded bg-white/[0.08] border border-white/[0.12] text-[10px] font-mono leading-none text-nova-text-secondary">
							{shortcut}
						</kbd>
					</span>
				);

				return (
					<Tooltip
						key={key}
						content={tooltipContent}
						placement={vertical ? "right" : "bottom"}
					>
						<button
							type="button"
							onClick={() => onChange(key)}
							aria-label={label}
							className={
								vertical
									? "relative w-10 h-10 rounded-lg transition-colors cursor-pointer"
									: `relative h-full px-3 ${pillRounding} transition-colors cursor-pointer ${
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
									className={`absolute inset-0 ${vertical ? "rounded-lg" : pillRounding} ${glass ? colors.glassBg : colors.bg}`}
									transition={INDICATOR_TRANSITION}
								/>
							)}
							<span
								className={`relative z-10 flex items-center justify-center w-full h-full ${
									isActive
										? colors.text
										: "text-nova-text-muted hover:text-nova-text-secondary"
								}`}
							>
								<Icon icon={icon} width={22} height={22} />
							</span>
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}
