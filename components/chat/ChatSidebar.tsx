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
	useContext,
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
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { SignalGrid } from "@/components/chat/SignalGrid";
import { SignalPanel } from "@/components/chat/SignalPanel";
import { ThreadList } from "@/components/chat/ThreadList";
import { Button } from "@/components/shadcn/button";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import type { AttachmentRef, NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { ThreadMeta } from "@/lib/db/types";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	derivePhase,
	useAgentError,
	useAgentStage,
	useAttachmentPrep,
	useBuilderPhase,
	usePostBuildEdit,
	useSessionEventsEmpty,
	useSetSidebarOpen,
	useStatusMessage,
} from "@/lib/session/hooks";
import { deriveAgentStage } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { signalGrid } from "@/lib/signalGrid/store";
import {
	defaultLabel,
	SignalGridController,
	type SignalMode,
} from "@/lib/signalGridController";
import { INSPECTOR_RAIL_WIDTH, useInspectorContext } from "@/lib/ui/inspector";
import {
	computeScaffoldProgress,
	deriveGenerationSignalMode,
} from "./scaffoldProgress";

/** Sidebar panel width in pixels. Exported so siblings (e.g. cursor mode bar
 *  positioning in BuilderLayout) can derive offsets without magic numbers. */
/** The right rail is ONE width in both of its modes — full chat and
 *  docked-under-inspector. Selecting something to inspect must never
 *  change the canvas width (content reflowing as a side effect of a
 *  click reads as a glitch), so the chat's resting width IS the
 *  inspector rail's width. */
export const CHAT_SIDEBAR_WIDTH = INSPECTOR_RAIL_WIDTH;

/** Create a SignalGridController whose energy callbacks drain the module-level
 *  signalGrid nanostore. Scaffold progress is computed on each poll from the
 *  live session + doc store states — callers pass refs so the controller always
 *  reads the current instances even if the builder is remounted. */
function createGridController(
	sessionRef: { current: BuilderSessionStoreApi },
	docStoreRef: { current: BlueprintDocStore | null },
): SignalGridController {
	return new SignalGridController({
		consumeEnergy: () => signalGrid.drainEnergy(),
		consumeThinkEnergy: () => signalGrid.drainThinkEnergy(),
		consumeScaffoldProgress: () => {
			const s = sessionRef.current.getState();
			const doc = docStoreRef.current?.getState();
			const hasData = (doc?.moduleOrder.length ?? 0) > 0;
			const phase = derivePhase(
				{
					loading: s.loading,
					runCompletedAt: s.runCompletedAt,
					events: s.events,
					runStartedWithData: s.runStartedWithData,
				},
				hasData,
			);
			return computeScaffoldProgress(
				phase,
				deriveAgentStage(s.events),
				(doc?.caseTypes?.length ?? 0) > 0,
			);
		},
	});
}

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

