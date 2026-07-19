"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import { Button } from "@/components/shadcn/button";

interface ScreenNavButtonsProps {
	canGoBack?: boolean;
	onBack?: () => void;
}

/** Hover uses `bg-white/5` (not a theme color) so the buttons read correctly
 *  on the breadcrumb bar's translucent surface. The shadcn primitive supplies
 *  the consistent focus ring and gates hover styles while disabled. */
const BUTTON_CLASS =
	"size-11 rounded-lg p-1.5 text-nova-text-muted not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text";

/**
 * Back control rendered in the breadcrumb bar. The adjacent breadcrumb owns
 * hierarchy navigation, so a second unlabeled "up" arrow would duplicate it.
 */
export function ScreenNavButtons({ canGoBack, onBack }: ScreenNavButtonsProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-lg"
			onClick={onBack}
			disabled={!canGoBack}
			className={`-ml-1.5 ${BUTTON_CLASS}`}
			aria-label="Go back"
		>
			<Icon icon={tablerArrowLeft} width={20} height={20} className="size-5" />
		</Button>
	);
}
