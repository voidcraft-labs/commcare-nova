/**
 * BuilderContentArea — the flex row containing structure sidebar, main
 * preview content, and chat sidebar. Self-subscribes to all layout
 * visibility state (chatOpen, structureOpen, previewing, isReady, hasData)
 * so BuilderLayout doesn't need to.
 *
 * ## Mode-flip choreography (see ContentFrame.tsx for the full why)
 *
 * Toggling Preview commits the final layout in a SINGLE render, then
 * everything that visually travels does so via transforms on the shared
 * `SIDEBAR_TRANSITION`:
 *
 *   - The structure column and the collapsed chat rail mount/unmount
 *     through `AnimatePresence mode="popLayout"` — an exiting column is
 *     popped out of the flex flow instantly (the canvas gets its final
 *     width in one commit) while the popped element slides off-screen;
 *     an entering column takes its layout slot immediately and slides
 *     in from off-screen into it.
 *   - The chat panel must NEVER unmount (ChatContainer owns the live
 *     useChat stream, the draft, and run-boundary refs — unmounting
 *     would sever an active run), so it can't ride popLayout. Instead
 *     it is an absolutely-positioned right dock that slides via `x`,
 *     with an in-flow SPACER owning its layout width. The spacer snaps
 *     on mode flips (one layout commit) and tweens on manual open/close
 *     and inspector claims, mirroring the panel's slide.
 *   - Centered canvas content glides through `ModeFlipGlideProvider` +
 *     `ContentFrame`.
 *
 * Manual sidebar toggles (collapse to rail, open/close chat) keep the
 * plain width tween — one-sided, small travel, content reflows natively.
 *
 * Children (PreviewShell, GenerationProgress) are self-sufficient —
 * they subscribe to their own state from the store. This component only
 * controls mount/unmount and animation wrappers.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { AppTreeRail } from "@/components/builder/appTree/AppTreeRail";
import { BreadcrumbStrip } from "@/components/builder/BreadcrumbStrip";
import {
	ModeFlipGlideProvider,
	SIDEBAR_TRANSITION,
} from "@/components/builder/ContentFrame";
import { GenerationProgress } from "@/components/builder/GenerationProgress";
import { StructureSidebar } from "@/components/builder/StructureSidebar";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { ChatRail } from "@/components/chat/ChatRail";
import { CHAT_SIDEBAR_WIDTH } from "@/components/chat/ChatSidebar";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import type { ThreadDoc, ThreadMeta } from "@/lib/db/types";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useBuilderIsReady,
	useBuilderPhase,
	usePreviewing,
	useSetSidebarOpen,
	useSidebarState,
} from "@/lib/session/hooks";
import { INSPECTOR_RAIL_WIDTH, useInspectorActive } from "@/lib/ui/inspector";

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
	/** Whether the app was loaded from Postgres (not a new build). */
	isExistingApp: boolean;
	/** Thread-list projection for ChatContainer — loaded by the RSC page. */
	threads?: ThreadMeta[];
	/** The most recently active thread, transcript included. */
	initialThread?: ThreadDoc | null;
}

