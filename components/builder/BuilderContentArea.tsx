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
 * Below the narrow-canvas breakpoint, both 56px icon rails stay in flow
 * and the single expanded flank overlays the canvas instead. On compact
 * handsets those rails become a bottom panel dock, restoring the full canvas
 * width while keeping both drawers one tap away. The session's desktop
 * open-state is preserved; `narrowPanel` owns only that local choice.
 *
 * Children (PreviewShell, GenerationProgress) are self-sufficient —
 * they subscribe to their own state from the store. This component only
 * controls mount/unmount and animation wrappers.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerLayoutSidebarLeftExpand from "@iconify-icons/tabler/layout-sidebar-left-expand";
import tablerMessageChatbot from "@iconify-icons/tabler/message-chatbot";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
import { PreviewShell } from "@/components/preview/PreviewShell";
import { Button } from "@/components/shadcn/button";
import {
	Drawer,
	DrawerBackdrop,
	DrawerPopup,
	DrawerPortal,
	DrawerTitle,
	DrawerViewport,
} from "@/components/shadcn/drawer";
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
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";
import {
	COMPACT_BUILDER_RAIL_BREAKPOINT,
	COMPACT_INSPECTOR_RAIL_WIDTH,
	INSPECTOR_RAIL_WIDTH,
	useInspectorContext,
} from "@/lib/ui/inspector";

/** Width of the collapsed icon rails (w-14) — structure and chat
 *  share it, so the two edges read as one system. */
const COLLAPSED_RAIL_WIDTH = 56;

/** Below this width, reserving two 300px panels would leave the canvas
 * unusable. One expanded flank overlays the canvas instead. The intermediate
 * layout keeps icon rails; the handset layout moves those actions to a dock.
 * Keep 1024px-and-up desktop geometry unchanged. */
export const NARROW_BUILDER_OVERLAY_BREAKPOINT = 960;

/** A compact handset cannot afford even two collapsed side rails: at 320px
 * they consume 35% of the canvas before the authored surface adds its own
 * spacing. The same drawers stay available from a bottom panel dock, which
 * trades inexpensive vertical space for the full authoring width. This lines
 * up with the header's two-row compact composition. */
export const HANDSET_BUILDER_DOCK_BREAKPOINT = 560;

type NarrowPanel = "structure" | "right" | null;
type SidebarToggleIntent =
	| "collapse-structure"
	| "expand-structure"
	| "collapse-chat"
	| "expand-chat";

const SIDEBAR_TOGGLE_OUTCOME: Record<
	SidebarToggleIntent,
	{
		readonly sidebar: "structure" | "chat";
		readonly open: boolean;
		readonly focus: SidebarToggleIntent;
	}
> = {
	"collapse-structure": {
		sidebar: "structure",
		open: false,
		focus: "expand-structure",
	},
	"expand-structure": {
		sidebar: "structure",
		open: true,
		focus: "collapse-structure",
	},
	"collapse-chat": {
		sidebar: "chat",
		open: false,
		focus: "expand-chat",
	},
	"expand-chat": {
		sidebar: "chat",
		open: true,
		focus: "collapse-chat",
	},
};

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
	/** True when the page loaded a `generating` app — a live-thread resume
	 *  reconnects to an initial BUILD run. */
	appGenerating?: boolean;
	/** The signed-in user, for owner-scoped chat notices. */
	currentUserId?: string;
}

