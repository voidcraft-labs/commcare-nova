"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import type { UIMessage } from "ai";
import { motion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { ChatInput } from "@/components/chat/ChatInput";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { SignalGrid } from "@/components/chat/SignalGrid";
import { SignalPanel } from "@/components/chat/SignalPanel";
import {
	BlueprintDocContext,
	type BlueprintDocStore,
} from "@/lib/doc/provider";
import { BuilderPhase } from "@/lib/services/builder";
import {
	derivePhase,
	useAgentError,
	useAgentStage,
	useBuilderPhase,
	usePostBuildEdit,
	useSetSidebarOpen,
	useStatusMessage,
} from "@/lib/session/hooks";
import { deriveAgentStage } from "@/lib/session/lifecycle";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { GenerationStage } from "@/lib/session/types";
import { signalGrid } from "@/lib/signalGrid/store";
import {
	defaultLabel,
	SignalGridController,
	type SignalMode,
} from "@/lib/signalGridController";
import { computeScaffoldProgress } from "./scaffoldProgress";

/** Sidebar panel width in pixels. Exported so siblings (e.g. cursor mode bar
 *  positioning in BuilderLayout) can derive offsets without magic numbers. */
export const CHAT_SIDEBAR_WIDTH = 320;

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
				},
				hasData,
			);
			return computeScaffoldProgress(
				phase,
				deriveAgentStage(s.events),
				(doc?.caseTypes?.length ?? 0) > 0,
				hasData,
			);
		},
	});
}

interface ChatSidebarProps {
	centered: boolean;
	heroLogo?: ReactNode;
	messages: UIMessage[];
	status: "submitted" | "streaming" | "ready" | "error";
	onSend: (message: string) => void;
	addToolOutput: (params: {
		tool: string;
		toolCallId: string;
		output: unknown;
	}) => void;
	readOnly?: boolean;
	/** Whether the app was loaded from Firestore (not a new build).
	 *  Drives the empty-state prompt text. */
	isExistingApp?: boolean;
	/** Server-rendered thread history — pre-rendered by the RSC page
	 *  inside a Suspense boundary, passed through the client boundary. */
	children?: ReactNode;
}