export function BuilderContentArea({
	isCentered,
	isExistingApp,
	threads,
	initialThread,
}: BuilderContentAreaProps) {
	const phase = useBuilderPhase();
	const isReady = useBuilderIsReady();
	const hasData = useDocHasData();

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

	/* Flank widths as the flex row will actually lay them out THIS render —
	 * these feed the glide geometry, so they must mirror the JSX below. */
	const showFlanks = !isCentered && hasData;
	const structureColumnVisible = showFlanks && !previewing;
	const structureWidth = structureColumnVisible
		? structureOpen
			? STRUCTURE_SIDEBAR_WIDTH
			: COLLAPSED_RAIL_WIDTH
		: 0;
	const chatRailWidth =
		structureColumnVisible && !chatOpen && !inspectorActive
			? COLLAPSED_RAIL_WIDTH
			: 0;
	const spacerWidth = isCentered || previewing ? 0 : railWidth;
	const rightWidth = spacerWidth + chatRailWidth;

	/* True only on the render where `previewing` changed — the render
	 * whose layout the flip must commit in one frame. The chat spacer
	 * snaps its width on exactly that render; everything else animates
	 * via transforms. */
	const prevPreviewingRef = useRef(previewing);
	const modeFlip = previewing !== prevPreviewingRef.current;
	useEffect(() => {
		prevPreviewingRef.current = previewing;
	});

	/* Parked = the chat panel is fully off-screen right: preview mode, or
	 * closed with no inspector claim. `inert` keeps its focusables out of
	 * the tab order while parked (off-screen ≠ unfocusable). */
	const chatParked = !isCentered && (previewing || railWidth === 0);

	const rowRef = useRef<HTMLDivElement>(null);
	const showProgress = phase === BuilderPhase.Generating;

	return (
		<div ref={rowRef} className="relative flex-1 overflow-hidden flex">
			{/* Structure sidebar (left) — full tree when open, icon rail when
			 *  collapsed. The rail keeps every destination (modules, each
			 *  case list, every form) one click away, so collapsing trades
			 *  width for labels, never for reach. popLayout pops the exiting
			 *  column out of the flow while it slides off-screen; the exit
			 *  carries z-raised because the canvas column behind it is a
			 *  positioned sibling LATER in the DOM, which would otherwise
			 *  paint its full-width strips over the departing panel. Exit
			 *  only — a resting z would form a stacking context that flattens
			 *  the sidebar's own popovers below canvas ones. */}
			<AnimatePresence initial={false} mode="popLayout">
				{structureColumnVisible && (
					<motion.div
						key="structure"
						className="h-full shrink-0 overflow-hidden"
						style={{ width: structureWidth }}
						initial={{ x: "-100%" }}
						animate={{ x: 0, width: structureWidth }}
						exit={{ x: "-100%", zIndex: "var(--z-raised)" }}
						transition={SIDEBAR_TRANSITION}
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
						className="flex-1 overflow-hidden relative flex flex-col"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.3, delay: 0.15 }}
					>
						<ModeFlipGlideProvider
							previewing={previewing}
							leftWidth={structureWidth}
							rightWidth={rightWidth}
							rowRef={rowRef}
						>
							{/* Breadcrumb strip — wayfinding lives in the canvas column,
							 *  not the header, so the sidebars bound its width and a long
							 *  trail collapses instead of reaching the centered Preview
							 *  toggle. */}
							{isReady && hasData && <BreadcrumbStrip />}
							<ErrorBoundary>
								{isReady && hasData ? (
									<div className="flex-1 min-h-0">
										<PreviewShell onBack={() => navigate.back()} />
									</div>
								) : null}
							</ErrorBoundary>
						</ModeFlipGlideProvider>

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

			{/* Chat spacer — owns the chat panel's LAYOUT width (the visual
			 *  panel is the absolute dock below). A plain div, NOT a motion
			 *  one: on a mode flip its width must change in the same React
			 *  commit as the popped sidebars (Motion applies even duration-0
			 *  targets a frame later, which paints one half-committed frame),
			 *  so the flip render disables the CSS transition and writes the
			 *  width synchronously. Manual open/close and inspector claims
			 *  tween via the CSS transition, mirroring the panel's slide. */}
			{!isCentered && (
				<div
					className="shrink-0"
					style={{
						width: spacerWidth,
						transition: modeFlip
							? "none"
							: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
					}}
				/>
			)}

			{/* Collapsed chat = the icon rail at the right edge, the mirror
			 *  of the structure side. It steps aside (width 0, still mounted)
			 *  whenever the inspector claims the rail or chat opens; mode
			 *  flips unmount it through the same popLayout slide as the
			 *  structure column. */}
			<AnimatePresence initial={false} mode="popLayout">
				{structureColumnVisible && (
					<motion.div
						key="chat-rail"
						className="h-full shrink-0 overflow-hidden"
						style={{ width: chatRailWidth }}
						initial={{ x: "100%" }}
						animate={{ x: 0, width: chatRailWidth }}
						exit={{ x: "100%" }}
						transition={SIDEBAR_TRANSITION}
					>
						<ChatRail onExpand={() => setSidebarOpen("chat", true)} />
					</motion.div>
				)}
			</AnimatePresence>

			{/* Chat panel — ALWAYS mounted: ChatContainer owns the live
			 *  useChat stream, the composer draft, and run-boundary refs, so
			 *  unmounting would sever an active run. In builder mode it's an
			 *  absolute right dock sliding via transform over the spacer's
			 *  reserved gap; parked, it sits past the row's right edge
			 *  (clipped by the row's overflow-hidden). z-raised only while
			 *  previewing — it must paint above the canvas as it slides out,
			 *  but at rest it must NOT form a stacking context that would
			 *  flatten the inspector's popovers/tooltips below canvas ones.
			 *  In centered mode the wrapper is invisible to layout (auto
			 *  width, no positioning) so ChatSidebar's absolute centered
			 *  composer works. */}
			<motion.div
				initial={false}
				animate={{ x: !isCentered && chatParked ? "100%" : 0 }}
				transition={isCentered ? { duration: 0 } : SIDEBAR_TRANSITION}
				className={
					isCentered
						? ""
						: `absolute right-0 inset-y-0${previewing ? " z-raised" : ""}`
				}
				style={isCentered ? undefined : { width: CHAT_SIDEBAR_WIDTH }}
				inert={chatParked}
			>
				<ErrorBoundary>
					<ChatContainer
						centered={isCentered}
						isExistingApp={isExistingApp}
						threads={threads}
						initialThread={initialThread}
					/>
				</ErrorBoundary>
			</motion.div>
		</div>
	);
}
