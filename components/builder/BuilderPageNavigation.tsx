"use client";
import {
	type BreadcrumbPart,
	CollapsibleBreadcrumb,
} from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import type { LanguageTag } from "@/lib/domain/localization";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";

/** The complete page-navigation landmark shared by every builder screen. */
export function BuilderPageNavigation({
	hasData,
	canGoBack,
	onBack,
	parts,
	compactWorkspaceBreadcrumb = false,
	workerLanguage,
}: {
	readonly workerLanguage?: LanguageTag;
	readonly hasData: boolean;
	readonly canGoBack: boolean;
	readonly onBack: () => void;
	readonly parts: BreadcrumbPart[];
	readonly compactWorkspaceBreadcrumb?: boolean;
}) {
	return (
		<nav
			aria-label={runtimeMessage(workerLanguage, "pageNavigation")}
			className="flex min-w-0 flex-1 items-center gap-2"
		>
			{hasData && (
				<ScreenNavButtons
					canGoBack={canGoBack}
					onBack={onBack}
					workerLanguage={workerLanguage}
				/>
			)}
			<CollapsibleBreadcrumb
				parts={parts}
				pathLabel={runtimeMessage(workerLanguage, "breadcrumbPath")}
				compactWorkspace={compactWorkspaceBreadcrumb}
			/>
		</nav>
	);
}
