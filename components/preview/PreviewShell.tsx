"use client";
import { AnimatePresence, motion } from "motion/react";
import type { EditMode } from "@/hooks/useEditContext";
import { usePreviewNav } from "@/hooks/usePreviewNav";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { Builder, CursorMode } from "@/lib/services/builder";
import { PreviewHeader } from "./PreviewHeader";
import { CaseListScreen } from "./screens/CaseListScreen";
import { FormScreen } from "./screens/FormScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ModuleScreen } from "./screens/ModuleScreen";
import { SCREEN_TRANSITION } from "./screenTransition";

interface PreviewShellProps {
	blueprint: AppBlueprint;
	actions?: React.ReactNode;
	builder?: Builder;
	mode?: EditMode;
	/** Current cursor mode — threaded to EditContextProvider for mode-aware components. */
	cursorMode?: CursorMode;
	nav?: ReturnType<typeof usePreviewNav>;
	hideHeader?: boolean;
	/** Back handler override — used by BuilderLayout to sync selection on back navigation.
	 *  Also used by FormScreen for post-submit navigation. */
	onBack?: () => void;
}

export function PreviewShell({
	blueprint,
	actions,
	builder,
	mode = "edit",
	cursorMode,
	nav: navProp,
	hideHeader,
	onBack,
}: PreviewShellProps) {
	const ownNav = usePreviewNav(blueprint);
	const nav = navProp ?? ownNav;
	const handleBack = onBack ?? nav.back;

	return (
		<div
			className={`preview-theme ${mode === "edit" ? "design-theme" : ""} h-full flex flex-col`}
		>
			{!hideHeader && (
				<PreviewHeader
					breadcrumb={nav.breadcrumb}
					canGoBack={nav.canGoBack}
					canGoUp={nav.canGoUp}
					onBack={nav.back}
					onUp={nav.navigateUp}
					onBreadcrumbClick={nav.navigateTo}
					actions={actions}
				/>
			)}

			<div
				data-preview-scroll-container
				className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg"
			>
				<AnimatePresence mode="wait">
					<motion.div
						key={JSON.stringify(nav.current)}
						initial={SCREEN_TRANSITION.initial}
						animate={SCREEN_TRANSITION.animate}
						exit={SCREEN_TRANSITION.exit}
						transition={SCREEN_TRANSITION.transition}
						className="h-full"
					>
						{nav.current.type === "home" && (
							<HomeScreen
								blueprint={blueprint}
								onNavigate={nav.push}
								builder={builder}
								mode={mode}
							/>
						)}
						{nav.current.type === "module" && (
							<ModuleScreen
								blueprint={blueprint}
								moduleIndex={nav.current.moduleIndex}
								onNavigate={nav.push}
								builder={builder}
								mode={mode}
							/>
						)}
						{nav.current.type === "caseList" && (
							<CaseListScreen
								blueprint={blueprint}
								moduleIndex={nav.current.moduleIndex}
								formIndex={nav.current.formIndex}
								onNavigate={nav.push}
							/>
						)}
						{nav.current.type === "form" && (
							<FormScreen
								blueprint={blueprint}
								moduleIndex={nav.current.moduleIndex}
								formIndex={nav.current.formIndex}
								caseId={nav.current.caseId}
								onBack={handleBack}
								onNavigate={nav.push}
								builder={builder}
								mode={mode}
								cursorMode={cursorMode}
							/>
						)}
					</motion.div>
				</AnimatePresence>
			</div>
		</div>
	);
}
