"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronUp from "@iconify-icons/tabler/chevron-up";
import tablerHistory from "@iconify-icons/tabler/history";
import tablerLayoutSidebarRightCollapse from "@iconify-icons/tabler/layout-sidebar-right-collapse";
import tablerMessageCircle from "@iconify-icons/tabler/message-circle";
import tablerMessagePlus from "@iconify-icons/tabler/message-plus";
import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { useActiveInspector } from "@/components/builder/inspector/activeInspector";
import { InspectorPanel } from "@/components/builder/inspector/InspectorPanel";
import {
	ChatActivityStatus,
	deriveChatActivity,
} from "@/components/chat/ChatActivityStatus";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ThreadList } from "@/components/chat/ThreadList";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { AttachmentRef, NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { useReconcilerContext } from "@/lib/collab/context";
import type { ThreadMeta } from "@/lib/db/types";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useAccessPhase,
	useAgentError,
	useAgentStage,
	useAttachmentPrep,
	useBuilderPhase,
	usePostBuildEdit,
	useProjectScopeEpoch,
	useSessionEventsEmpty,
	useSetSidebarOpen,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";
import { INSPECTOR_RAIL_WIDTH } from "@/lib/ui/inspector";

/** Sidebar panel width in pixels. Exported so siblings (e.g. cursor mode bar
 *  positioning in BuilderLayout) can derive offsets without magic numbers. */
/** The right rail is ONE width in both of its modes — full chat and
 *  docked-under-inspector. Selecting something to inspect must never
 *  change the canvas width (content reflowing as a side effect of a
 *  click reads as a glitch), so the chat's resting width IS the
 *  inspector rail's width. */
export const CHAT_SIDEBAR_WIDTH = INSPECTOR_RAIL_WIDTH;

interface ChatSidebarProps {
	centered: boolean;
	heroLogo?: ReactNode;
	/** Rendered under the chat card in centered mode — the blank-app escape
	 *  hatch on a new build. Sharing the centered column is the point: it holds
	 *  the chat above true center until it collapses away. */
	startBlankApp?: ReactNode;
	/** Locks the composer while a non-chat action owns the screen (creating a
	 *  blank app, then navigating). Distinct from `readOnly`, which hides it. */
	composerBusy?: boolean;
	/** Keep the mounted transcript/draft but make tool + thread interactions
	 * inert while its Project-bound attachment refs are re-authorized. */
	interactionBlocked?: boolean;
	/** Durable recovery shown when an interaction block cannot clear itself. */
	interactionBlockedRecovery?: {
		readonly title: string;
		readonly message: string;
		readonly actionLabel: string;
		readonly onAction: () => void;
	};
	messages: NovaUIMessage[];
	status: "submitted" | "streaming" | "ready" | "error";
	/** Send a turn. `attachments` are asset-id refs to files picked from the file
	 *  manager; the server resolves each to its stored extract or image bytes. */
	onSend: (message: { text: string; attachments?: AttachmentRef[] }) => void;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	readOnly?: boolean;
	/** When `readOnly`, an optional note shown where the composer would be —
	 *  explains why the user can't send (view-only Project access). */
	readOnlyNotice?: ReactNode;
	/** Whether the app was loaded from Postgres (not a new build).
	 *  Drives the empty-state prompt text. */
	isExistingApp?: boolean;
	/** Thread-list projection, most recently active first. */
	threads?: ThreadMeta[];
	/** The open conversation's id (the Chat instance id = thread id). */
	activeThreadId?: string;
	/** Open a conversation from the list (fetches + hydrates it). */
	onSelectThread?: (threadId: string) => Promise<boolean>;
	/** Start a fresh conversation. */
	onNewChat?: () => void;
}

interface ShortChatFallbackOptions {
	readonly centered: boolean;
	readonly docked: boolean;
	readonly veryShortViewport: boolean;
}

/** Keep the composer subtree alive while another short-height surface needs its
 * room. ChatInput and PromptInput own unsent text and staged attachments; hiding
 * this region must never reset either one. */
export function PersistentChatComposer({
	hidden,
	children,
}: {
	readonly hidden: boolean;
	readonly children: ReactNode;
}) {
	return (
		<div
			className={hidden ? "hidden" : "shrink-0"}
			aria-hidden={hidden || undefined}
			inert={hidden}
		>
			{children}
		</div>
	);
}

/** The centered welcome and inspector dock already have their own short-height
 * contracts. Only an expanded, standalone chat needs the deliberate fallback. */
export function shouldShowShortChatFallback({
	centered,
	docked,
	veryShortViewport,
}: ShortChatFallbackOptions): boolean {
	return !centered && !docked && veryShortViewport;
}

export function ChatSidebar({
	centered,
	heroLogo,
	startBlankApp,
	composerBusy,
	interactionBlocked = false,
	interactionBlockedRecovery,
	messages,
	status,
	onSend,
	addToolOutput,
	readOnly,
	readOnlyNotice,
	isExistingApp,
	threads,
	activeThreadId,
	onSelectThread,
	onNewChat,
}: ChatSidebarProps) {
	const sessionApi = useBuilderSessionApi();
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();
	const reconcilerContext = useReconcilerContext();
	const phase = useBuilderPhase();
	const setSidebarOpen = useSetSidebarOpen();

	/* Inspector dock — when something is selected for inspection, the chat
	 * condenses to a compact status row + composer beneath the inspector panel.
	 * The rail renders the panel body directly from shared selection state
	 * (`useActiveInspector`) — no claim, no portal — so it never unmounts across
	 * a preview flip and keeps its scroll for free. */
	const inspector = useActiveInspector();
	const docked = inspector !== null && !centered;
	const shortViewport = useIsBreakpoint("max", 700, "height");
	const veryShortViewport = useIsBreakpoint("max", 360, "height");
	const shortInspectorDock = docked && shortViewport;
	const shortChatFallback = shouldShowShortChatFallback({
		centered,
		docked,
		veryShortViewport,
	});
	const agentError = useAgentError();
	const agentStage = useAgentStage();
	const postBuildEdit = usePostBuildEdit();
	const attachmentPrep = useAttachmentPrep();
	const isGenerating = phase === BuilderPhase.Generating;
	/* `isLoading` and `streamOpen` are the same transport fact. Both names
	 * stay for readability at their call sites. */
	const streamOpen = status === "submitted" || status === "streaming";
	const isLoading = streamOpen;

	// True while the composer has a staged document still being read (extracted),
	// reported up from ChatInput. Drives the same "Reading your documents" status
	// the post-send resolve shows (`attachmentPrep`), so the pre-send wait isn't a
	// silent minute behind a lone "Reading…" chip.
	const [composerReading, setComposerReading] = useState(false);

	// Build-and-Project-scoped abort for in-flight document reads. A composer chip's extraction
	// stream must SURVIVE the chip unmounting on send (the doc is still streaming
	// and only that original request carries the tokens) but must NOT outlive the
	// build. It is
	// created in this effect and aborted in its cleanup — symmetric under React's
	// mount→unmount→remount. A render-phase controller aborted by an unmount cleanup
	// would stay dead (nothing re-creates it, and no re-render follows), and in dev
	// Strict Mode that left EVERY read with an already-aborted signal → an instant
	// "couldn't read". Created in the effect, the remount re-creates it and the
	// `setState` re-renders with a live signal before any chip can mount. A
	// Project epoch change also aborts the old tenant's read before the
	// authoritative snapshot can reopen the composer.
	const [extractionAbort, setExtractionAbort] =
		useState<AbortController | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionApi and scopeEpoch are the deps on PURPOSE — recreate and abort the prior build/Project-scoped controller even though the body doesn't read them.
	useEffect(() => {
		const controller = new AbortController();
		setExtractionAbort(controller);
		const unsubscribe = reconcilerContext?.subscribeProjectScopeReset(() => {
			/* Registry fan-out is synchronous with the epoch boundary. Abort here,
			 * before React's effect cleanup, so the source Project's streamed read
			 * is disowned before its promise can publish a terminal result. */
			controller.abort();
		});
		return () => {
			unsubscribe?.();
			controller.abort();
		};
	}, [reconcilerContext, sessionApi, scopeEpoch]);
	const extractionAbortSignal = extractionAbort?.signal;

	/* True while the current `submitted` window was opened by a LOCAL send —
	 * a typed message or an answered question round. A refresh-resume and the
	 * instance-death
	 * re-drive (`regenerate`) ALSO pass through `submitted` while they
	 * reconnect, but no new message is being sent there. Mapping that window to
	 * "Sending message" would replay an action that never happened on every
	 * refresh of a live run. Cleared when the status moves off `submitted`
	 * using React's derive-during-render pattern. */
	const localSendRef = useRef(false);
	const prevStatusRef = useRef(status);
	if (prevStatusRef.current !== status) {
		prevStatusRef.current = status;
		if (status !== "submitted") localSendRef.current = false;
	}

	const activity = deriveChatActivity({
		agentError,
		agentStage,
		attachmentReading: attachmentPrep || composerReading,
		isGenerating,
		phase,
		postBuildEdit,
		streamOpen,
		submittedLocally: status === "submitted" && localSendRef.current,
	});

	// Auto-decay Completed → Ready after the confirmation has remained visible.
	//
	// Gate on `bufferEmpty` — the timer must not arm until the SSE stream
	// has actually closed (endRun cleared the events buffer). `data-done`
	// stamps `runCompletedAt` mid-stream while the agent is still
	// streaming its final summary text. If the 3.5s timer fired during
	// that streaming window, `acknowledgeCompletion` would clear
	// `runCompletedAt` while the events buffer still held the run's
	// schema/scaffold/fix mutations — `derivePhase` would then flip from
	// Completed straight to Generating (foundation + stage) for a
	// fraction of a second until stream-close cleared the buffer,
	// flashing the GenerationProgress card back on screen. Waiting for
	// the buffer to empty first keeps the state forward-only, then leaves the
	// confirmation visible for 3.5 seconds before returning to rest.
	const bufferEmpty = useSessionEventsEmpty();
	useEffect(() => {
		if (phase !== BuilderPhase.Completed) return;
		if (!bufferEmpty) return;
		const id = setTimeout(
			() => sessionApi.getState().acknowledgeCompletion(),
			3500,
		);
		return () => clearTimeout(id);
	}, [phase, bufferEmpty, sessionApi]);

	// Only enable layout animation during centered↔sidebar morph, not toolbar resizes
	const [morphing, setMorphing] = useState(false);
	const prevCenteredRef = useRef(centered);
	useEffect(() => {
		if (centered !== prevCenteredRef.current) {
			setMorphing(true);
			const id = setTimeout(() => setMorphing(false), 500);
			prevCenteredRef.current = centered;
			return () => clearTimeout(id);
		}
	}, [centered]);

	// ── Conversations view ───────────────────────────────────────────────
	/* The thread list swaps into the conversation region while open. Local
	 * state on purpose: opening the list is a peek, not a navigation — any
	 * action that returns attention to the conversation (picking a thread,
	 * starting a new one, sending a message) closes it. */
	const [threadListOpen, setThreadListOpen] = useState(false);
	const [openingThreadId, setOpeningThreadId] = useState<string | null>(null);
	const showThreadAffordances =
		!centered && threads !== undefined && !!onSelectThread;
	const listVisible = threadListOpen && showThreadAffordances;

	const handleSelectThread = useCallback(
		async (threadId: string) => {
			if (interactionBlocked) return;
			if (threadId === activeThreadId) {
				setThreadListOpen(false);
				return;
			}
			if (openingThreadId) return;
			setOpeningThreadId(threadId);
			const opened = await onSelectThread?.(threadId);
			if (!opened) setOpeningThreadId(null);
		},
		[activeThreadId, interactionBlocked, onSelectThread, openingThreadId],
	);

	/* Keep the list covering the old transcript until the parent has activated
	 * the requested Chat instance. Closing it from the click handler exposed the
	 * previous conversation during the network fetch, then replaced it in-place. */
	useEffect(() => {
		if (!openingThreadId || activeThreadId !== openingThreadId) return;
		setThreadListOpen(false);
		setOpeningThreadId(null);
	}, [activeThreadId, openingThreadId]);

	const handleNewChat = useCallback(() => {
		if (interactionBlocked) return;
		setThreadListOpen(false);
		setOpeningThreadId(null);
		onNewChat?.();
	}, [interactionBlocked, onNewChat]);

	const pendingAnswerRef = useRef<((text: string) => void) | null>(null);

	/* The StickToBottom scroll context, captured from Conversation. The library's
	 * initial="instant" path still waits for ResizeObserver + rAF, which leaves one
	 * top-positioned frame when this scroll root remounts after closing History.
	 * Initialize each NEW scroll element synchronously from the imperative-ref
	 * commit instead: DOM refs and layout are ready, but the browser has not painted.
	 * Tracking element identity keeps later context updates from fighting manual
	 * scrolling; use-stick-to-bottom owns all pinning after this first position. */
	const stickContextRef = useRef<StickToBottomContext | null>(null);
	const initializedScrollElementRef = useRef<HTMLElement | null>(null);
	const captureStickContext = useCallback(
		(context: StickToBottomContext | null) => {
			stickContextRef.current = context;
			const scrollElement = context?.scrollRef.current;
			if (
				!scrollElement ||
				scrollElement === initializedScrollElementRef.current
			) {
				return;
			}

			initializedScrollElementRef.current = scrollElement;
			if (getComputedStyle(scrollElement).overflow === "visible") {
				scrollElement.style.overflow = "auto";
			}
			scrollElement.scrollTop = scrollElement.scrollHeight;
		},
		[],
	);

	const markLocalSend = useCallback(() => {
		/* Mark the coming `submitted` window as a real send. A resume or re-drive
		 * reconnect must continue to describe the app work already in progress. */
		localSendRef.current = true;
	}, []);

	/* A local turn always returns the view to the bottom, wherever the user had
	 * scrolled: jump (no animated travel through the transcript) and re-engage
	 * use-stick-to-bottom's pin, which an upward scroll releases. The jump lands
	 * on the CURRENT bottom — the new message commits a render later — and the
	 * re-engaged pin then carries it (and the streamed reply) into view via the
	 * resize follow. Incoming content alone never scrolls an escaped view; only
	 * the user's own send does. */
	const scrollToLatest = useCallback(() => {
		void stickContextRef.current?.scrollToBottom({ animation: "instant" });
	}, []);

	// Route typed messages as question answers when an AskQuestionsCard is waiting.
	// Answers are text-only (the question UI is multiple-choice); any staged
	// attachments are forwarded only on a normal send, never folded into an answer.
	// Sending returns attention to the conversation, so the thread list closes.
	const handleSend = useCallback(
		(message: { text: string; attachments?: AttachmentRef[] }) => {
			setThreadListOpen(false);
			if (pendingAnswerRef.current) {
				pendingAnswerRef.current(message.text);
			} else {
				markLocalSend();
				onSend(message);
			}
			scrollToLatest();
		},
		[markLocalSend, onSend, scrollToLatest],
	);

	// An answered question starts the same outgoing-message status as the composer
	// — and, like one, must leave the resumed stream in view even if the user had
	// unpinned the view before clicking the final option.
	const handleToolOutput = useCallback(
		(params: { tool: string; toolCallId: string; output: unknown }) => {
			if (params.tool === "askQuestions") {
				markLocalSend();
				scrollToLatest();
			}
			addToolOutput(params);
		},
		[addToolOutput, markLocalSend, scrollToLatest],
	);

	// ── Auto-scroll question cards into view when they appear ──
	let activeQuestionCount = 0;
	for (const msg of messages) {
		for (const part of msg.parts) {
			if (
				part.type === "tool-askQuestions" &&
				part.state === "input-available"
			) {
				activeQuestionCount++;
			}
		}
	}

	// use-stick-to-bottom keeps the view pinned to the latest message, but it does
	// not scroll a mid-list element into view. A new waiting question card can land
	// above the fold, so when the count of waiting cards rises we scroll the last
	// one into view. We reach the live content element through the StickToBottom
	// context (ConversationContent owns its own ref internally and exposes none),
	// then let scrollIntoView locate its own scroll ancestor.
	const prevActiveQCountRef = useRef(0);
	useEffect(() => {
		if (activeQuestionCount > prevActiveQCountRef.current) {
			requestAnimationFrame(() => {
				const content = stickContextRef.current?.contentRef.current;
				if (!content) return;
				const cards = content.querySelectorAll(
					'[data-question-card="waiting"]',
				);
				const lastCard = cards[cards.length - 1] as HTMLElement | undefined;
				if (lastCard) {
					lastCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
				}
			});
		}
		prevActiveQCountRef.current = activeQuestionCount;
	}, [activeQuestionCount]);

	return (
		<motion.div
			initial={centered ? false : { x: CHAT_SIDEBAR_WIDTH, opacity: 0 }}
			animate={{ x: 0, opacity: 1 }}
			exit={centered ? { opacity: 0 } : { x: CHAT_SIDEBAR_WIDTH, opacity: 0 }}
			transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
			className={
				centered
					? "absolute inset-0 z-raised flex flex-col items-center justify-center gap-6 px-4 pointer-events-none"
					: "shrink-0 h-full"
			}
		>
			{centered && heroLogo}
			<motion.div
				layout={morphing ? "position" : false}
				data-inspector-rail={centered ? undefined : true}
				style={centered ? undefined : { width: "100%" }}
				className={`pointer-events-auto flex flex-col overflow-hidden transition-[width,max-width,max-height,height,border-radius,border-color] duration-[450ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
					centered
						? "w-full max-w-2xl max-h-[min(700px,80vh)] rounded-2xl border border-nova-border bg-nova-deep"
						: "h-full border-l border-nova-border-bright bg-nova-deep"
				}`}
				transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
			>
				{/* Sidebar header owns only identity + collapse. Conversation actions
				 *  live in the labeled command row below instead of competing as
				 *  ambiguous icon-only controls in this title bar. */}
				{!centered && !docked && (
					<>
						<div
							className={`flex shrink-0 items-center gap-2 border-b border-nova-border pl-4 pr-2 ${
								shortChatFallback ? "h-[52px]" : "h-16"
							}`}
							data-builder-secondary-header="chat"
						>
							<span className="flex-1 min-w-0 text-sm font-medium text-nova-text">
								{listVisible ? "Conversations" : "Chat"}
							</span>
							{!shortChatFallback && (
								<SimpleTooltip content="Collapse chat" side="left">
									<Button
										type="button"
										onClick={() => setSidebarOpen("chat", false)}
										aria-label="Collapse chat sidebar"
										data-builder-sidebar-toggle="collapse-chat"
										variant="ghost"
										size="icon-lg"
										className="size-11 text-nova-text-muted not-disabled:hover:text-nova-text"
									>
										<Icon icon={tablerLayoutSidebarRightCollapse} />
									</Button>
								</SimpleTooltip>
							)}
						</div>
						{showThreadAffordances && !shortChatFallback && (
							<div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-nova-border shrink-0">
								{!readOnly && (
									<Button
										type="button"
										onClick={handleNewChat}
										disabled={interactionBlocked || openingThreadId !== null}
										variant="ghost"
										size="lg"
										className="min-h-11 justify-start text-nova-text-secondary not-disabled:hover:text-nova-text"
									>
										<Icon icon={tablerMessagePlus} />
										New chat
									</Button>
								)}
								<Button
									type="button"
									onClick={() => setThreadListOpen((open) => !open)}
									disabled={interactionBlocked || openingThreadId !== null}
									aria-pressed={listVisible}
									variant="ghost"
									size="lg"
									className="min-h-11 justify-start text-nova-text-secondary not-disabled:hover:text-nova-text aria-pressed:bg-nova-violet/10 aria-pressed:text-nova-violet-bright"
								>
									<Icon
										icon={listVisible ? tablerMessageCircle : tablerHistory}
									/>
									{listVisible ? "Back to chat" : "History"}
								</Button>
							</div>
						)}
					</>
				)}

				{/* Inspector dock — the properties panel rendered from shared
				 *  selection state, plus the condensed chat strip. The Conversation
				 *  block below unmounts while docked; messages are props, so the
				 *  thread re-renders intact (re-pinned to bottom) on expand. */}
				{docked && inspector && (
					<>
						<InspectorPanel
							kicker={inspector.kicker}
							title={inspector.title}
							onClose={inspector.onClose}
						>
							{inspector.body}
						</InspectorPanel>
						{/* The condensed conversation's grab handle — ONE full-width
						 *  row (not a label plus a small link) so the affordance is
						 *  unmissable and the target spans the rail at full height.
						 *  Clicking it closes the properties panel and gives the
						 *  rail back to the conversation. */}
						<SimpleTooltip content="Close properties and open chat" side="left">
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									// The inspector can remain visible after chat was collapsed.
									// Restore the conversation's open state before releasing the
									// rail so this action always does what its label promises.
									setSidebarOpen("chat", true);
									inspector.onClose();
								}}
								aria-label="Close properties and open chat"
								className="group h-auto min-h-11 w-full shrink-0 justify-start gap-2 rounded-none border-t border-nova-border px-4 text-left not-disabled:hover:bg-white/[0.03]"
							>
								<span className="text-sm font-medium text-nova-text-secondary">
									Chat
								</span>
								{messages.length > 0 && (
									<span className="rounded-full border border-nova-violet/25 bg-nova-violet/15 px-1.5 py-px text-xs leading-none text-nova-violet-bright">
										{messages.length}
									</span>
								)}
								<Icon
									icon={tablerChevronUp}
									width="14"
									height="14"
									className="ml-auto text-nova-text-muted group-hover:text-nova-text transition-colors"
								/>
							</Button>
						</SimpleTooltip>
					</>
				)}

				{/* Conversations list — swapped in over the conversation region
				 *  while open. The active status + composer below stay; sending
				 *  returns to the conversation (handleSend closes the list). */}
				{!docked && listVisible && !shortChatFallback && (
					<ThreadList
						threads={threads ?? []}
						activeThreadId={activeThreadId ?? ""}
						activeThreadStreaming={isLoading}
						openingThreadId={openingThreadId}
						disabled={interactionBlocked}
						onSelect={handleSelectThread}
					/>
				)}

				{/* Messages — the open conversation's transcript (hydrated
				 *  history + live turns through one render path).
				 *  Conversation (a use-stick-to-bottom root) owns the scroll: it
				 *  keeps the view pinned to the latest message and across the
				 *  center↔sidebar morph. contextRef hands us the scroll context so
				 *  the question-card autoscroll can reach the content element. */}
				{/* The card is `overflow-hidden`; the activity status + composer below are
				 *  `shrink-0` and must NEVER be clipped, so the Conversation absorbs all
				 *  flex pressure (it's the scroll region).
				 *  - Sidebar: a definite-height (`h-full`) parent, so `flex-1` distributes
				 *    the free space.
				 *  - Centered: an auto-height parent (only `max-h`). `flex-1`'s `0%` basis
				 *    would collapse the empty welcome intro to zero (no free space to grow
				 *    into); `flex-none` sizes to content but then a tall conversation
				 *    overflows the `max-h` and pushes the composer past the clip. `flex-auto`
				 *    is the fix: its basis is the CONTENT height (welcome intro sizes
				 *    naturally), and `min-h-0` lets it shrink + scroll once content exceeds
				 *    `max-h`, keeping the composer on-screen. */}
				{!docked && !listVisible && !shortChatFallback && (
					<Conversation
						key={activeThreadId}
						className={centered ? "flex-auto min-h-0" : "flex-1"}
						contextRef={captureStickContext}
						inert={interactionBlocked}
						aria-busy={interactionBlocked || undefined}
					>
						{/* ConversationContent's base `gap-8` is roomier than Nova's chat
						 *  density; override to `gap-4`. Single-source the spacing via gap
						 *  rather than stacking margins. */}
						<ConversationContent className="gap-4 p-4">
							{/* Empty-conversation state */}
							{messages.length === 0 &&
								!isLoading &&
								(centered ? (
									<WelcomeIntro />
								) : (
									<ConversationEmptyState
										title=""
										description={
											isExistingApp
												? "What changes would you like to make?"
												: "Describe the app you want to build"
										}
									/>
								))}

							{/* Live messages from the active useChat session. Only the last
							 *  message can be mid-stream, so it alone receives isStreaming —
							 *  the reasoning panel narrows that to "trailing part is still
							 *  reasoning" so the shimmer stops once answer tokens arrive. */}
							{messages.map((msg, msgIndex) => (
								<ChatMessage
									key={msg.id}
									message={msg}
									addToolOutput={handleToolOutput}
									pendingAnswerRef={pendingAnswerRef}
									toolInteractionsDisabled={interactionBlocked}
									isStreaming={isLoading && msgIndex === messages.length - 1}
								/>
							))}
						</ConversationContent>
						<ConversationScrollButton />
					</Conversation>
				)}

				{/* Resting chat has no status chrome. Work in progress uses one compact,
				 * plain-language row that yields entirely in a short inspector dock. */}
				{!shortInspectorDock && !shortChatFallback && (
					<ChatActivityStatus state={activity.state} label={activity.label} />
				)}

				{interactionBlockedRecovery && !shortChatFallback && (
					<div
						role="alert"
						className="mx-3 mb-3 flex shrink-0 items-center gap-3 rounded-xl border border-nova-amber/30 bg-nova-amber/[0.06] p-3"
					>
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium text-nova-text">
								{interactionBlockedRecovery.title}
							</p>
							<p className="mt-0.5 text-xs leading-5 text-nova-text-muted">
								{interactionBlockedRecovery.message}
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="lg"
							onClick={interactionBlockedRecovery.onAction}
							className="min-h-11 shrink-0"
						>
							{interactionBlockedRecovery.actionLabel}
						</Button>
					</div>
				)}

				{/* A view-only member sees why they can't send, where the composer
				 *  would be — only when a notice is supplied for the
				 *  read-only-access case. */}
				{!shortInspectorDock &&
					!shortChatFallback &&
					readOnly &&
					readOnlyNotice && (
						<div className="shrink-0 px-4 py-3 text-sm text-nova-text-muted border-t border-nova-border">
							{readOnlyNotice}
						</div>
					)}

				{shortChatFallback && (
					<ShortChatFallback onCollapse={() => setSidebarOpen("chat", false)} />
				)}

				{/* Input — absent only in read-only mode. Short layouts keep its
				 * subtree mounted so opening an inspector cannot erase a draft or
				 * staged attachment. */}
				<PersistentChatComposer
					hidden={
						shortInspectorDock ||
						shortChatFallback ||
						(readOnly === true && accessPhase === "authorized")
					}
				>
					<ChatInput
						onSend={handleSend}
						disabled={
							isLoading ||
							isGenerating ||
							composerBusy ||
							readOnly ||
							accessPhase !== "authorized"
						}
						// The spinner means "your turn is on its way to the SA", so it
						// tracks only the chat sources. `composerBusy` locks the composer
						// for a reason that has nothing to do with a message.
						submitting={isLoading || isGenerating}
						// A waiting question card routes the next composer send to it as
						// a text-only answer, so the composer disables attaching and
						// preserves any staged files instead of dropping them.
						answerPending={activeQuestionCount > 0}
						centered={centered}
						// "Describe the app" fits only the opening prompt of a
						// brand-new build; the moment a message exists (sent or
						// streaming) it becomes an edit conversation, so flip to the
						// change-oriented copy then, not when the layout docks.
						openingPrompt={centered && messages.length === 0}
						// Lift "a staged doc is still being read" into the status row.
						onReadingChange={setComposerReading}
						// Build-scoped abort keeps the read alive after its chip unmounts.
						extractionAbortSignal={extractionAbortSignal}
					/>
				</PersistentChatComposer>
			</motion.div>

			{/* Under the card, inside the same centered column — sharing it is the
			 *  point: this holds the chat above true center, and the chat settles
			 *  back to center as this collapses away. */}
			{centered && startBlankApp}
		</motion.div>
	);
}

