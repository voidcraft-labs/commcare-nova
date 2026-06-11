/**
 * BuilderContentArea — the flex row containing structure sidebar, main
 * preview content, and chat sidebar. Self-subscribes to all layout
 * visibility state (chatOpen, structureOpen, previewing, isReady, hasData)
 * so BuilderLayout doesn't need to.
 *
 * This component is the layout-level rendering boundary: sidebar
 * toggle animations, the collapsed icon rails on both edges, and width
 * transitions all happen here without cascading to the parent or to
 * the preview/chat content.
 *
 * Children (PreviewShell, GenerationProgress) are self-sufficient —
 * they subscribe to their own state from the store. This component only
 * controls mount/unmount and animation wrappers.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { AppTreeRail } from "@/components/builder/appTree/AppTreeRail";
import { GenerationProgress } from "@/components/builder/GenerationProgress";
import { StructureSidebar } from "@/components/builder/StructureSidebar";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { ChatRail } from "@/components/chat/ChatRail";
import { CHAT_SIDEBAR_WIDTH } from "@/components/chat/ChatSidebar";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useBuilderIsReady,
	useBuilderPhase,
	useInReplayMode,
	usePreviewing,
	useSetSidebarOpen,
	useSidebarState,
} from "@/lib/session/hooks";
import { INSPECTOR_RAIL_WIDTH, useInspectorActive } from "@/lib/ui/inspector";

/** Shared sidebar open/close animation config. */
const SIDEBAR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

/** Width of the structure sidebar in pixels (w-90) — the same width
 *  as the right rail, so the two edges frame the canvas evenly. */
const STRUCTURE_SIDEBAR_WIDTH = 360;

/** Width of the collapsed icon rails (w-14) — structure and chat
 *  share it, so the two edges read as one system. */
const COLLAPSED_RAIL_WIDTH = 56;

interface BuilderContentAreaProps {
	/** Whether the layout is in centered mode (Idle phase). When centered,
	 *  the preview area hides and chat takes full width. */
	isCentered: boolean;
	/** Whether the app was loaded from Firestore (not a new build). */
	isExistingApp: boolean;
	/** Server-rendered thread history for ChatContainer. */
	children?: ReactNode;
}

export function BuilderContentArea({
	isCentered,
	isExistingApp,
	children,
}: BuilderContentAreaProps) {
	const phase = useBuilderPhase();
	const isReady = useBuilderIsReady();
	const hasData = useDocHasData();
	const inReplayMode = useInReplayMode();

	/* Back navigation for PreviewShell — reads directly from URL hooks
	 * instead of being threaded as a prop from BuilderLayout. */
	const navigate = useNavigate();

	/* Layout visibility — these only change on deliberate user interactions
	 * (sidebar toggle, preview toggle), not on every keystroke or message. */
	const { open: chatOpen } = useSidebarState("chat");
	const { open: structureOpen } = useSidebarState("structure");
	const previewing = usePreviewing();
	const setSidebarOpen = useSetSidebarOpen();

	/* The right rail belongs to the inspector while a surface claims it:
	 * it stays open even when the chat sidebar is toggled closed — a
	 * selection without a visible properties panel would be dead UI.
	 * Chat and inspector share ONE width (CHAT_SIDEBAR_WIDTH aliases
	 * INSPECTOR_RAIL_WIDTH), so claiming the rail never reflows the
	 * canvas. */
	const inspectorActive = useInspectorActive();
	const railWidth = inspectorActive
		? INSPECTOR_RAIL_WIDTH
		: chatOpen
			? CHAT_SIDEBAR_WIDTH
			: 0;

	const showProgress = phase === BuilderPhase.Generating && !inReplayMode;

	return (
		<div className="relative flex-1 overflow-hidden flex">
			{/* Structure sidebar (left) — full tree when open, icon rail when
			 *  collapsed. The rail keeps every destination (modules, each
			 *  case list, every form) one click away, so collapsing trades
			 *  width for labels, never for reach. Preview unmounts the
			 *  whole strip — the running app gets the full canvas. */}
			<AnimatePresence initial={false}>
				{!isCentered && hasData && !previewing && (
					<motion.div
						key="structure"
						initial={{ width: 0 }}
						animate={{
							width: structureOpen
								? STRUCTURE_SIDEBAR_WIDTH
								: COLLAPSED_RAIL_WIDTH,
						}}
						exit={{ width: 0 }}
						transition={SIDEBAR_TRANSITION}
						className="shrink-0 overflow-hidden"
					>
						{structureOpen ? (
							<StructureSidebar />
						) : (
							<AppTreeRail onExpand={() => setSidebarOpen("structure", true)} />
						)}
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
						<ErrorBoundary>
							{isReady && hasData ? (
								<PreviewShell hideHeader onBack={() => navigate.back()} />
							) : null}
						</ErrorBoundary>

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
					width: isCentered ? "auto" : railWidth,
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

			{/* Collapsed chat = the icon rail at the right edge, the mirror
			 *  of the structure side. The chat wrapper above stays mounted at
			 *  width 0 (chat state survives collapse); this sibling column is
			 *  purely the collapsed affordance. It steps aside whenever the
			 *  inspector claims the rail (selection forces the rail open) and
			 *  in preview, where chrome is force-hidden. */}
			<AnimatePresence initial={false}>
				{!isCentered &&
					hasData &&
					!previewing &&
					!chatOpen &&
					!inspectorActive && (
						<motion.div
							key="chat-rail"
							initial={{ width: 0 }}
							animate={{ width: COLLAPSED_RAIL_WIDTH }}
							exit={{ width: 0 }}
							transition={SIDEBAR_TRANSITION}
							className="shrink-0 overflow-hidden"
						>
							<ChatRail onExpand={() => setSidebarOpen("chat", true)} />
						</motion.div>
					)}
			</AnimatePresence>
		</div>
	);
}