export function ChatSidebar({
	centered,
	heroLogo,
	messages,
	status,
	onSend,
	addToolOutput,
	readOnly,
	isExistingApp,
	children,
}: ChatSidebarProps) {
	const sessionApi = useBuilderSessionApi();
	const docStore = useContext(BlueprintDocContext);
	const phase = useBuilderPhase();
	const setSidebarOpen = useSetSidebarOpen();
	const agentError = useAgentError();
	const agentStage = useAgentStage();
	const postBuildEdit = usePostBuildEdit();
	const statusMessage = useStatusMessage();
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
		// Early generation stages get the scaffolding visual (tetris board)
		if (
			agentStage === GenerationStage.DataModel ||
			agentStage === GenerationStage.Structure
		) {
			return "scaffolding";
		}
		// Later generation stages get the building visual (pink sweep + bursts)
		if (isGenerating) return "building";
		// Completed = celebration after generation finishes. Takes priority over
		// the streaming branches below because data-done fires mid-stream (the
		// LLM's wrap-up text keeps the stream open). Without this, the grid
		// shows "Thinking" for 5–15s after generation is already complete.
		if (phase === BuilderPhase.Completed) return "done";
		if (streamOpen) {
			// Keep the send wave looping until the server actually starts streaming.
			// During 'submitted', no tokens are flowing so reasoning/editing would
			// look dead — the whole point of the signal grid is to show activity.
			if (status === "submitted") return "sending";
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
		isGenerating && statusMessage ? statusMessage : defaultLabel(desiredMode);

	useEffect(() => {
		gridController.setMode(desiredMode, desiredLabel);
	}, [desiredMode, desiredLabel, gridController]);

	// Auto-decay Completed → Ready after the done celebration finishes.
	// The 3.5s delay covers the 2s celebration burst + 1.5s of the resting emerald
	// pulse so the transition feels unhurried. If the builder leaves Completed
	// before the timer fires (e.g. user starts a new edit), the cleanup cancels it.
	useEffect(() => {
		if (phase !== BuilderPhase.Completed) return;
		const id = setTimeout(
			() => sessionApi.getState().acknowledgeCompletion(),
			3500,
		);
		return () => clearTimeout(id);
	}, [phase, sessionApi]);

	// Elapsed timer — resets when the controller's active label or mode changes.
	// Label changes (e.g. "Building forms" → "Validating") reset the timer during
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

	// Scroll state — persists across sidebar open/close because ChatSidebar
	// stays mounted (width animated to 0). No module-level variables needed.
	const chatScrollPinnedRef = useRef(true);
	const chatScrollTopRef = useRef(0);

	const pendingAnswerRef = useRef<((text: string) => void) | null>(null);
	const scrollElRef = useRef<HTMLDivElement | null>(null);
	const isNearBottomRef = useRef(chatScrollPinnedRef.current);
	const isUserHoldingRef = useRef(false);

	const triggerSendWave = useCallback(() => {
		gridController.setMode("sending");
	}, [gridController]);

	// Route typed messages as question answers when a AskQuestionsCard is waiting
	const handleSend = useCallback(
		(text: string) => {
			if (pendingAnswerRef.current) {
				pendingAnswerRef.current(text);
			} else {
				triggerSendWave();
				onSend(text);
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

	// Smart scroll management: auto-scroll when near bottom, respect user scroll hold,
	// persist state across instances (tab switch, center → sidebar transition).
	const scrollRef = useCallback((el: HTMLDivElement | null) => {
		scrollElRef.current = el;
		if (!el) return;

		const THRESHOLD = 50;
		let animFrameId: number | undefined;

		const wasAtBottom = chatScrollPinnedRef.current;
		isNearBottomRef.current = wasAtBottom;

		if (wasAtBottom) {
			el.scrollTop = el.scrollHeight;
			// Keep pinning during layout animation (center → sidebar, ~500ms)
			const startTime = performance.now();
			const pin = () => {
				if (performance.now() - startTime > 600) return;
				if (isNearBottomRef.current && !isUserHoldingRef.current) {
					el.scrollTop = el.scrollHeight;
				}
				animFrameId = requestAnimationFrame(pin);
			};
			animFrameId = requestAnimationFrame(pin);
		} else {
			el.scrollTop = chatScrollTopRef.current;
		}

		const autoScroll = () => {
			if (isNearBottomRef.current && !isUserHoldingRef.current) {
				el.scrollTop = el.scrollHeight;
			}
		};

		const checkNearBottom = () => {
			isNearBottomRef.current =
				el.scrollTop + el.clientHeight >= el.scrollHeight - THRESHOLD;
		};

		const onScroll = () => {
			if (!isUserHoldingRef.current) checkNearBottom();
		};
		const onMouseDown = () => {
			isUserHoldingRef.current = true;
		};
		const onMouseUp = () => {
			isUserHoldingRef.current = false;
			checkNearBottom();
		};

		const mutationObserver = new MutationObserver(autoScroll);
		mutationObserver.observe(el, { childList: true, subtree: true });

		const resizeObserver = new ResizeObserver(autoScroll);
		resizeObserver.observe(el);

		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("mousedown", onMouseDown);
		document.addEventListener("mouseup", onMouseUp);

		return () => {
			chatScrollPinnedRef.current = isNearBottomRef.current;
			chatScrollTopRef.current = el.scrollTop;
			if (animFrameId !== undefined) cancelAnimationFrame(animFrameId);
			mutationObserver.disconnect();
			resizeObserver.disconnect();
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("mouseup", onMouseUp);
			scrollElRef.current = null;
		};
	}, []);

	// Anchor scroll position during center↔sidebar morph.
	// The existing ResizeObserver + onScroll race: onScroll fires first when the
	// browser clamps scrollTop during resize, clearing isNearBottomRef before the
	// ResizeObserver can act. This rAF loop captures intent at morph start and
	// overrides on every frame, keeping position stable throughout the transition.
	useEffect(() => {
		const el = scrollElRef.current;
		if (!morphing || !el) return;

		const pinToBottom = isNearBottomRef.current;
		const savedTop = el.scrollTop;
		let id: number;

		const tick = () => {
			if (!isUserHoldingRef.current) {
				el.scrollTop = pinToBottom ? el.scrollHeight : savedTop;
			}
			id = requestAnimationFrame(tick);
		};
		id = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(id);
	}, [morphing]);

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

	const prevActiveQCountRef = useRef(0);
	useEffect(() => {
		if (
			activeQuestionCount > prevActiveQCountRef.current &&
			scrollElRef.current &&
			!isUserHoldingRef.current
		) {
			requestAnimationFrame(() => {
				const el = scrollElRef.current;
				if (!el) return;
				const cards = el.querySelectorAll('[data-question-card="waiting"]');
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
				className={`pointer-events-auto flex flex-col overflow-hidden transition-[width,max-width,max-height,height,border-radius,border-color] duration-[450ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
					centered
						? "w-full max-w-2xl max-h-[min(700px,80vh)] rounded-2xl border border-nova-border bg-nova-deep"
						: `w-[${CHAT_SIDEBAR_WIDTH}px] h-full border-l border-nova-border-bright bg-nova-deep`
				}`}
				transition={{ layout: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
			>
				{/* Sidebar header */}
				{!centered && (
					<div className="flex items-center justify-between px-4 h-11 border-b border-nova-border shrink-0">
						<span className="text-[13px] font-medium text-nova-text-secondary">
							Chat
						</span>
						<button
							type="button"
							onClick={() => setSidebarOpen("chat", false)}
							className="px-1 h-11 text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
						>
							<Icon icon={tablerChevronRight} width="14" height="14" />
						</button>
					</div>
				)}

				{/* Messages — historical threads above, active thread below */}
				<div
					ref={scrollRef}
					className={`${centered ? "" : "flex-1"} overflow-y-auto p-4 space-y-4`}
				>
					{/* Historical threads — server-rendered by ThreadHistory,
					 *  passed through the client boundary as children. */}
					{children}

					{/* Active thread empty state */}
					{messages.length === 0 && !isLoading && (
						<div className={centered ? "text-center" : "text-center py-8"}>
							{centered ? (
								<WelcomeIntro />
							) : (
								<p className="text-sm text-nova-text-muted">
									{isExistingApp
										? "What changes would you like to make?"
										: "Describe the CommCare app you want to build."}
								</p>
							)}
						</div>
					)}

					{/* Live messages from the active useChat session */}
					{messages.map((msg) => (
						<ChatMessage
							key={msg.id}
							message={msg}
							addToolOutput={handleToolOutput}
							pendingAnswerRef={pendingAnswerRef}
						/>
					))}
				</div>

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

				{/* Input — hidden in readOnly mode */}
				{!readOnly && (
					<div className="shrink-0">
						<ChatInput
							onSend={handleSend}
							disabled={isLoading || isGenerating}
							centered={centered}
						/>
					</div>
				)}
			</motion.div>
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
		<>
			<motion.h1
				initial={{ opacity: 0, y: 6 }}
				animate={stage >= 1 ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
				transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
				className="text-xl font-display font-medium text-nova-text mb-1.5"
			>
				What do you want to build?
			</motion.h1>
			<motion.p
				initial={{ opacity: 0, y: 8 }}
				animate={stage >= 2 ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
				transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
				className="text-nova-text-secondary text-sm leading-relaxed"
			>
				Describe your CommCare app — workflows, data collection, and who will
				use it.
			</motion.p>
		</>
	);
}
