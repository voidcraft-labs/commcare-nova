"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";

interface ScreenNavButtonsProps {
	canGoBack?: boolean;
	canGoUp?: boolean;
	onBack?: () => void;
	onUp?: () => void;
}

/** Hover uses `bg-white/5` (not a theme color) so the buttons read correctly
 *  on the breadcrumb bar's translucent surface. */
const btnClass = (enabled: boolean) =>
	`p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg shrink-0 ${enabled ? "text-nova-text-muted hover:text-nova-text hover:bg-white/5 cursor-pointer" : "text-nova-text-muted cursor-default"}`;

/**
 * Nav buttons (back + up) rendered in the breadcrumb bar. Back steps through
 * history; up navigates to the parent screen in the hierarchy.
 */
export function ScreenNavButtons({
	canGoBack,
	canGoUp,
	onBack,
	onUp,
}: ScreenNavButtonsProps) {
	return (
		<div className="flex items-center gap-0.5 -ml-1.5">
			<button
				type="button"
				onClick={onBack}
				disabled={!canGoBack}
				className={btnClass(canGoBack ?? false)}
				aria-label="Go back"
			>
				<Icon icon={tablerArrowLeft} width={20} height={20} />
			</button>
			<button
				type="button"
				onClick={onUp}
				disabled={!canGoUp}
				className={btnClass(canGoUp ?? false)}
				aria-label="Go to parent"
			>
				<Icon icon={tablerArrowUp} width={20} height={20} />
			</button>
		</div>
	);
}