export function BuilderContentArea({
	isCentered,
	isExistingApp,
	threads,
	initialThread,
	appGenerating,
	currentUserId,
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
	const reduceMotion = useReducedMotion();
	const sidebarTransition = reduceMotion
		? ({ duration: 0 } as const)
		: SIDEBAR_TRANSITION;
	const setSidebarOpen = useSetSidebarOpen();
	const compactDesktopRails = useIsBreakpoint(
		"max",
		COMPACT_BUILDER_RAIL_BREAKPOINT,
	);
	const narrowLayout = useIsBreakpoint(
		"max",
		NARROW_BUILDER_OVERLAY_BREAKPOINT,
	);
	const handsetLayout = useIsBreakpoint("max", HANDSET_BUILDER_DOCK_BREAKPOINT);
	const openRailWidth = compactDesktopRails
		? COMPACT_INSPECTOR_RAIL_WIDTH
		: INSPECTOR_RAIL_WIDTH;
	/* Narrow overlays are deliberately local layout state. The session's
	 * desktop open-state stays intact across viewport changes, while a newly
	 * narrow canvas always starts with both panel actions reachable. */
	const [narrowPanel, setNarrowPanel] = useState<NarrowPanel>(null);
	const rowRef = useRef<HTMLDivElement>(null);
	const rightDrawerPopupRef = useRef<HTMLDivElement>(null);
	const pendingSidebarToggleRef = useRef<SidebarToggleIntent | null>(null);
	const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
		null,
	);
	const bindRow = useCallback((node: HTMLDivElement | null) => {
		rowRef.current = node;
		setPortalContainer(node);
	}, []);
	const captureSidebarToggleIntent = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			/* Desktop sidebars replace their activating toggle with its reciprocal.
			 * Capture the user's intent before the clicked control unmounts so the
			 * committed layout can keep keyboard focus on the same operation. Narrow
			 * drawers retain their triggers and let Base UI restore focus instead. */
			if (narrowLayout) return;
			if (!(event.target instanceof Element)) return;
			const toggle = event.target.closest<HTMLElement>(
				"[data-builder-sidebar-toggle]",
			);
			const intent = toggle?.dataset.builderSidebarToggle;
			if (intent !== undefined && intent in SIDEBAR_TOGGLE_OUTCOME) {
				pendingSidebarToggleRef.current = intent as SidebarToggleIntent;
			}
		},
		[narrowLayout],
	);
	useLayoutEffect(() => {
		const intent = pendingSidebarToggleRef.current;
		if (intent === null) return;
		const outcome = SIDEBAR_TOGGLE_OUTCOME[intent];
		const outcomeReached =
			outcome.sidebar === "structure"
				? structureOpen === outcome.open
				: chatOpen === outcome.open;
		if (!outcomeReached) return;
		pendingSidebarToggleRef.current = null;
		rowRef.current
			?.querySelector<HTMLElement>(
				`[data-builder-sidebar-toggle="${outcome.focus}"]`,
			)
			?.focus({ preventScroll: true });
	}, [chatOpen, structureOpen]);

	/* The right rail belongs to the inspector while a surface claims it:
	 * it stays open even when the chat sidebar is toggled closed — a
	 * selection without a visible properties panel would be dead UI.
	 * Chat and inspector share ONE live width, so claiming the rail never
	 * reflows the canvas. Open rails compact together on narrow desktops;
	 * the overlay layout reserves only icon rails, or the bottom dock on a
	 * handset. */
	const { active: inspectorActive, requestClose: closeInspector } =
		useInspectorContext();
	const previousInspectorActiveRef = useRef(false);
	const previousNarrowLayoutRef = useRef(narrowLayout);
	useLayoutEffect(() => {
		if (!narrowLayout) {
			setNarrowPanel(null);
		} else if (
			inspectorActive &&
			(!previousInspectorActiveRef.current || !previousNarrowLayoutRef.current)
		) {
			/* A selection must never create an invisible inspector. It borrows
			 * the same right overlay as chat without reserving canvas width. */
			setNarrowPanel("right");
		} else if (!inspectorActive && previousInspectorActiveRef.current) {
			/* Leaving Properties for a center-canvas workbench (or closing the
			 * selection directly) must dismiss the borrowed overlay. Keeping its
			 * local "right" choice would immediately replace Properties with Chat,
			 * covering the workbench that just opened. Preserve an explicitly opened
			 * Structure drawer if that action was what displaced Properties. */
			setNarrowPanel((current) => (current === "right" ? null : current));
		}
		previousInspectorActiveRef.current = inspectorActive;
		previousNarrowLayoutRef.current = narrowLayout;
	}, [inspectorActive, narrowLayout]);

	useEffect(() => {
		if (!narrowLayout) return;
		setNarrowPanel((current) => {
			if (current === "structure" && !structureOpen) return null;
			if (current === "right" && !chatOpen && !inspectorActive) return null;
			return current;
		});
	}, [chatOpen, inspectorActive, narrowLayout, structureOpen]);

	const expandStructure = useCallback(() => {
		setNarrowPanel("structure");
		setSidebarOpen("structure", true);
		/* On a narrow canvas, an inspector claim has right-overlay priority.
		 * Clear the selection so the requested structure panel can take over. */
		if (narrowLayout && inspectorActive) closeInspector();
	}, [closeInspector, inspectorActive, narrowLayout, setSidebarOpen]);
	const expandChat = useCallback(() => {
		setNarrowPanel("right");
		setSidebarOpen("chat", true);
	}, [setSidebarOpen]);

	const effectiveNarrowPanel: NarrowPanel = inspectorActive
		? "right"
		: narrowPanel;
	const narrowStructureOpen =
		narrowLayout && effectiveNarrowPanel === "structure" && structureOpen;
	const narrowRightOpen =
		narrowLayout &&
		effectiveNarrowPanel === "right" &&
		(inspectorActive || chatOpen);
	const dismissNarrowOverlay = useCallback(() => {
		setNarrowPanel(null);
		if (inspectorActive) closeInspector();
	}, [closeInspector, inspectorActive]);
	const railWidth = inspectorActive
		? openRailWidth
		: chatOpen
			? openRailWidth
			: 0;

	/* Flank widths as the flex row will actually lay them out THIS render —
	 * these feed the glide geometry, so they must mirror the JSX below. */
	const showFlanks = !isCentered && hasData;
	const structureColumnVisible = showFlanks && !previewing;
	const handsetDockVisible = structureColumnVisible && handsetLayout;
	const sideRailsVisible = structureColumnVisible && !handsetLayout;
	const structureWidth = sideRailsVisible
		? narrowLayout
			? COLLAPSED_RAIL_WIDTH
			: structureOpen
				? openRailWidth
				: COLLAPSED_RAIL_WIDTH
		: 0;
	const chatRailWidth =
		sideRailsVisible && (narrowLayout || (!chatOpen && !inspectorActive))
			? COLLAPSED_RAIL_WIDTH
			: 0;
	const spacerWidth = isCentered || previewing || narrowLayout ? 0 : railWidth;
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
	const chatParked =
		!isCentered &&
		(previewing || (narrowLayout ? !narrowRightOpen : railWidth === 0));

	const showProgress = phase === BuilderPhase.Generating;

	return (
		<div
			ref={bindRow}
			onClickCapture={captureSidebarToggleIntent}
			className="relative flex min-w-0 flex-1 overflow-hidden"
			data-builder-layout={
				handsetLayout ? "handset" : narrowLayout ? "narrow" : "desktop"
			}
		>
			{/* Structure sidebar (left) — full tree when open, icon rail when
			 *  collapsed or when the narrow overlay is parked. The rail keeps
			 *  every destination (modules, each
			 *  case list, every form) one click away, so collapsing trades
			 *  width for labels, never for reach. popLayout pops the exiting
			 *  column out of the flow while it slides off-screen; the exit
			 *  carries z-raised because the canvas column behind it is a
			 *  positioned sibling LATER in the DOM, which would otherwise
			 *  paint its full-width strips over the departing panel. Exit
			 *  only — a resting z would form a stacking context that flattens
			 *  the sidebar's own popovers below canvas ones. */}
			<AnimatePresence initial={false} mode="popLayout">
				{sideRailsVisible && (
					<motion.div
						key="structure"
						className={`relative h-full shrink-0 ${
							narrowStructureOpen
								? "z-raised overflow-visible"
								: "overflow-hidden"
						}`}
						data-builder-flank="structure"
						style={{ width: structureWidth }}
						initial={{ x: "-100%" }}
						animate={{ x: 0, width: structureWidth }}
						exit={{ x: "-100%", zIndex: "var(--z-raised)" }}
						transition={sidebarTransition}
					>
						{narrowLayout ? (
							<AppTreeRail onExpand={expandStructure} />
						) : structureOpen ? (
							<StructureSidebar />
						) : (
							<AppTreeRail onExpand={expandStructure} />
						)}
					</motion.div>
				)}
			</AnimatePresence>

			{/* Main scrollable content */}
			<AnimatePresence>
				{!isCentered && (
					<motion.div
						className={`relative flex min-w-0 flex-1 flex-col overflow-hidden${
							narrowLayout ? " z-ground" : ""
						}${handsetDockVisible ? " pb-14" : ""}`}
						data-builder-canvas
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={
							reduceMotion ? { duration: 0 } : { duration: 0.3, delay: 0.15 }
						}
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
									transition={
										reduceMotion
											? { duration: 0 }
											: { duration: 1, ease: [0.4, 0, 0.2, 1] }
									}
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

			{/* Chat spacer — on desktop, owns the chat panel's LAYOUT width (the visual
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
					data-builder-flank="chat-spacer"
					style={{
						width: spacerWidth,
						transition: modeFlip
							? "none"
							: "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
					}}
				/>
			)}

			{/* Collapsed chat = the icon rail at the right edge, the mirror
			 *  of the structure side. On desktop it steps aside (width 0, still
			 *  mounted) whenever the inspector claims the rail or chat opens.
			 *  Narrow layout retains that 56px slot so the center never reflows;
			 *  the right overlay covers it while open. Mode
			 *  flips unmount it through the same popLayout slide as the
			 *  structure column. */}
			<AnimatePresence initial={false} mode="popLayout">
				{sideRailsVisible && (
					<motion.div
						key="chat-rail"
						className="h-full shrink-0 overflow-hidden"
						data-builder-flank="chat"
						style={{ width: chatRailWidth }}
						initial={{ x: "100%" }}
						animate={{ x: 0, width: chatRailWidth }}
						exit={{ x: "100%" }}
						transition={sidebarTransition}
					>
						{!narrowLayout || !narrowRightOpen ? (
							<ChatRail onExpand={expandChat} />
						) : null}
					</motion.div>
				)}
			</AnimatePresence>

			{/* Handsets use the Material compact-screen pattern: a bottom panel
			 * dock instead of permanent side navigation. Both actions keep a
			 * 44px target and open the exact same focus-managed drawers as the
			 * side rails; only their parked presentation changes. Reserving the
			 * dock's height on the canvas prevents it from covering authored UI. */}
			{handsetDockVisible ? (
				<nav
					aria-label="Builder panels"
					data-builder-handset-dock
					className="absolute inset-x-0 bottom-0 z-raised grid h-14 grid-cols-2 gap-1 border-t border-nova-border-bright bg-nova-deep px-2 py-1.5"
				>
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={expandStructure}
						aria-label="Open app structure"
						className="h-11 min-w-0 gap-2 px-3 text-nova-text-secondary not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-text"
					>
						<Icon icon={tablerLayoutSidebarLeftExpand} width="18" height="18" />
						<span>App</span>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={expandChat}
						aria-label="Open chat"
						className="h-11 min-w-0 gap-2 px-3 text-nova-text-secondary not-disabled:hover:bg-white/[0.05] not-disabled:hover:text-nova-text"
					>
						<Icon icon={tablerMessageChatbot} width="18" height="18" />
						<span>Chat</span>
					</Button>
				</nav>
			) : null}

			{/* Compact structure is a real modal drawer, not merely an overlapping
			 * panel. Base UI owns focus entry/containment, Escape and outside
			 * dismissal, document inertness, and restoration to the retained rail
			 * trigger. The desktop tree stays in its established in-flow column. */}
			{narrowLayout && (
				<Drawer
					open={narrowStructureOpen}
					modal
					swipeDirection="left"
					onOpenChange={(open) => {
						if (!open) dismissNarrowOverlay();
					}}
				>
					<DrawerPortal container={portalContainer}>
						<DrawerBackdrop data-builder-overlay-scrim="structure" />
						<DrawerViewport className="z-raised justify-start">
							<DrawerPopup
								finalFocus={() =>
									rowRef.current?.querySelector<HTMLElement>(
										handsetLayout
											? '[aria-label="Open app structure"]'
											: '[aria-label="Expand structure sidebar"]',
									) ?? false
								}
								data-builder-overlay="structure"
								className="border-r border-nova-border-bright [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-200 data-[ending-style]:-translate-x-full data-[starting-style]:-translate-x-full"
								style={{ width: `min(${openRailWidth}px, 100vw)` }}
							>
								<DrawerTitle className="sr-only">App structure</DrawerTitle>
								<StructureSidebar />
							</DrawerPopup>
						</DrawerViewport>
					</DrawerPortal>
				</Drawer>
			)}

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
			<Drawer
				open={isCentered || (narrowLayout ? narrowRightOpen : true)}
				modal={narrowLayout && !isCentered}
				disablePointerDismissal={!narrowLayout || isCentered}
				swipeDirection="right"
				onOpenChange={(open) => {
					if (narrowLayout && !open) dismissNarrowOverlay();
				}}
			>
				<DrawerPortal keepMounted container={portalContainer}>
					{narrowLayout && (
						<DrawerBackdrop
							data-builder-overlay-scrim={
								inspectorActive ? "properties" : "chat"
							}
						/>
					)}
					<DrawerViewport
						className={narrowLayout ? "z-raised justify-end" : "justify-end"}
					>
						<DrawerPopup
							ref={rightDrawerPopupRef}
							initialFocus={
								narrowLayout && !isCentered ? rightDrawerPopupRef : false
							}
							finalFocus={() => {
								const inspectorOrigin =
									rowRef.current?.querySelector<HTMLElement>(
										"[data-inspector-return-focus]",
									);
								if (inspectorOrigin !== null && inspectorOrigin !== undefined) {
									inspectorOrigin.removeAttribute(
										"data-inspector-return-focus",
									);
									return inspectorOrigin;
								}
								return (
									rowRef.current?.querySelector<HTMLElement>(
										handsetLayout
											? '[aria-label="Open chat"]'
											: '[aria-label="Expand chat sidebar"]',
									) ?? false
								);
							}}
							render={
								<motion.div
									initial={false}
									animate={{ x: !isCentered && chatParked ? "100%" : 0 }}
									transition={
										isCentered || reduceMotion
											? { duration: 0 }
											: SIDEBAR_TRANSITION
									}
									className={
										isCentered
											? ""
											: `absolute right-0 inset-y-0${
													previewing || narrowRightOpen ? " z-raised" : ""
												}`
									}
								/>
							}
							data-builder-chat-panel
							style={
								isCentered
									? undefined
									: {
											width: narrowLayout
												? `min(${openRailWidth}px, 100vw)`
												: openRailWidth,
										}
							}
							data-builder-overlay={narrowRightOpen ? "right" : undefined}
							inert={chatParked}
						>
							<DrawerTitle className="sr-only">
								{inspectorActive ? "Properties" : "Chat"}
							</DrawerTitle>
							<ErrorBoundary>
								<ChatContainer
									centered={isCentered}
									isExistingApp={isExistingApp}
									threads={threads}
									initialThread={initialThread}
									appGenerating={appGenerating}
									currentUserId={currentUserId}
								/>
							</ErrorBoundary>
						</DrawerPopup>
					</DrawerViewport>
				</DrawerPortal>
			</Drawer>
		</div>
	);
}
