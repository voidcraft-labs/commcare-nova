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
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import { AnimatePresence, motion } from "motion/react";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { AppSettingsButton } from "@/components/builder/detail/appSettings/AppSettingsButton";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useBuilderIsReady, useSetSidebarOpen } from "@/lib/session/hooks";

export function StructureSidebar() {
	const isReady = useBuilderIsReady();
	const setSidebarOpen = useSetSidebarOpen();
	const appName = useAppName();

	return (
		<div className="w-90 border-r border-nova-border-bright bg-nova-deep flex flex-col shrink-0 h-full">
			{/* App row */}
			<div className="flex items-center gap-1 pl-3 pr-1 h-12 border-b border-nova-border shrink-0">
				<button
					type="button"
					onClick={() => setSidebarOpen("structure", false)}
					aria-label="Collapse structure sidebar"
					className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
				>
					<Icon icon={tablerChevronLeft} width="14" height="14" />
				</button>
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
		</div>
	);
}
