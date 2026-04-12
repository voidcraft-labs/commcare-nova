/**
 * BuilderContentArea — the flex row containing structure sidebar, main
 * preview content, and chat sidebar. Self-subscribes to all layout
 * visibility state (chatOpen, structureOpen, cursorMode, isReady, hasData)
 * so BuilderLayout doesn't need to.
 *
 * This component is the layout-level rendering boundary: sidebar
 * toggle animations, reopen buttons, and width transitions all happen
 * here without cascading to the parent or to the preview/chat content.
 *
 * Children (PreviewShell, CursorModeSelector, GenerationProgress) are
 * self-sufficient — they subscribe to their own state from the store.
 * This component only controls mount/unmount and animation wrappers.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerListTree from "@iconify-icons/tabler/list-tree";
import tablerMessageChatbot from "@iconify-icons/tabler/message-chatbot";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { CursorModeSelector } from "@/components/builder/CursorModeSelector";
import { GenerationProgress } from "@/components/builder/GenerationProgress";
import { StructureSidebar } from "@/components/builder/StructureSidebar";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { CHAT_SIDEBAR_WIDTH } from "@/components/chat/ChatSidebar";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Tooltip } from "@/components/ui/Tooltip";
import {
	useBuilderEngine,
	useBuilderHasData,
	useBuilderIsReady,
	useBuilderPhase,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { BuilderPhase } from "@/lib/services/builder";
import {
	selectChatOpen,
	selectCursorMode,
	selectInReplayMode,
	selectStructureOpen,
} from "@/lib/services/builderSelectors";
import type { CursorMode } from "@/lib/services/builderStore";

/** Shared sidebar open/close animation config. */
const SIDEBAR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

/** Width of the structure sidebar in pixels (w-80). */
const STRUCTURE_SIDEBAR_WIDTH = 320;

/** Height of the glassmorphic cursor mode pill (top-2.5 + py-1.5 + 34px control + py-1.5).
 *  Used as top inset on PreviewShell so content starts below the overlay. */
const TOOLBAR_INSET = 56;

interface BuilderContentAreaProps {
	/** Whether the layout is in centered mode (Idle phase). When centered,
	 *  the preview area hides and chat takes full width. */
	isCentered: boolean;
	/** Scroll-anchor-capturing wrapper for cursor mode changes. BuilderLayout
	 *  owns the scroll anchor state for flipbook sync because it coordinates
	 *  the scroll container's ResizeObserver correction during width animation.
	 *  This is the one piece of coordination that crosses the boundary. */
	onCursorModeChange: (mode: CursorMode) => void;
	/** Back handler for PreviewShell — wraps engine.navBackWithSync with
	 *  selection sync. Passed through from BuilderLayout. */
	onPreviewBack: () => void;
	/** Whether the app was loaded from Firestore (not a new build). */
	isExistingApp: boolean;
	/** Server-rendered thread history for ChatContainer. */
	children?: ReactNode;
}

