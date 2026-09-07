"use client";
import {
	type BreadcrumbPart,
	CollapsibleBreadcrumb,
} from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";

/** The complete page-navigation landmark shared by every builder screen. */
export function BuilderPageNavigation({
	hasData,
	canGoBack,
	onBack,
	parts,
	compactWorkspaceBreadcrumb = false,
}: {
	readonly hasData: boolean;
	readonly canGoBack: boolean;
	readonly onBack: () => void;
	readonly parts: BreadcrumbPart[];
	readonly compactWorkspaceBreadcrumb?: boolean;
}) {
	return (
		<nav
			aria-label="Page navigation"
			className="flex min-w-0 flex-1 items-center gap-2"
		>
			{hasData && <ScreenNavButtons canGoBack={canGoBack} onBack={onBack} />}
			<CollapsibleBreadcrumb
				parts={parts}
				compactWorkspace={compactWorkspaceBreadcrumb}
			/>
		</nav>
	);
}
