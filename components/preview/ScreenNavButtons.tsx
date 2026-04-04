"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";

interface ScreenNavButtonsProps {
	canGoBack?: boolean;
	canGoUp?: boolean;
	onBack?: () => void;
	onUp?: () => void;
	/** Smaller variant for the standalone preview header bar (18px icons, p-1). Default is 20px/p-1.5. */
	compact?: boolean;
}

/** Hover uses `bg-white/5` instead of a theme-specific color so buttons
 *  work in both the violet Tier 2 breadcrumb bar and the cyan PreviewHeader. */
const btnClass = (enabled: boolean, compact: boolean) =>
	`${compact ? "p-1" : "p-1.5"} rounded-md shrink-0 ${enabled ? "text-nova-text-muted hover:text-nova-text hover:bg-white/5 cursor-pointer" : "text-nova-text-muted/30 cursor-default"}`;

/**
 * Nav buttons (back + up) rendered in the breadcrumb bar. Back steps through
 * history; up navigates to the parent screen in the hierarchy.
 */
export function ScreenNavButtons({
	canGoBack,
	canGoUp,
	onBack,
	onUp,
	compact,
}: ScreenNavButtonsProps) {
	const iconSize = compact ? 18 : 20;

	return (
		<div
			className={`flex items-center gap-0.5 ${compact ? "-ml-1" : "-ml-1.5"}`}
		>
			<button
				type="button"
				onClick={onBack}
				disabled={!canGoBack}
				className={btnClass(canGoBack ?? false, !!compact)}
				aria-label="Go back"
			>
				<Icon icon={tablerArrowLeft} width={iconSize} height={iconSize} />
			</button>
			<button
				type="button"
				onClick={onUp}
				disabled={!canGoUp}
				className={btnClass(canGoUp ?? false, !!compact)}
				aria-label="Go to parent"
			>
				<Icon icon={tablerArrowUp} width={iconSize} height={iconSize} />
			</button>
		</div>
	);
}
