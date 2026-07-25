/**
 * StructureSidebar — collapsible panel showing the app's module/form/field
 * tree. Fully self-sufficient — subscribes to store state directly, no props
 * needed from BuilderLayout. Calls store actions to close itself.
 *
 * The header is the app row: collapse control, then the app's name
 * titling the tree, with the app-level settings gear beside it
 * (`AppSettingsButton` — renders only for a ready editor). Before the
 * app is named, the row falls back to naming the panel itself.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerLayoutSidebarLeftCollapse from "@iconify-icons/tabler/layout-sidebar-left-collapse";
import tablerSettings from "@iconify-icons/tabler/settings";
import { AnimatePresence, motion } from "motion/react";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { AppSettingsButton } from "@/components/builder/detail/appSettings/AppSettingsButton";
import { Button } from "@/components/shadcn/button";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { APP_SETUP_LABEL } from "@/lib/routing/types";
import { useBuilderIsReady, useSetSidebarOpen } from "@/lib/session/hooks";

export function StructureSidebar() {
	const isReady = useBuilderIsReady();
	const setSidebarOpen = useSetSidebarOpen();
	const appName = useAppName();

	return (
		<div className="w-full border-r border-nova-border-bright bg-nova-deep flex flex-col shrink-0 h-full">
			{/* App row */}
			<div
				className="flex h-16 shrink-0 items-center gap-1 border-b border-nova-border pl-3 pr-1"
				data-builder-secondary-header="structure"
			>
				<Button
					type="button"
					variant="ghost"
					size="icon-lg"
					onClick={() => setSidebarOpen("structure", false)}
					aria-label="Collapse structure sidebar"
					data-builder-sidebar-toggle="collapse-structure"
					className="size-11 text-nova-text-muted hover:bg-white/[0.05] hover:text-nova-text"
				>
					<Icon icon={tablerLayoutSidebarLeftCollapse} width="17" height="17" />
				</Button>
				<span className="flex-1 min-w-0 text-sm font-medium text-nova-text truncate">
					{appName || "Structure"}
				</span>
				<AppSettingsButton />
			</div>

			{/* Structure tree — reads all state from hooks internally */}
			<div className="flex-1 overflow-hidden flex flex-col relative">
				<ErrorBoundary>
					<AppTree />
				</ErrorBoundary>

				{/* Dim overlay — blocks interaction until generation completes */}
				<AnimatePresence>
					{!isReady && (
						<motion.div
							exit={{ opacity: 0 }}
							transition={{ duration: 0.3 }}
							className="absolute inset-0 bg-black/25 z-10 pointer-events-none"
						/>
					)}
				</AnimatePresence>
			</div>

			{/* App setup sits BELOW the tree, outside it and after its scroll
			 *  region. The tree is the runnable app; app administration is not a
			 *  module, and nesting it would say that it was. */}
			<AppSetupNavEntry />
		</div>
	);
}

/** The expanded sidebar's App setup destination. */
function AppSetupNavEntry() {
	const navigate = useNavigate();
	const loc = useLocation();
	const active = loc.kind === "app-setup";
	return (
		<div className="shrink-0 border-t border-nova-border p-2">
			<Button
				type="button"
				variant="ghost"
				size="lg"
				aria-current={active ? "page" : undefined}
				onClick={() => navigate.openAppSetup()}
				className={`h-11 w-full justify-start gap-2.5 px-2.5 text-[13px] font-medium ${
					active
						? "bg-nova-violet/[0.15] text-nova-violet-bright shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
						: "text-nova-text-muted hover:bg-white/[0.05] hover:text-nova-text"
				}`}
			>
				<Icon
					icon={tablerSettings}
					width="17"
					height="17"
					aria-hidden="true"
					className="shrink-0"
				/>
				{APP_SETUP_LABEL}
			</Button>
		</div>
	);
}
