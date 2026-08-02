"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import { Button } from "@/components/shadcn/button";

interface ScreenNavButtonsProps {
	canGoBack?: boolean;
	onBack?: () => void;
}

/**
 * Back control rendered in the breadcrumb bar. The adjacent breadcrumb owns
 * hierarchy navigation, so a second unlabeled "up" arrow would duplicate it.
 */
export function ScreenNavButtons({ canGoBack, onBack }: ScreenNavButtonsProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			onClick={onBack}
			disabled={!canGoBack}
			className="-ml-1.5"
			aria-label="Go back"
		>
			<Icon icon={tablerArrowLeft} width={20} height={20} className="size-5" />
		</Button>
	);
}
