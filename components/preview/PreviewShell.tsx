/**
 * PreviewShell — renders the correct screen (home, module, case list, form)
 * based on the store's current navigation screen.
 *
 * All state is read from the Zustand store via hooks — no blueprint, builder,
 * nav, or mode props. Child screen components also read from the store
 * directly via `useScreenData()`. The only props are layout concerns
 * (hideHeader, topInset) and the onBack override for BuilderLayout's
 * selection sync coordination.
 *
 * No memo needed — BuilderLayout's subscriptions are now minimal (structural
 * state only). PreviewShell re-renders only when its own store subscriptions
 * (screen, mode) change or when the parent legitimately re-renders.
 */
"use client";
import { useBuilderStore } from "@/hooks/useBuilder";
import { selectEditMode } from "@/lib/services/builderSelectors";
import { PreviewHeader } from "./PreviewHeader";
import { CaseListScreen } from "./screens/CaseListScreen";
import { FormScreen } from "./screens/FormScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ModuleScreen } from "./screens/ModuleScreen";

interface PreviewShellProps {
	actions?: React.ReactNode;
	hideHeader?: boolean;
	/** Pixels of top padding inside the scroll container — used by BuilderLayout
	 *  to offset content below the absolutely-positioned glassmorphic toolbar so
	 *  the first screen element isn't hidden behind the overlay on initial load. */
	topInset?: number;
	/** Back handler override — used by BuilderLayout to sync selection on back navigation.
	 *  Also used by FormScreen for post-submit navigation. */
	onBack?: () => void;
}

export function PreviewShell({
	actions,
	hideHeader,
	topInset = 0,
	onBack,
}: PreviewShellProps) {
	const screen = useBuilderStore((s) => s.screen);
	const navBack = useBuilderStore((s) => s.navBack);
	const mode = useBuilderStore(selectEditMode);

	const handleBack = onBack ?? navBack;

	return (
		<div
			className={`preview-theme ${mode === "edit" ? "design-theme" : ""} h-full flex flex-col`}
		>
			{!hideHeader && <PreviewHeader actions={actions} />}

			<div
				data-preview-scroll-container
				className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg [overflow-anchor:none]"
				style={topInset ? { paddingTop: topInset } : undefined}
			>
				{screen.type === "home" && <HomeScreen />}
				{screen.type === "module" && <ModuleScreen />}
				{screen.type === "caseList" && <CaseListScreen />}
				{screen.type === "form" && <FormScreen onBack={handleBack} />}
			</div>
		</div>
	);
}
