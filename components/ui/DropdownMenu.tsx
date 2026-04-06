/**
 * Shared frosted-glass dropdown menu used by ExportDropdown, FormTypeDropdown,
 * and any future toolbar/header dropdowns.
 *
 * Renders a `POPOVER_GLASS` container with uniformly styled menu items.
 * Each item supports an icon, label, optional description, and optional
 * active state (violet highlight + dot indicator).
 *
 * Animation is handled by the parent (either Motion's AnimatePresence or
 * the Web Animations API via `useLayoutEffect`).
 */

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import { POPOVER_ELEVATED, POPOVER_GLASS } from "@/lib/styles";

export interface DropdownMenuItem {
	/** Unique key for the item. */
	key: string;
	/** Display label. */
	label: string;
	/** Optional secondary description rendered below the label. */
	description?: string;
	/** Icon rendered to the left of the label. */
	icon: IconifyIcon;
	/** Click handler — called when the item is selected. */
	onClick: () => void;
	/** When true, the item is visually muted and non-interactive. */
	disabled?: boolean;
	/** Native tooltip shown on hover (useful for explaining why an item is disabled). */
	tooltip?: string;
}

interface DropdownMenuProps {
	items: DropdownMenuItem[];
	/** Key of the currently active item (shows violet highlight + dot). */
	activeKey?: string;
	/** Minimum width of the menu container. */
	minWidth?: string;
	/**
	 * Surface layer variant. Use `'glass'` (default) for standalone popovers and
	 * `'elevated'` when the menu is stacked above an existing glass panel (e.g.
	 * inside FormSettingsPanel).
	 */
	variant?: "glass" | "elevated";
	/** Ref forwarded to the outer container for dismiss handling. */
	menuRef?: React.Ref<HTMLDivElement>;
}

/**
 * Frosted-glass dropdown menu with icon + label rows.
 * Matches the FormTypeDropdown visual language: `POPOVER_GLASS` surface,
 * violet dot + highlight for active item, `hover:bg-white/[0.06]`.
 */
export function DropdownMenu({
	items,
	activeKey,
	minWidth = "160px",
	variant = "glass",
	menuRef,
}: DropdownMenuProps) {
	const showDots = activeKey !== undefined;
	const last = items.length - 1;
	const surface = variant === "elevated" ? POPOVER_ELEVATED : POPOVER_GLASS;

	return (
		<div ref={menuRef} className={surface} style={{ minWidth }}>
			{items.map((item, i) => {
				const isActive = item.key === activeKey;
				/* First/last items inherit the container's border radius so their
				 * hover/active backgrounds tile flush against the rounded edges. */
				const corners =
					i === 0 && i === last
						? "rounded-xl"
						: i === 0
							? "rounded-t-xl"
							: i === last
								? "rounded-b-xl"
								: "";

				return (
					<button
						type="button"
						key={item.key}
						onClick={item.disabled ? undefined : item.onClick}
						disabled={item.disabled}
						title={item.tooltip}
						className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${corners} ${
							item.disabled
								? "opacity-40 cursor-not-allowed"
								: isActive
									? "text-nova-violet-bright bg-nova-violet/10 cursor-pointer"
									: "text-nova-text hover:bg-white/[0.06] cursor-pointer"
						}`}
					>
						{/* Active dot indicator — only rendered when the menu tracks selection */}
						{showDots && (
							<span
								className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-nova-violet" : "bg-transparent"}`}
							/>
						)}
						<Icon
							icon={item.icon}
							width="16"
							height="16"
							className={
								isActive ? "text-nova-violet-bright" : "text-nova-text-muted"
							}
						/>
						{item.description ? (
							<div className="min-w-0 text-left">
								<div>{item.label}</div>
								<div
									className={`text-xs leading-tight ${isActive ? "text-nova-violet-bright/60" : "text-nova-text-muted"}`}
								>
									{item.description}
								</div>
							</div>
						) : (
							item.label
						)}
					</button>
				);
			})}
		</div>
	);
}
