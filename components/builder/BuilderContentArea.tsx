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
import tablerMessageChatbot from "@iconify-icons/tabler/message-chatbot";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { AppTreeRail } from "@/components/builder/appTree/AppTreeRail";
import { CursorModeSelector } from "@/components/builder/CursorModeSelector";
import { GenerationProgress } from "@/components/builder/GenerationProgress";
import { StructureSidebar } from "@/components/builder/StructureSidebar";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { CHAT_SIDEBAR_WIDTH } from "@/components/chat/ChatSidebar";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { Tooltip } from "@/components/ui/Tooltip";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useBuilderIsReady,
	useBuilderPhase,
	useCursorMode,
	useInReplayMode,
	useSetSidebarOpen,
	useSidebarState,
} from "@/lib/session/hooks";
import type { CursorMode } from "@/lib/session/types";
import { INSPECTOR_RAIL_WIDTH, useInspectorActive } from "@/lib/ui/inspector";

/** Shared sidebar open/close animation config. */
const SIDEBAR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

/** Width of the structure sidebar in pixels (w-80). */
const STRUCTURE_SIDEBAR_WIDTH = 320;

/** Width of the collapsed structure icon rail in pixels (w-14). */
const STRUCTURE_RAIL_WIDTH = 56;

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
	/** Whether the app was loaded from Firestore (not a new build). */
	isExistingApp: boolean;
	/** Server-rendered thread history for ChatContainer. */
	children?: ReactNode;
}

export function BuilderContentArea({
	isCentered,
	onCursorModeChange,
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
	 * (sidebar toggle, cursor mode switch), not on every keystroke or message. */
	const { open: chatOpen } = useSidebarState("chat");
	const { open: structureOpen } = useSidebarState("structure");
	const cursorMode = useCursorMode();
	const setSidebarOpen = useSetSidebarOpen();

	/* The right rail belongs to the inspector while a surface claims it:
	 * it widens past the chat's resting width and stays open even when
	 * the chat sidebar is toggled closed — a selection without a visible
	 * properties panel would be dead UI. */
	const inspectorActive = useInspectorActive();
	const railWidth = inspectorActive
		? INSPECTOR_RAIL_WIDTH
		: chatOpen
			? CHAT_SIDEBAR_WIDTH
			: 0;

	const showProgress = phase === BuilderPhase.Generating && !inReplayMode;

	/* The case-list workspace carries no cursor-mode toggle: selection
	 * is its mode and Preview is a first-class tab, so the pill would
	 * be a second, contradictory preview affordance. In pointer mode
	 * the pill stays even on case URLs — it's the only exit. */
	const loc = useLocation();
	const onCaseSurface =
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "case-preview";
	const showToolbar =
		isReady && hasData && !(onCaseSurface && cursorMode === "edit");

	return (
		<div className="relative flex-1 overflow-hidden flex">
			{/* Structure sidebar (left) — full tree when open, icon rail when
			 *  collapsed. The rail keeps every destination (modules, each
			 *  case list, every form) one click away, so collapsing trades
			 *  width for labels, never for reach. Pointer mode unmounts the
			 *  whole strip — immersive testing hides builder chrome. */}
			<AnimatePresence initial={false}>
				{!isCentered && hasData && cursorMode !== "pointer" && (
					<motion.div
						key="structure"
						initial={{ width: 0 }}
						animate={{
							width: structureOpen
								? STRUCTURE_SIDEBAR_WIDTH
								: STRUCTURE_RAIL_WIDTH,
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
						{/* Floating reopen button for the collapsed chat sidebar.
						 *  Hidden in pointer mode — sidebars are force-closed for
						 *  immersive testing, so an expand icon would be
						 *  misleading. (The structure sidebar needs no floating
						 *  button: its collapsed state is the icon rail.)
						 *
						 *  On case surfaces the workspace pins a sticky, near-opaque
						 *  tab row (z-raised) across the canvas top; a top-3 button
						 *  would sit underneath it — hidden AND click-shielded — so
						 *  the affordance drops below the row's ~64px band there. */}
						{cursorMode !== "pointer" && !chatOpen && !inspectorActive && (
							<Tooltip content="Open chat" placement="left">
								<button
									type="button"
									onClick={() => setSidebarOpen("chat", true)}
									className={`absolute right-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer ${
										onCaseSurface ? "top-[4.5rem]" : "top-3"
									}`}
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
									onBack={() => navigate.back()}
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
		</div>
	);
}