export function BuilderContentArea({
	isCentered,
	onCursorModeChange,
	onPreviewBack,
	isExistingApp,
	children,
}: BuilderContentAreaProps) {
	const builder = useBuilderEngine();
	const phase = useBuilderPhase();
	const isReady = useBuilderIsReady();
	const hasData = useBuilderHasData();
	const inReplayMode = useBuilderStore(selectInReplayMode);

	/* Layout visibility — these only change on deliberate user interactions
	 * (sidebar toggle, cursor mode switch), not on every keystroke or message. */
	const chatOpen = useBuilderStore(selectChatOpen);
	const structureOpen = useBuilderStore(selectStructureOpen);
	const cursorMode = useBuilderStore(selectCursorMode);

	const showProgress = phase === BuilderPhase.Generating && !inReplayMode;
	const showToolbar = isReady && hasData;

	return (
		<div className="relative flex-1 overflow-hidden flex">
			{/* Structure sidebar (left) — width-animated mount/unmount */}
			<AnimatePresence initial={false}>
				{!isCentered && hasData && structureOpen && (
					<motion.div
						key="structure"
						initial={{ width: 0 }}
						animate={{ width: STRUCTURE_SIDEBAR_WIDTH }}
						exit={{ width: 0 }}
						transition={SIDEBAR_TRANSITION}
						className="shrink-0 overflow-hidden"
					>
						<StructureSidebar />
					</motion.div>
				)}
			</AnimatePresence>

			{/* Main scrollable content */}
			<AnimatePresence>
				{!isCentered && (
					<motion.div
						className="flex-1 overflow-hidden relative"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.3, delay: 0.15 }}
					>
						{/* Floating reopen buttons for collapsed sidebars.
						 *  Hidden in pointer mode — sidebars are force-closed for
						 *  immersive testing, so expand icons would be misleading. */}
						{cursorMode !== "pointer" && !structureOpen && hasData && (
							<Tooltip content="Open structure" placement="right">
								<button
									type="button"
									onClick={() =>
										builder.store.getState().setStructureOpen(true)
									}
									className="absolute top-3 left-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
									aria-label="Open structure sidebar"
								>
									<Icon icon={tablerListTree} width="20" height="20" />
								</button>
							</Tooltip>
						)}
						{cursorMode !== "pointer" && !chatOpen && (
							<Tooltip content="Open chat" placement="left">
								<button
									type="button"
									onClick={() => builder.store.getState().setChatOpen(true)}
									className="absolute top-3 right-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
									aria-label="Open chat sidebar"
								>
									<Icon icon={tablerMessageChatbot} width="20" height="20" />
								</button>
							</Tooltip>
						)}

						<ErrorBoundary>
							{isReady && hasData ? (
								<PreviewShell
									hideHeader
									topInset={showToolbar ? TOOLBAR_INSET : 0}
									onBack={onPreviewBack}
								/>
							) : null}
						</ErrorBoundary>

						{/* Cursor mode pill — absolutely positioned centered pill over
						 *  the scroll container so backdrop-filter samples the scrolling
						 *  content beneath. */}
						{showToolbar && (
							<div className="absolute top-2.5 inset-x-0 z-raised flex justify-center pointer-events-none">
								<div className="pointer-events-auto rounded-full bg-[rgba(93,88,167,0.25)] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/[0.1] shadow-[0_4px_20px_rgba(139,92,246,0.1),0_2px_8px_rgba(0,0,0,0.2)] px-1 py-1">
									<CursorModeSelector
										onChange={onCursorModeChange}
										variant="horizontal"
										glass
									/>
								</div>
							</div>
						)}

						{/* Progress overlay */}
						<AnimatePresence>
							{showProgress && (
								<motion.div
									exit={{ opacity: 0, y: 30, scale: 0.97 }}
									transition={{ duration: 1, ease: [0.4, 0, 0.2, 1] }}
									className="absolute z-ground pointer-events-none inset-0 flex items-center justify-center"
								>
									<div className="pointer-events-auto">
										<GenerationProgress />
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</motion.div>
				)}
			</AnimatePresence>

			{/* Chat sidebar — always mounted, width-animated for open/close.
			 *  In centered mode the wrapper is invisible to layout (auto width,
			 *  no overflow clip) so ChatSidebar's absolute positioning works. */}
			<motion.div
				initial={false}
				animate={{
					width: isCentered ? "auto" : chatOpen ? CHAT_SIDEBAR_WIDTH : 0,
				}}
				transition={isCentered ? { duration: 0 } : SIDEBAR_TRANSITION}
				className={isCentered ? "" : "shrink-0 overflow-hidden"}
			>
				<ErrorBoundary>
					<ChatContainer centered={isCentered} isExistingApp={isExistingApp}>
						{children}
					</ChatContainer>
				</ErrorBoundary>
			</motion.div>
		</div>
	);
}