export function ChatSidebar({
	centered,
	heroLogo,
	startBlankApp,
	composerBusy,
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
	const docStore = useContext(BlueprintDocContext);
	const phase = useBuilderPhase();
	const setSidebarOpen = useSetSidebarOpen();

	/* Inspector dock — when a builder surface claims the rail, the chat
	 * condenses to a strip (signal panel + composer) beneath the
	 * inspector slot. `setPortalEl` registers the slot node the active
	 * `InspectorSurface` portals into; `closeInspector` asks the claim's
	 * owner to clear its selection. */
	const {
		active: inspectorActive,
		setPortalEl,
		requestClose: closeInspector,
	} = useInspectorContext();
	const docked = inspectorActive && !centered;
	const railWidth = docked ? INSPECTOR_RAIL_WIDTH : CHAT_SIDEBAR_WIDTH;
	const agentError = useAgentError();
	const agentStage = useAgentStage();
	const postBuildEdit = usePostBuildEdit();
	const statusMessage = useStatusMessage();
	const attachmentPrep = useAttachmentPrep();
	const isGenerating = phase === BuilderPhase.Generating;
	/* `isLoading` and `streamOpen` are the same derived value from the
	 * transport status — the "the SSE stream is open right now" signal.
	 * Both names exist for readability: `isLoading` reads naturally in
	 * UI gating (inputs disabled, empty state hidden), while
	 * `streamOpen` is what the signal grid's desiredMode logic reasons
	 * about. Kept as one constant to avoid drift. */
	const streamOpen = status === "submitted" || status === "streaming";
	const isLoading = streamOpen;

	// ── Welcome intro timer ──────────────────────────────────────────────
	// The welcome screen plays a 3.5s "reasoning" animation on mount, then
	// settles to the quiet idle twinkle while the user reads. This is the
	// duration of the intro — after it elapses, desiredMode below falls
	// through to "idle". Lives in ChatSidebar (not WelcomeIntro) so the
	// mode flows through the normal desiredMode pipeline instead of
	// WelcomeIntro bypassing it with direct controller calls (which the
	// parent's desiredMode effect would clobber — child effects fire
	// before parent effects).
	const [introFinished, setIntroFinished] = useState(false);
	useEffect(() => {
		const id = setTimeout(() => setIntroFinished(true), 3500);
		return () => clearTimeout(id);
	}, []);

	// True while the composer has a staged document still being read (extracted),
	// reported up from ChatInput. Drives the same "Reading your documents" signal
	// the post-send resolve shows (`attachmentPrep`), so the pre-send wait isn't a
	// silent minute behind a lone "Reading…" chip.
	const [composerReading, setComposerReading] = useState(false);

	// ── Signal Grid — controller scoped to the builder instance ──────────
	// ChatSidebar is always-mounted (width animated to 0 when "closed"), so
	// refs persist across sidebar open/close. When the legacy store identity
	// changes (new app via BuilderProvider), we destroy the old controller's
	// animation loop and create a fresh one. Callbacks close over refs so
	// they always read the latest store instances — safe across the
	// teardown gap.
	const sessionApiRef = useRef(sessionApi);
	sessionApiRef.current = sessionApi;
	const docStoreRef = useRef(docStore);
	docStoreRef.current = docStore;
	const sessionIdentityRef = useRef(sessionApi);
	const gridControllerRef = useRef<SignalGridController | null>(null);
	if (sessionApi !== sessionIdentityRef.current || !gridControllerRef.current) {
		gridControllerRef.current?.destroy();
		sessionIdentityRef.current = sessionApi;
		gridControllerRef.current = createGridController(
			sessionApiRef,
			docStoreRef,
		);
	}
	const gridController = gridControllerRef.current;

	// Destroy the controller's animation loop on unmount (page navigation away)
	useEffect(
		() => () => {
			gridControllerRef.current?.destroy();
		},
		[],
	);

	// Build-scoped abort for in-flight document reads. A composer chip's extraction
	// stream must SURVIVE the chip unmounting on send (the doc is still streaming
	// into the grid, and only that original request carries the tokens) but must NOT
	// outlive the build (one build's extraction feeding another build's grid). It is
	// created in this effect and aborted in its cleanup — symmetric under React's
	// mount→unmount→remount. A render-phase controller aborted by an unmount cleanup
	// would stay dead (nothing re-creates it, and no re-render follows), and in dev
	// Strict Mode that left EVERY read with an already-aborted signal → an instant
	// "couldn't read". Created in the effect, the remount re-creates it and the
	// `setState` re-renders with a live signal before any chip can mount.
	const [extractionAbort, setExtractionAbort] =
		useState<AbortController | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionApi is the dep on PURPOSE — recreate (+ abort the prior) build-scoped controller when the store identity changes, mirroring the grid controller, even though the body doesn't read it.
	useEffect(() => {
		const controller = new AbortController();
		setExtractionAbort(controller);
		return () => controller.abort();
	}, [sessionApi]);
	const extractionAbortSignal = extractionAbort?.signal;

	// Initialize from the controller's live state so remounts don't flash
	// from 'SYS:IDLE' to the real label. On first mount the controller is
	// in 'idle' mode, which matches the default anyway.
	const [activeMode, setActiveMode] = useState<SignalMode>(
		() => gridController.currentMode,
	);
	const [activeLabel, setActiveLabel] = useState(
		() => gridController.currentModeLabel,
	);

	// Wire mode-applied callback to React state — ref indirection so the
	// callback closure doesn't go stale across renders.
	const activeStateRef = useRef({ setActiveMode, setActiveLabel });
	activeStateRef.current = { setActiveMode, setActiveLabel };

	useEffect(() => {
		gridController.setOnModeApplied((mode, label) => {
			activeStateRef.current.setActiveMode(mode);
			activeStateRef.current.setActiveLabel(label);
		});
		return () => gridController.setOnModeApplied(null);
	}, [gridController]);

	/* True while the current `submitted` window was opened by a LOCAL send —
	 * a typed message or an answered question round (the two `triggerSendWave`
	 * callers). A refresh-resume (`resumeStream`) and the instance-death
	 * re-drive (`regenerate`) ALSO pass through `submitted` while they
	 * reconnect, but nothing is transmitting there — mapping that window to
	 * the send wave replayed the one-shot "Transmitting" state on every
	 * refresh of a live run. Cleared when the status moves off `submitted`
	 * (derive-during-render, the same pattern as the elapsed timer below). */
	const localSendRef = useRef(false);
	const prevStatusRef = useRef(status);
	if (prevStatusRef.current !== status) {
		prevStatusRef.current = status;
		if (status !== "submitted") localSendRef.current = false;
	}

	// Desired mode + label from builder state — sent to controller, which queues if busy.
	// Gate reasoning/editing on `status === 'streaming'` so the send wave keeps looping
	// during the 'submitted' wait period (server hasn't started responding yet).
	const desiredMode = ((): SignalMode => {
		// Generation errors — phase stays Generating, error is metadata
		if (agentError) {
			return agentError.severity === "recovering"
				? "error-recovering"
				: "error-fatal";
		}
		// Initial-build milestones own the scaffold/build visuals. The phase gate
		// keeps the same tags in a post-build edit on the editing visual below.
		const generationMode = deriveGenerationSignalMode(isGenerating, agentStage);
		if (generationMode) return generationMode;
		// Completed = celebration after generation finishes. Takes priority over
		// the streaming branches below because data-done fires mid-stream (the
		// LLM's wrap-up text keeps the stream open). Without this, the grid
		// shows "Thinking" for 5–15s after generation is already complete.
		if (phase === BuilderPhase.Completed) return "done";
		// Reading document attachments — a pre-SA step. `attachmentPrep` is the
		// SEND-time resolve (server waits on the extract); `composerReading` is the
		// PRE-send eager extraction of a staged doc. Both reuse the reasoning
		// animation (label set below) and sit after error/generation/completed so a
		// real run always wins, but before `streamOpen` (which would otherwise show
		// the generic "Transmitting"/"Thinking" during the read).
		if (attachmentPrep || composerReading) return "reasoning";
		if (streamOpen) {
			// Keep the send wave looping until the server actually starts streaming.
			// During 'submitted', no tokens are flowing so reasoning/editing would
			// look dead — the whole point of the signal grid is to show activity.
			// Only a LOCAL send shows the send wave: a resume/re-drive reconnect
			// also sits in 'submitted', and replaying "Transmitting" there would
			// narrate a send that never happened (see `localSendRef`).
			if (status === "submitted") {
				return localSendRef.current
					? "sending"
					: postBuildEdit
						? "editing"
						: "reasoning";
			}
			return postBuildEdit ? "editing" : "reasoning";
		}
		// Welcome screen intro — the first 3.5s on a fresh build shows the
		// reasoning animation while the heading/subtitle stagger in. After the
		// timer elapses (introFinished), falls through to idle like any other
		// resting state. The centered+empty+!isLoading conditions match the
		// exact window WelcomeIntro is mounted for.
		if (centered && messages.length === 0 && !isLoading && !introFinished) {
			return "reasoning";
		}
		if (phase === BuilderPhase.Ready) return "idle";
		return "idle";
	})();

	const desiredLabel =
		attachmentPrep || composerReading
			? "Reading your documents"
			: isGenerating && statusMessage
				? statusMessage
				: defaultLabel(desiredMode);

	useEffect(() => {
		gridController.setMode(desiredMode, desiredLabel);
	}, [desiredMode, desiredLabel, gridController]);

	// Auto-decay Completed → Ready after the done celebration finishes.
	//
	// The 3.5s delay covers the 2s celebration burst + 1.5s of the resting
	// emerald pulse so the transition feels unhurried.
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
	// the buffer to empty first means the celebration lingers until the
	// stream is genuinely done, then a clean 3.5s delay to Ready.
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

	// Elapsed timer — resets when the controller's active label or mode changes.
	// Label changes (e.g. "Setting up app" → "Building app content") reset the timer during
	// render via React's "derive state from props" pattern, so the interval continues
	// with the new base time. Mode changes are handled by the effect (start/stop).
	const [elapsed, setElapsed] = useState(0);
	const modeStartRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

	const prevLabelRef = useRef(activeLabel);
	if (prevLabelRef.current !== activeLabel) {
		prevLabelRef.current = activeLabel;
		setElapsed(0);
		modeStartRef.current = Date.now();
	}

	useEffect(() => {
		clearInterval(timerRef.current);
		setElapsed(0);
		if (
			activeMode === "idle" ||
			activeMode === "sending" ||
			activeMode === "done" ||
			activeMode === "error-recovering" ||
			activeMode === "error-fatal"
		)
			return;
		modeStartRef.current = Date.now();
		timerRef.current = setInterval(() => {
			const secs = Math.floor((Date.now() - modeStartRef.current) / 1000);
			setElapsed(secs);
		}, 1000);
		return () => clearInterval(timerRef.current);
	}, [activeMode]);

	const gridSuffix =
		elapsed >= 30
			? `(${elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`})`
			: undefined;

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
			if (threadId === activeThreadId) {
				setThreadListOpen(false);
				return;
			}
			if (openingThreadId) return;
			setOpeningThreadId(threadId);
			const opened = await onSelectThread?.(threadId);
			if (!opened) setOpeningThreadId(null);
		},
		[activeThreadId, onSelectThread, openingThreadId],
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
		setThreadListOpen(false);
		setOpeningThreadId(null);
		onNewChat?.();
	}, [onNewChat]);

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

	const triggerSendWave = useCallback(() => {
		/* Mark the coming `submitted` window as a real send so desiredMode
		 * sustains the wave — the flag is what separates it from a
		 * resume/re-drive reconnect, which must never show "Transmitting". */
		localSendRef.current = true;
		gridController.setMode("sending");
	}, [gridController]);

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
				triggerSendWave();
				onSend(message);
			}
		},
		[onSend, triggerSendWave],
	);

	// Wrap addToolOutput to trigger send animation when a question block completes
	const handleToolOutput = useCallback(
		(params: { tool: string; toolCallId: string; output: unknown }) => {
			if (params.tool === "askQuestions") triggerSendWave();
			addToolOutput(params);
		},
		[addToolOutput, triggerSendWave],
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
					? "absolute inset-0 z-raised flex flex-col items-center justify-center gap-6 pointer-events-none"
					: "shrink-0 h-full"
			}
		>
			{centered && heroLogo}
			<motion.div
				layout={morphing ? "position" : false}
				data-inspector-rail={centered ? undefined : true}
				style={centered ? undefined : { width: railWidth }}
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
						<div className="flex items-center gap-2 pl-4 pr-2 h-12 border-b border-nova-border shrink-0">
							<span className="flex-1 min-w-0 text-sm font-medium text-nova-text">
								{listVisible ? "Conversations" : "Chat"}
							</span>
							<SimpleTooltip content="Collapse chat" side="left">
								<Button
									type="button"
									onClick={() => setSidebarOpen("chat", false)}
									aria-label="Collapse chat sidebar"
									variant="ghost"
									size="icon-lg"
									className="text-nova-text-muted hover:text-nova-text"
								>
									<Icon icon={tablerLayoutSidebarRightCollapse} />
								</Button>
							</SimpleTooltip>
						</div>
						{showThreadAffordances && (
							<div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-nova-border shrink-0">
								{!readOnly && (
									<Button
										type="button"
										onClick={handleNewChat}
										disabled={openingThreadId !== null}
										variant="ghost"
										size="lg"
										className="justify-start text-nova-text-secondary not-disabled:hover:text-nova-text"
									>
										<Icon icon={tablerMessagePlus} />
										New chat
									</Button>
								)}
								<Button
									type="button"
									onClick={() => setThreadListOpen((open) => !open)}
									disabled={openingThreadId !== null}
									aria-pressed={listVisible}
									variant="ghost"
									size="lg"
									className="justify-start text-nova-text-secondary not-disabled:hover:text-nova-text aria-pressed:bg-nova-violet/10 aria-pressed:text-nova-violet-bright"
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

				{/* Inspector dock — the slot the active InspectorSurface portals
				 *  into, plus the condensed chat strip. The Conversation block
				 *  below unmounts while docked; messages are props, so the
				 *  thread re-renders intact (re-pinned to bottom) on expand. */}
				{docked && (
					<>
						<div
							ref={setPortalEl}
							className="flex-1 min-h-0 flex flex-col overflow-hidden"
						/>
						{/* The condensed conversation's grab handle — ONE full-width
						 *  row (not a label plus a small link) so the affordance is
						 *  unmissable and the target spans the rail at full height.
						 *  Clicking it closes the properties panel and gives the
						 *  rail back to the conversation. */}
						<SimpleTooltip
							content="Back to the conversation — closes properties"
							side="left"
						>
							<button
								type="button"
								onClick={closeInspector}
								aria-label="Expand chat"
								className="group w-full flex items-center gap-2 px-4 min-h-11 border-t border-nova-border shrink-0 text-left hover:bg-white/[0.03] transition-colors cursor-pointer"
							>
								<span className="text-[9px] font-mono tracking-[0.18em] text-nova-text-muted">
									CHAT
								</span>
								{messages.length > 0 && (
									<span className="px-1.5 py-px rounded-full bg-nova-violet/15 border border-nova-violet/25 text-[10px] leading-none text-nova-violet-bright">
										{messages.length}
									</span>
								)}
								<Icon
									icon={tablerChevronUp}
									width="14"
									height="14"
									className="ml-auto text-nova-text-muted group-hover:text-nova-text transition-colors"
								/>
							</button>
						</SimpleTooltip>
					</>
				)}

				{/* Conversations list — swapped in over the conversation region
				 *  while open. The signal panel + composer below stay; sending
				 *  returns to the conversation (handleSend closes the list). */}
				{!docked && listVisible && (
					<ThreadList
						threads={threads ?? []}
						activeThreadId={activeThreadId ?? ""}
						activeThreadStreaming={isLoading}
						openingThreadId={openingThreadId}
						onSelect={handleSelectThread}
					/>
				)}

				{/* Messages — the open conversation's transcript (hydrated
				 *  history + live turns through one render path).
				 *  Conversation (a use-stick-to-bottom root) owns the scroll: it
				 *  keeps the view pinned to the latest message and across the
				 *  center↔sidebar morph, replacing the former hand-rolled
				 *  MutationObserver/ResizeObserver pinning. contextRef hands us the
				 *  scroll context so the question-card autoscroll can reach the
				 *  content element. */}
				{/* The card is `overflow-hidden`; the signal panel + composer below are
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
				{!docked && !listVisible && (
					<Conversation
						key={activeThreadId}
						className={centered ? "flex-auto min-h-0" : "flex-1"}
						contextRef={captureStickContext}
					>
						{/* ConversationContent's base `gap-8` is roomier than Nova's chat
						 *  density; override to `gap-4` (matches the former `space-y-4`).
						 *  Single-source the spacing via gap rather than stacking margins. */}
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
												: "Describe the CommCare app you want to build."
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
									isStreaming={isLoading && msgIndex === messages.length - 1}
								/>
							))}
						</ConversationContent>
						<ConversationScrollButton />
					</Conversation>
				)}

				{/* Nova's thinking panel — permanent status display */}
				<div className="shrink-0">
					<SignalPanel
						active={activeMode !== "idle"}
						label={activeLabel}
						suffix={gridSuffix}
						error={activeMode === "error-fatal"}
						recovering={activeMode === "error-recovering"}
						done={activeMode === "done"}
					>
						<SignalGrid controller={gridController} messages={messages} />
					</SignalPanel>
				</div>

				{/* A view-only member sees why they can't send, where the composer
				 *  would be — only when a notice is supplied for the
				 *  read-only-access case. */}
				{readOnly && readOnlyNotice && (
					<div className="shrink-0 px-4 py-3 text-sm text-nova-text-muted border-t border-nova-border">
						{readOnlyNotice}
					</div>
				)}

				{/* Input — hidden in readOnly mode */}
				{!readOnly && (
					<div className="shrink-0">
						<ChatInput
							onSend={handleSend}
							disabled={isLoading || isGenerating || composerBusy}
							// The spinner means "your turn is on its way to the SA", so it
							// tracks only the chat sources. `composerBusy` locks the composer
							// for a reason that has nothing to do with a message.
							submitting={isLoading || isGenerating}
							// A waiting question card routes the next composer send to it as
							// a text-only answer, so the composer disables attaching and
							// preserves any staged files instead of dropping them.
							answerPending={activeQuestionCount > 0}
							centered={centered}
							// "Tell me about the app" fits only the opening prompt of a
							// brand-new build; the moment a message exists (sent or
							// streaming) it becomes an edit conversation, so flip to the
							// "ask for changes" copy then — not when the layout docks.
							openingPrompt={centered && messages.length === 0}
							// Lift "a staged doc is still being read" into the signal panel.
							onReadingChange={setComposerReading}
							// Build-scoped abort so a staged doc's read keeps feeding the grid
							// after the chip unmounts on send, until extraction finishes.
							extractionAbortSignal={extractionAbortSignal}
						/>
					</div>
				)}
			</motion.div>

			{/* Under the card, inside the same centered column — sharing it is the
			 *  point: this holds the chat above true center, and the chat settles
			 *  back to center as this collapses away. */}
			{centered && startBlankApp}
		</motion.div>
	);
}

/** Staggered welcome text with a coordinated burst on the signal grid.
 *
 * Pure visual component — the grid's mode is driven by the parent's
 * `desiredMode` derivation, not by this component. WelcomeIntro's only
 * grid-related job is injecting energy into the signal store: tapering
 * 150ms pulses for the first 3.5s plus two larger bursts coinciding
 * with the heading (1.5s) and subtitle (2s) reveals. The parent's
 * `desiredMode` returns "reasoning" while WelcomeIntro is mounted and
 * the 3.5s timer hasn't elapsed, so the energy bursts land on the
 * right visual. If the user sends a message early (component unmounts)
 * or the timer elapses, the parent naturally transitions the grid. */
function WelcomeIntro() {
	const [stage, setStage] = useState(0); // 0: nothing, 1: heading, 2: subtitle

	useEffect(() => {
		const t0 = performance.now();
		const pulse = setInterval(() => {
			const elapsed = performance.now() - t0;
			const scale =
				elapsed < 2000 ? 1 : Math.max(0, 1 - (elapsed - 2000) / 1500);
			signalGrid.injectEnergy((10 + Math.random() * 20) * scale);
		}, 150);

		const t1 = setTimeout(() => {
			setStage(1);
			signalGrid.injectEnergy(120);
		}, 1500);

		const t2 = setTimeout(() => {
			setStage(2);
			signalGrid.injectEnergy(120);
		}, 2000);

		const t3 = setTimeout(() => {
			clearInterval(pulse);
		}, 3500);

		return () => {
			clearInterval(pulse);
			clearTimeout(t1);
			clearTimeout(t2);
			clearTimeout(t3);
		};
	}, []);

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
						animate={stage >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
						transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
						className="text-lg font-display font-medium text-nova-text"
					>
						What do you want to build?
					</motion.h1>
					<motion.p
						initial={{ opacity: 0, y: 8 }}
						animate={stage >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
						transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
						className="text-nova-text-secondary text-sm leading-relaxed"
					>
						Describe your CommCare app — workflows, data collection, and who
						will use it.
					</motion.p>
				</div>
			</MessageContent>
		</Message>
	);
}