/** A complete replacement for an unusable composer fragment. ChatContainer
 * stays mounted behind it, so an active stream continues uninterrupted. */
export function ShortChatFallback({
	onCollapse,
}: {
	readonly onCollapse: () => void;
}) {
	return (
		<section
			aria-labelledby="short-chat-fallback-title"
			data-short-chat-fallback
			className="flex min-h-0 flex-1 flex-col justify-center gap-2 p-2"
		>
			<div className="px-1">
				<h2
					id="short-chat-fallback-title"
					className="text-sm font-semibold text-nova-text"
				>
					Chat needs more room
				</h2>
				<p className="text-xs leading-5 text-nova-text-muted">
					Make the window taller to continue
				</p>
			</div>
			<Button
				type="button"
				variant="outline"
				size="xl"
				onClick={onCollapse}
				className="w-full"
			>
				<Icon icon={tablerLayoutSidebarRightCollapse} />
				Collapse chat
			</Button>
		</section>
	);
}

/** Friendly opening copy with a brief, non-blocking entrance transition. */
function WelcomeIntro() {
	return (
		// Render through the same message shell every reply uses so the opening turn
		// sits in the same column. Heading + subtitle are ONE unit, so they share a
		// single wrapper child: the shell spaces SEPARATE turns at gap-4, and splitting
		// the pair across two children would drop that 16px between a title and its own
		// caption — the tight gap-1.5 here owns the pair's rhythm instead.
		<Message from="assistant">
			<MessageContent>
				<div className="flex flex-col gap-1.5">
					<motion.h1
						initial={{ opacity: 0, y: 6 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
						className="text-lg font-display font-medium text-nova-text"
					>
						What do you want to build?
					</motion.h1>
					<motion.p
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{
							delay: 0.08,
							duration: 0.35,
							ease: [0.4, 0, 0.2, 1],
						}}
						className="text-nova-text-secondary text-sm leading-relaxed"
					>
						Describe the workflows, information, and people your app needs to
						support
					</motion.p>
				</div>
			</MessageContent>
		</Message>
	);
}
