/**
 * StructureSidebar — collapsible panel showing the app's module/form/question
 * tree. Fully self-sufficient — subscribes to store state directly, no props
 * needed from BuilderLayout. Calls store actions to close itself.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import { AnimatePresence, motion } from "motion/react";
import { AppTree } from "@/components/builder/appTree/AppTree";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useBuilderIsReady, useSetSidebarOpen } from "@/lib/session/hooks";

export function StructureSidebar() {
	const isReady = useBuilderIsReady();
	const setSidebarOpen = useSetSidebarOpen();

	return (
		<div className="w-80 border-r border-nova-border-bright bg-nova-deep flex flex-col shrink-0 h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
				<button
					type="button"
					onClick={() => setSidebarOpen("structure", false)}
					className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
				>
					<Icon icon={tablerChevronLeft} width="14" height="14" />
				</button>
				<span className="text-[13px] font-medium text-nova-text-secondary">
					Structure
				</span>
			</div>

			{/* Structure tree — reads all state from hooks internally */}
			<div className="flex-1 overflow-hidden flex flex-col relative">
				<ErrorBoundary>
					<AppTree hideHeader />
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
