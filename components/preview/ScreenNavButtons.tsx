"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import { Button } from "@/components/shadcn/button";
import type { LanguageTag } from "@/lib/domain/localization";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";

interface ScreenNavButtonsProps {
	canGoBack?: boolean;
	workerLanguage?: LanguageTag;
	onBack?: () => void;
}

/**
 * Back control rendered in the breadcrumb bar. The adjacent breadcrumb owns
 * hierarchy navigation, so a second unlabeled "up" arrow would duplicate it.
 */
export function ScreenNavButtons({
	canGoBack,
	onBack,
	workerLanguage,
}: ScreenNavButtonsProps) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			onClick={onBack}
			disabled={!canGoBack}
			className="-ml-1.5"
			aria-label={runtimeMessage(workerLanguage, "goBack")}
		>
			<Icon icon={tablerArrowLeft} width={20} height={20} className="size-5" />
		</Button>
	);
}
