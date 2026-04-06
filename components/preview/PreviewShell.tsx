/**
 * PreviewShell — renders the correct screen (home, module, case list, form)
 * based on the store's current navigation screen.
 *
 * All state is read from the Zustand store via hooks — no blueprint, builder,
 * nav, or mode props. Child screen components (HomeScreen, ModuleScreen, etc.)
 * also read from the store directly. The only props are layout concerns
 * (hideHeader, topInset, actions) and the onBack override for BuilderLayout's
 * selection sync coordination.
 */
/**
 * PreviewShell — renders the correct screen (home, module, case list, form)
 * based on the store's current navigation screen.
 *
 * All state is read from the Zustand store via hooks — no blueprint, builder,
 * nav, or mode props. Child screen components also read from the store
 * directly via `useScreenData()`. The only props are layout concerns
 * (hideHeader, topInset, actions) and the onBack override for BuilderLayout's
 * selection sync coordination.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import { useBuilderStore } from "@/hooks/useBuilder";
import { selectEditMode } from "@/lib/services/builderSelectors";
import { PreviewHeader } from "./PreviewHeader";
import { CaseListScreen } from "./screens/CaseListScreen";
import { FormScreen } from "./screens/FormScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ModuleScreen } from "./screens/ModuleScreen";
import { SCREEN_TRANSITION } from "./screenTransition";

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
				className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg"
				style={topInset ? { paddingTop: topInset } : undefined}
			>
				<AnimatePresence mode="wait">
					<motion.div
						key={JSON.stringify(screen)}
						initial={SCREEN_TRANSITION.initial}
						animate={SCREEN_TRANSITION.animate}
						exit={SCREEN_TRANSITION.exit}
						transition={SCREEN_TRANSITION.transition}
						className="h-full"
					>
						{screen.type === "home" && <HomeScreen />}
						{screen.type === "module" && <ModuleScreen />}
						{screen.type === "caseList" && <CaseListScreen />}
						{screen.type === "form" && <FormScreen onBack={handleBack} />}
					</motion.div>
				</AnimatePresence>
			</div>
		</div>
	);
}
