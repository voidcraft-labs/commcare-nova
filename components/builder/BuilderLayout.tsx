"use client";
import { Chat, useChat } from "@ai-sdk/react";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import tablerBrowser from "@iconify-icons/tabler/browser";
import tablerDeviceMobile from "@iconify-icons/tabler/device-mobile";
import tablerListTree from "@iconify-icons/tabler/list-tree";
import tablerMessageChatbot from "@iconify-icons/tabler/message-chatbot";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { useStore } from "zustand";
import { CursorModeSelector } from "@/components/builder/CursorModeSelector";
import { AppConnectSettings } from "@/components/builder/detail/AppConnectSettings";
import { GenerationProgress } from "@/components/builder/GenerationProgress";
import { ReplayController } from "@/components/builder/ReplayController";
import { SaveIndicator } from "@/components/builder/SaveIndicator";
import { StructureSidebar } from "@/components/builder/StructureSidebar";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { useBuilderShortcuts } from "@/components/builder/useBuilderShortcuts";
import { CHAT_SIDEBAR_WIDTH, ChatSidebar } from "@/components/chat/ChatSidebar";
import { PreviewShell } from "@/components/preview/PreviewShell";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ExportDropdown } from "@/components/ui/ExportDropdown";
import { Logo } from "@/components/ui/Logo";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAuth } from "@/hooks/useAuth";
import { useAutoSave } from "@/hooks/useAutoSave";
import {
	useBreadcrumbs,
	useBuilderEngine,
	useBuilderHasData,
	useBuilderIsReady,
	useBuilderPhase,
	useBuilderStore,
	useBuilderStoreShallow,
} from "@/hooks/useBuilder";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { parseApiErrorMessage } from "@/lib/apiError";
import { shortcutLabel } from "@/lib/platform";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { applyDataPart, BuilderPhase } from "@/lib/services/builder";
import type { BuilderEngine } from "@/lib/services/builderEngine";
import {
	selectCanGoBack,
	selectCanGoUp,
	selectInReplayMode,
} from "@/lib/services/builderSelectors";
import type { CursorMode } from "@/lib/services/builderStore";
import {
	assembleBlueprint,
	assembleForm,
	getEntityData,
} from "@/lib/services/normalizedState";
import { flattenQuestionRefs } from "@/lib/services/questionPath";
import { showToast } from "@/lib/services/toastStore";

/** Only auto-resend when the assistant's LAST step is askQuestions with all outputs available.
 *  If the SA continued past tool calls to ask a freeform text question, don't auto-resend —
 *  the user needs to reply manually first. */
function shouldAutoResend({ messages }: { messages: UIMessage[] }): boolean {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return false;

	// Only look at the last step — earlier answered questions don't matter
	type Part = UIMessage["parts"][number];
	const lastStepIdx = last.parts.reduce(
		(idx: number, p: Part, i: number) => (p.type === "step-start" ? i : idx),
		-1,
	);
	const lastStepParts = last.parts.slice(lastStepIdx + 1);

	const askParts = lastStepParts.filter(
		(p: Part) => p.type === "tool-askQuestions",
	);
	return (
		askParts.length > 0 &&
		askParts.every((p) => "state" in p && p.state === "output-available")
	);
}

/** Shared sidebar open/close animation config. */
const SIDEBAR_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

/** Width of the structure sidebar in pixels (w-80). */
const STRUCTURE_SIDEBAR_WIDTH = 320;

/** Height of the glassmorphic cursor mode pill (top-2.5 + py-1.5 + 34px control + py-1.5).
 *  Used as top inset on PreviewShell so content starts below the overlay. */
const TOOLBAR_INSET = 56;

/** Extra space above the scroll target so the question isn't flush with the
 *  cursor mode overlay. Two values: a compact margin for plain selection,
 *  and an expanded margin when a TipTap inline editor is active (the
 *  floating label toolbar ~44px + 6px gap renders above the question via
 *  portal — the expanded margin keeps the toolbar in its "free" positioning
 *  regime, not immediately clamped against the overlay). The scroll function
 *  checks for a `.tiptap` element inside the question to pick the right
 *  margin — present when a text-editable click activated the editor in the
 *  same React commit, absent for non-text clicks and tree sidebar nav. */
const SCROLL_MARGIN = 20;
const SCROLL_MARGIN_WITH_TOOLBAR = 60;

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  builder and runId — safe across re-renders within the same app session. */
function createChatInstance(
	builderRef: { current: BuilderEngine },
	runIdRef: { current: string | undefined },
): Chat<UIMessage> {
	return new Chat<UIMessage>({
		transport: new DefaultChatTransport({
			api: "/api/chat",
			body: () => {
				const s = builderRef.current.store.getState();
				return {
					blueprint:
						s.moduleOrder.length > 0
							? assembleBlueprint(getEntityData(s))
							: undefined,
					runId: runIdRef.current,
					appId: s.appId,
				};
			},
		}),
		sendAutomaticallyWhen: shouldAutoResend,
		onData: (part) => {
			const { type, data } = part as {
				type: string;
				data: Record<string, unknown>;
			};
			if (type === "data-run-id") {
				runIdRef.current = data.runId as string;
				return;
			}

			/* After first save, update the URL from /build/new → /build/{id} without
			 * triggering a navigation or remount. applyDataPart stores the ID on the builder. */
			if (type === "data-app-saved") {
				const appId = data.appId as string;
				applyDataPart(builderRef.current, type, data);
				window.history.replaceState({}, "", `/build/${appId}`);
				return;
			}

			applyDataPart(builderRef.current, type, data);
			if (type === "data-error") {
				showToast(
					data.fatal ? "error" : "warning",
					"Generation error",
					data.message as string,
				);
			}
		},
	});
}

export function BuilderLayout() {
	const router = useRouter();
	/* Server layout gates auth — useAuth() here is only for the isAuthenticated
	 * flag (useAutoSave, redirect guard). Never block on isPending since the
	 * server already verified the cookie. */
	const { isAuthenticated, isPending: isAuthPending } = useAuth();
	const builder = useBuilderEngine();
	const phase = useBuilderPhase();
	const isReady = useBuilderIsReady();
	const hasData = useBuilderHasData();
	const appName = useBuilderStore((s) => s.appName);
	/* Subscribe to zundo's temporal store for undo/redo button state.
	 * pastStates/futureStates arrays change reference on every push — the
	 * boolean selectors prevent spurious re-renders. */
	const canUndo = useStore(
		builder.store.temporal,
		(s) => s.pastStates.length > 0,
	);
	const canRedo = useStore(
		builder.store.temporal,
		(s) => s.futureStates.length > 0,
	);
	const { generationStage, generationError, statusMessage } =
		useBuilderStoreShallow((s) => ({
			generationStage: s.generationStage,
			generationError: s.generationError,
			statusMessage: s.statusMessage,
		}));

	// ── Stable ref for builder so Chat callbacks always read the latest ────
	const builderRef = useRef(builder);
	builderRef.current = builder;
	const runIdRef = useRef<string | undefined>(undefined);

	// ── Chat instance — recreated when builder changes (new app) ─────────
	// When the BuilderProvider creates a fresh builder (buildId change), we
	// detect the identity change and create a new Chat. This clears messages,
	// resets the stream, and starts fresh — no persistedChatMessages hack.
	const prevBuilderRef = useRef(builder);
	const [chat, setChat] = useState(() =>
		createChatInstance(builderRef, runIdRef),
	);

	// ── Replay ────────────────────────────────────────────────────────────
	const inReplayMode = useBuilderStore(selectInReplayMode);
	const replayDoneIndex = useBuilderStore((s) => s.replayDoneIndex);
	const replayStages = useBuilderStore((s) => s.replayStages);
	/** Local replay chat messages — updated by ReplayController as the user
	 *  steps through stages. Not store state (transient view state). */
	const [replayMessages, setReplayMessages] = useState<UIMessage[]>(
		() => replayStages?.[replayDoneIndex]?.messages ?? [],
	);

	/* Detect builder identity change (new app via BuilderProvider). Clear
	 * stale local state from the previous app: run ID and the Chat instance.
	 * Uses the React "adjusting state during rendering" pattern — React
	 * discards the current render and re-renders immediately with the
	 * updated state, so no stale frame is ever painted. */
	if (builder !== prevBuilderRef.current) {
		prevBuilderRef.current = builder;
		runIdRef.current = undefined;
		setChat(createChatInstance(builderRef, runIdRef));
	}

	const [chatOpen, setChatOpen] = useState(true);
	const [structureOpen, setStructureOpen] = useState(true);
	const cursorMode = useBuilderStore((s) => s.cursorMode);

	/** Stashed sidebar open/closed state from before entering pointer mode.
	 *  Restored when switching back to edit. Ref (not state) because these
	 *  values are only read at one moment — the edit-mode transition. */
	const sidebarStashRef = useRef<{
		chatOpen: boolean;
		structureOpen: boolean;
	} | null>(null);

	/** Pending scroll anchor for ResizeObserver-based correction during
	 *  sidebar width animation. Cleared after animation settles (~250ms). */
	const pendingScrollAnchorRef = useRef<{
		questionUuid: string;
		offsetTop: number;
	} | null>(null);

	const [scrollAnchor, setScrollAnchor] = useState<{
		questionUuid: string;
		offsetTop: number;
		allUuids: string[];
	} | null>(null);

	const handleExitReplay = useCallback(() => {
		const exitPath = builder.store.getState().replayExitPath ?? "/";
		builder.reset();
		router.push(exitPath);
	}, [builder, router]);

	// ── Navigation state — read directly from the store ────────────────
	const canGoBack = useBuilderStore(selectCanGoBack);
	const canGoUp = useBuilderStore(selectCanGoUp);
	/** Breadcrumbs derived from screen + entity names via hook. Uses structural
	 *  equality so unrelated mutations don't trigger re-renders. */
	const breadcrumbs = useBreadcrumbs();

	const handleCursorModeChange = useCallback(
		(mode: CursorMode) => {
			// Guard against no-op switches (e.g. pressing V while already in pointer).
			// Without this, entering pointer mode twice overwrites the sidebar stash
			// with { chatOpen: false, structureOpen: false }, destroying the real values.
			if (mode === builder.store.getState().cursorMode) return;

			// Capture scroll anchor before mode switch for flipbook-style alignment
			// (switching to/from pointer triggers different rendering which may shift scroll)
			const scrollContainer = document.querySelector(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (scrollContainer) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const questionEls = Array.from(
					scrollContainer.querySelectorAll("[data-question-uuid]"),
				);
				for (let i = 0; i < questionEls.length; i++) {
					const rect = questionEls[i].getBoundingClientRect();
					if (rect.bottom > containerRect.top) {
						setScrollAnchor({
							questionUuid:
								questionEls[i].getAttribute("data-question-uuid") ?? "",
							offsetTop: rect.top - containerRect.top,
							allUuids: questionEls.map(
								(el) => el.getAttribute("data-question-uuid") ?? "",
							),
						});
						break;
					}
				}
			}

			// Stash/restore sidebar state across mode transitions.
			// Pointer mode is immersive — both sidebars hide. Edit mode restores
			// whatever the user had open before entering pointer.
			if (mode === "pointer") {
				sidebarStashRef.current = { chatOpen, structureOpen };
				setChatOpen(false);
				setStructureOpen(false);
			} else if (mode === "edit" && sidebarStashRef.current) {
				setChatOpen(sidebarStashRef.current.chatOpen);
				setStructureOpen(sidebarStashRef.current.structureOpen);
				sidebarStashRef.current = null;
			}

			builder.store.getState().setCursorMode(mode);
		},
		[builder, chatOpen, structureOpen],
	);

	// Restore scroll position after mode switch for flipbook-style alignment.
	// Depends on scrollAnchor (set by handleCursorModeChange before setCursorMode).
	// React batches both state updates, so this fires once per mode switch with the
	// anchor data available. setScrollAnchor(null) triggers one extra synchronous
	// re-render before paint (layout effect), which no-ops via the early return.
	useLayoutEffect(() => {
		if (!scrollAnchor) return;
		setScrollAnchor(null);

		const scrollContainer = document.querySelector(
			"[data-preview-scroll-container]",
		) as HTMLElement | null;
		if (!scrollContainer) return;

		let targetEl = scrollContainer.querySelector(
			`[data-question-uuid="${scrollAnchor.questionUuid}"]`,
		) as HTMLElement | null;

		if (!targetEl) {
			// Anchor hidden in new mode — find nearest visible question in either
			// direction, preferring backward (above) at each distance. Bidirectional
			// search handles the edge case where the anchor is the first question
			// (a hidden field at the top), so backward-only would find nothing.
			const anchorIdx = scrollAnchor.allUuids.indexOf(
				scrollAnchor.questionUuid,
			);
			for (let dist = 1; dist < scrollAnchor.allUuids.length; dist++) {
				const backIdx = anchorIdx - dist;
				if (backIdx >= 0) {
					targetEl = scrollContainer.querySelector(
						`[data-question-uuid="${scrollAnchor.allUuids[backIdx]}"]`,
					) as HTMLElement | null;
					if (targetEl) break;
				}
				const fwdIdx = anchorIdx + dist;
				if (fwdIdx < scrollAnchor.allUuids.length) {
					targetEl = scrollContainer.querySelector(
						`[data-question-uuid="${scrollAnchor.allUuids[fwdIdx]}"]`,
					) as HTMLElement | null;
					if (targetEl) break;
				}
			}
		}

		if (targetEl) {
			const containerRect = scrollContainer.getBoundingClientRect();
			const currentOffset =
				targetEl.getBoundingClientRect().top - containerRect.top;
			scrollContainer.scrollTop += currentOffset - scrollAnchor.offsetTop;

			// Store for ResizeObserver-based correction during sidebar width
			// animation. On narrow viewports (<1440px), sidebar hide/show changes
			// the form container width, causing text reflow that shifts the anchor.
			// The observer re-corrects as the container settles.
			pendingScrollAnchorRef.current = {
				questionUuid:
					targetEl.getAttribute("data-question-uuid") ??
					scrollAnchor.questionUuid,
				offsetTop: scrollAnchor.offsetTop,
			};
			// Fire-and-forget timeout — NOT returned as cleanup. setScrollAnchor(null)
			// above triggers a synchronous re-render that would cancel a cleanup
			// function immediately, leaving the ref permanently stale.
			setTimeout(() => {
				pendingScrollAnchorRef.current = null;
			}, 250);
		}
	}, [scrollAnchor]);

	// Re-correct scroll position as the scroll container resizes during sidebar
	// width animation. The initial useLayoutEffect adjusts scroll before paint,
	// but sidebar motion.div animations run async over ~200ms. On narrow viewports
	// the form container width changes, reflowing text and invalidating the initial
	// correction. This observer fires on each resize frame and re-aligns the anchor.
	// Deps include isReady/hasData so the observer re-attaches when PreviewShell
	// mounts (scroll container doesn't exist during Idle/Generating phases).
	useEffect(() => {
		if (!isReady || !hasData) return;
		const scrollContainer = document.querySelector(
			"[data-preview-scroll-container]",
		) as HTMLElement | null;
		if (!scrollContainer) return;

		const observer = new ResizeObserver(() => {
			const anchor = pendingScrollAnchorRef.current;
			if (!anchor) return;

			const el = scrollContainer.querySelector(
				`[data-question-uuid="${anchor.questionUuid}"]`,
			) as HTMLElement | null;
			if (!el) return;

			const containerRect = scrollContainer.getBoundingClientRect();
			const currentOffset = el.getBoundingClientRect().top - containerRect.top;
			scrollContainer.scrollTop += currentOffset - anchor.offsetTop;
		});

		observer.observe(scrollContainer);
		return () => observer.disconnect();
	}, [isReady, hasData]);

	const isCentered = phase === BuilderPhase.Idle;

	// ── Navigate to first form when generation completes ──
	const prevPhaseRef = useRef(phase);
	useEffect(() => {
		const wasGenerating = prevPhaseRef.current === BuilderPhase.Generating;
		if (wasGenerating && phase === BuilderPhase.Completed) {
			const s = builder.store.getState();
			if (
				s.moduleOrder.length > 0 &&
				(s.formOrder[s.moduleOrder[0]]?.length ?? 0) > 0
			) {
				s.navigateToForm(0, 0);
			}
		}
		prevPhaseRef.current = phase;
	}, [phase, builder]);

	// ── Chat — uses the explicit Chat instance (recreated on app switch) ─────
	const {
		messages,
		sendMessage,
		addToolOutput,
		status,
		error: chatError,
	} = useChat({ chat });

	// Sync chat transport status → builder agent state (drives builder.isThinking)
	useEffect(() => {
		builder.setAgentActive(status === "submitted" || status === "streaming");
	}, [status, builder]);

	// Surface stream-level errors from useChat (network, API key, server crash, spend cap).
	// Only set generation error during Generating phase — Idle errors get a toast only.
	// Phase and generationError are intentionally excluded from deps — this effect
	// should only fire when chatError changes, not when generation state transitions.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reads phase/generationError at fire time, not as triggers
	useEffect(() => {
		if (!chatError) return;
		const message = parseApiErrorMessage(chatError.message);
		if (phase === BuilderPhase.Generating && !generationError) {
			builder.store.getState().setGenerationError(message, "failed");
		}
		showToast("error", "Generation failed", message);
	}, [chatError, builder]);

	// Auto-save blueprint edits to Firestore (authenticated users only)
	const saveStatus = useAutoSave(builder, isAuthenticated);

	const _isGenerating = phase === BuilderPhase.Generating;

	const handleSend = useCallback(
		(text: string) => {
			if (!text.trim() || !isAuthenticated) return;
			sendMessage({ text });
		},
		[isAuthenticated, sendMessage],
	);

	const handleExportCcz = useCallback(async () => {
		const s = builder.store.getState();
		if (s.moduleOrder.length === 0) return;
		const bp = assembleBlueprint(getEntityData(s));
		try {
			const res = await fetch("/api/compile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: bp }),
			});
			const data = await res.json();
			if (data.downloadUrl) {
				const cczRes = await fetch(data.downloadUrl);
				const blob = await cczRes.blob();
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `${data.appName || "app"}.ccz`;
				a.click();
				URL.revokeObjectURL(url);
			}
		} catch {
			showToast("error", "Export failed", "Could not generate the .ccz file.");
		}
	}, [builder]);

	const handleExportJson = useCallback(async () => {
		const s = builder.store.getState();
		if (s.moduleOrder.length === 0) return;
		const bp = assembleBlueprint(getEntityData(s));
		try {
			const res = await fetch("/api/compile/json", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: bp }),
			});
			if (!res.ok) {
				showToast(
					"error",
					"Export failed",
					"Could not generate the JSON file.",
				);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${s.appName || "app"}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			showToast("error", "Export failed", "Could not generate the JSON file.");
		}
	}, [builder]);

	const exportOptions = useMemo(
		() => [
			{
				label: "Web",
				description: "JSON",
				icon: tablerBrowser,
				onClick: handleExportJson,
			},
			{
				label: "Mobile",
				description: "CCZ",
				icon: tablerDeviceMobile,
				onClick: handleExportCcz,
			},
		],
		[handleExportJson, handleExportCcz],
	);

	// ── Scroll-to-question ──────────────────────────────────────────────

	/** Flash a subtle violet highlight on an element to signal an undo/redo
	 *  state change. Web Animations API — fire-and-forget, no cleanup needed.
	 *  Toggles get a scale press instead of a backgroundColor overlay — a
	 *  brief squish mimics a click, and the toggle's own track color +
	 *  thumb slide transition provides the state-change cue. */
	const flashUndoHighlight = useCallback((el: HTMLElement): void => {
		if (el.getAttribute("role") === "switch") {
			el.animate(
				[
					{ transform: "scale(1)" },
					{ transform: "scale(0.8)" },
					{ transform: "scale(1)" },
				],
				{ duration: 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
			);
			return;
		}
		el.animate(
			[
				{ backgroundColor: "rgba(139, 92, 246, 0.12)" },
				{ backgroundColor: "transparent" },
			],
			{ duration: 600, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
		);
	}, []);

	/**
	 * Scroll the design canvas so the target element is pinned to the top
	 * of the visible region (below the toolbar overlay).
	 *
	 * Uses a rAF-driven animation instead of native `scrollTo({ behavior:
	 * "smooth" })` because panel mount/unmount causes layout shifts that
	 * make the browser abandon native smooth scrolling mid-flight. The rAF
	 * loop recalculates the element's position every frame, so it tracks
	 * the target correctly even when the old InlineSettingsPanel unmounts
	 * and shifts content upward.
	 *
	 * The glassmorphic cursor mode toolbar is absolutely positioned over the
	 * top of the scroll container. The visible region starts at
	 * `containerRect.top + paddingTop` (set by PreviewShell's `topInset`).
	 */
	const scrollAnimationRef = useRef<number | null>(null);
	const scrollToQuestion = useCallback(
		(
			questionUuid: string,
			overrideTarget?: HTMLElement,
			behavior: ScrollBehavior = "smooth",
			hasToolbar = false,
		) => {
			/* Cancel any in-flight scroll animation. */
			if (scrollAnimationRef.current !== null) {
				cancelAnimationFrame(scrollAnimationRef.current);
				scrollAnimationRef.current = null;
			}

			const questionEl = document.querySelector(
				`[data-question-uuid="${questionUuid}"]`,
			) as HTMLElement | null;
			const scrollContainer = questionEl?.closest(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (!questionEl || !scrollContainer) return;

			/* The element to actually scroll into view — either an override
			 * (e.g. a specific field within the InlineSettingsPanel) or the
			 * question wrapper itself. */
			const el = overrideTarget ?? questionEl;

			/** Compute the element's absolute offset within the scroll
			 *  container — independent of the current scrollTop. This is
			 *  the scrollTop value that would pin the element to the top
			 *  of the visible region. Recalculated each frame so panel
			 *  mount/unmount layout shifts are tracked correctly. */
			const paddingTop = scrollContainer.style.paddingTop
				? Number.parseInt(scrollContainer.style.paddingTop, 10)
				: 0;
			/* Use the expanded margin when the click activated a text-editable
			 * zone — the floating TipTap label toolbar will render above the
			 * question and needs clearance below the cursor mode overlay. */
			const margin = hasToolbar ? SCROLL_MARGIN_WITH_TOOLBAR : SCROLL_MARGIN;
			const measureTarget = (): number => {
				const containerRect = scrollContainer.getBoundingClientRect();
				const elRect = el.getBoundingClientRect();
				/* elRect.top - containerRect.top gives the element's visual
				 * offset from the container's top edge. Adding scrollTop
				 * converts that to an absolute offset within the scrollable
				 * content. Subtracting paddingTop and margin pins it below
				 * the toolbar overlay. */
				const absoluteOffset =
					elRect.top - containerRect.top + scrollContainer.scrollTop;
				return Math.max(0, absoluteOffset - paddingTop - margin);
			};

			/* Instant scroll — no animation needed. */
			if (behavior === "instant") {
				scrollContainer.scrollTop = measureTarget();
				return;
			}

			/* rAF-driven smooth scroll — ease-out over ~300ms. Each frame
			 * recalculates the target position so panel transitions (old
			 * panel unmounting, content shifting upward) don't invalidate
			 * the destination. startTop is captured once; the easing curve
			 * interpolates between startTop and the live target. */
			const duration = 300;
			const startTime = performance.now();
			const startTop = scrollContainer.scrollTop;

			const step = (now: number) => {
				const elapsed = now - startTime;
				const progress = Math.min(elapsed / duration, 1);
				/* Ease-out cubic — fast start, gentle deceleration. */
				const eased = 1 - (1 - progress) ** 3;

				const targetTop = measureTarget();
				scrollContainer.scrollTop = startTop + (targetTop - startTop) * eased;

				if (progress < 1) {
					scrollAnimationRef.current = requestAnimationFrame(step);
				} else {
					scrollAnimationRef.current = null;
				}
			};
			scrollAnimationRef.current = requestAnimationFrame(step);
		},
		[],
	);

	/* Register the scroll implementation so the engine can invoke it.
	 * Called directly by `engine.fulfillPendingScroll()` (from the panel
	 * mount effect) and `engine.scrollToQuestion()` (from undo/redo). */
	useEffect(() => {
		builder.registerScrollCallback(scrollToQuestion);
		return () => builder.clearScrollCallback();
	}, [builder, scrollToQuestion]);

	// ── Undo/Redo with atomic view restoration ──────────────────────────

	/**
	 * Find a specific field element within a question's InlineSettingsPanel.
	 * Queries by stable UUID so the element is found even after renames.
	 * Returns the `[data-field-id]` wrapper if the panel is mounted and the
	 * field exists, null otherwise. Used by undo/redo to scroll to the exact
	 * field the user was editing before the mutation.
	 */
	const findFieldElement = useCallback(
		(questionUuid: string, fieldId?: string): HTMLElement | null => {
			if (!fieldId) return null;
			const questionEl = document.querySelector(
				`[data-question-uuid="${questionUuid}"]`,
			) as HTMLElement | null;
			const panel = questionEl?.nextElementSibling as HTMLElement | null;
			if (!panel?.hasAttribute("data-settings-panel")) return null;
			return panel.querySelector(`[data-field-id="${fieldId}"]`);
		},
		[],
	);

	/**
	 * Shared restore logic for undo/redo — calls temporal undo/redo,
	 * then scrolls to the affected field with a violet flash highlight.
	 *
	 * zundo atomically restores entity data + navigation state (screen,
	 * navEntries, navCursor) in the store — no local state sync needed.
	 * `flushSync` forces React to commit the external store update before
	 * any DOM queries. This eliminates the need for requestAnimationFrame
	 * timing hacks — fields toggled into existence by the undo are
	 * immediately queryable. The panel mounts synchronously (no animation),
	 * so fields are always in the DOM after flushSync.
	 */
	const applyUndoRedo = useCallback(
		(action: "undo" | "redo") => {
			const temporal = builder.store.temporal.getState();
			const canDo =
				action === "undo"
					? temporal.pastStates.length > 0
					: temporal.futureStates.length > 0;
			if (!canDo) return;

			/* Execute the undo/redo — zundo atomically restores entity data +
			 * screen + navEntries + navCursor + cursorMode + activeFieldId. */
			flushSync(() => {
				temporal[action]();
			});

			/* Read selected + activeFieldId from the LIVE store (excluded from
			 * partialize — they're derived from the restored entity state). */
			const s = builder.store.getState();
			const questionUuid = s.selected?.questionUuid;
			if (!questionUuid) return;
			const fieldId = s.activeFieldId;

			/* Set focus hint on the engine so InlineSettingsPanel can consume it. */
			if (fieldId) {
				builder.setFocusHint(fieldId);
			}

			/* Instant scroll + flash — undo/redo is a state-change affordance
			 * ("this changed"), not navigation. Target the specific field wrapper
			 * if activeFieldId names one, otherwise the question card itself. */
			const targetEl = findFieldElement(questionUuid, fieldId);
			builder.scrollToQuestion(questionUuid, targetEl ?? undefined, "instant");
			const flashEl =
				targetEl ??
				(document.querySelector(
					`[data-question-uuid="${questionUuid}"]`,
				) as HTMLElement | null);
			if (flashEl) flashUndoHighlight(flashEl);
		},
		[builder, findFieldElement, flashUndoHighlight],
	);

	const handleUndo = useCallback(() => {
		applyUndoRedo("undo");
	}, [applyUndoRedo]);

	const handleRedo = useCallback(() => {
		applyUndoRedo("redo");
	}, [applyUndoRedo]);

	const handleDelete = useCallback(() => {
		const s = builder.store.getState();
		const sel = s.selected;
		if (
			!sel ||
			sel.type !== "question" ||
			sel.formIndex === undefined ||
			!sel.questionPath
		)
			return;
		/* Assemble the form from normalized entities to get the question tree
		 * for adjacency lookup (flattenQuestionRefs). */
		const moduleId = s.moduleOrder[sel.moduleIndex];
		const formId = moduleId
			? s.formOrder[moduleId]?.[sel.formIndex]
			: undefined;
		const formEntity = formId ? s.forms[formId] : undefined;
		if (!formId || !formEntity) return;
		const form = assembleForm(formEntity, formId, s.questions, s.questionOrder);

		const refs = flattenQuestionRefs(form.questions);
		const curIdx = refs.findIndex((r) => r.uuid === sel.questionUuid);
		const next = refs[curIdx + 1] ?? refs[curIdx - 1];

		s.removeQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath);

		if (next) {
			builder.navigateTo({
				type: "question",
				moduleIndex: sel.moduleIndex,
				formIndex: sel.formIndex,
				questionPath: next.path,
				questionUuid: next.uuid,
			});
		} else {
			builder.select();
		}
	}, [builder]);

	const shortcuts = useBuilderShortcuts(
		builder,
		handleCursorModeChange,
		handleDelete,
		handleUndo,
		handleRedo,
	);

	useKeyboardShortcuts("builder-layout", shortcuts);

	/* Navigation with selection sync — delegated to engine methods that
	 * combine store navigation actions with tree selection sync. */
	const handlePreviewBack = useCallback(
		() => builder.navBackWithSync(),
		[builder],
	);

	const handlePreviewUp = useCallback(() => builder.navUpWithSync(), [builder]);

	/* Breadcrumb click handlers — memoized on navigation structure so they're
	 * stable across unrelated renders (chat messages, selection changes, etc.).
	 * This lets CollapsibleBreadcrumb's memo() skip re-renders when nothing changed. */
	const breadcrumbHandlers = useMemo(
		() =>
			breadcrumbs.map((item) => () => builder.navigateToScreen(item.screen)),
		[breadcrumbs, builder],
	);

	const noop = useCallback(() => {}, []);

	/**
	 * Context getter for the ReferenceProvider. Reads from the store's current
	 * selection (contextual editor) or the nav's current form screen (preview canvas).
	 * Returns undefined when no form is active (home/module screens).
	 */
	const getRefContext = useCallback(() => {
		const s = builder.store.getState();
		if (s.moduleOrder.length === 0) return undefined;

		/* Assemble the full blueprint once — both branches below need it. */
		const bp = assembleBlueprint(getEntityData(s));

		/* Prefer the selected question's form (contextual editor context). */
		const sel = s.selected;
		if (sel?.type === "question" && sel.formIndex !== undefined) {
			const form = bp.modules[sel.moduleIndex]?.forms[sel.formIndex];
			const mod = bp.modules[sel.moduleIndex];
			if (form)
				return {
					blueprint: bp,
					form,
					moduleCaseType: mod?.case_type ?? undefined,
				};
		}

		/* Fall back to the store's current screen (preview canvas context). */
		const screen = s.screen;
		if (screen.type === "form") {
			const form = bp.modules[screen.moduleIndex]?.forms[screen.formIndex];
			const mod = bp.modules[screen.moduleIndex];
			if (form)
				return {
					blueprint: bp,
					form,
					moduleCaseType: mod?.case_type ?? undefined,
				};
		}

		return undefined;
	}, [builder]);

	/** Subscribe to question entity changes for cache invalidation.
	 *  Stable callback — only changes when the builder (store) changes. */
	const subscribeMutation = useCallback(
		(listener: () => void) =>
			builder.store.subscribe(
				(s) => s.questions,
				() => listener(),
			),
		[builder],
	);

	// ── Redirect guard — all hooks must be above this line ─────────────
	// Server layout handles auth; this only catches edge cases like an
	// expired session mid-use. Skip while the client-side session check
	// is still in flight — the server layout already verified the cookie,
	// so the pending state is always transient.
	const shouldRedirect = !isAuthenticated && !isAuthPending;
	useEffect(() => {
		if (shouldRedirect) router.push("/");
	}, [shouldRedirect, router]);
	if (shouldRedirect) return null;

	/* Gate rendering until the app is loaded from Firestore.
	 * The Loading phase is the single source of truth — no separate React state. */
	if (phase === BuilderPhase.Loading) {
		return (
			<div className="h-full flex items-center justify-center">
				<div className="animate-pulse">
					<Logo size="md" />
				</div>
			</div>
		);
	}

	/* Progress card mounts only during active generation (including errors, which
	 * stay in Generating phase). Never for hydrated apps that go straight to Ready. */
	const showProgress = phase === BuilderPhase.Generating && !inReplayMode;
	const showToolbar = isReady && hasData;

	// Breadcrumb parts — keys from screen identity (type + indices) since labels
	// aren't unique ("App > Intake > Intake"). Handlers are stable memoized references.
	const breadcrumbParts: BreadcrumbPart[] = hasData
		? breadcrumbs.map((item, i) => ({
				key: item.key,
				label: item.label,
				onClick: breadcrumbHandlers[i] ?? noop,
			}))
		: appName
			? [{ key: "home", label: appName, onClick: noop }]
			: [];

	return (
		<ReferenceProviderWrapper
			getContext={getRefContext}
			subscribeMutation={subscribeMutation}
		>
			<div className="h-full flex flex-col overflow-hidden">
				{/* Replay controller — between header and content so it's visible in both centered and sidebar modes */}
				{inReplayMode && (
					<ReplayController
						onExit={handleExitReplay}
						onMessagesChange={setReplayMessages}
					/>
				)}

				{/* Builder subheader: nav + breadcrumbs (left) + action buttons (right).
				 *  Builder-specific toolbar — separate from the global AppHeader. */}
				<AnimatePresence>
					{!isCentered && (
						<motion.div
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{
								opacity: 0,
								y: -8,
								transition: { duration: 0.15, ease: [0.4, 0, 0.2, 1] },
							}}
							transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
							className="flex items-center justify-between px-5 h-12 border-b border-nova-border shrink-0 bg-[#0c0c20]"
						>
							<div className="flex items-center gap-2 min-w-0">
								{hasData && (
									<ScreenNavButtons
										canGoBack={canGoBack}
										canGoUp={canGoUp}
										onBack={handlePreviewBack}
										onUp={handlePreviewUp}
									/>
								)}
								<CollapsibleBreadcrumb parts={breadcrumbParts} />
							</div>
							{showToolbar && (
								<div className="flex items-center gap-1 shrink-0">
									<SaveIndicator saveState={saveStatus} />
									<AppConnectSettings builder={builder} />
									<Tooltip content={`Undo (${shortcutLabel("mod", "Z")})`}>
										<button
											type="button"
											onClick={handleUndo}
											disabled={!canUndo}
											className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
											aria-label="Undo"
										>
											<Icon icon={tablerArrowBackUp} width="18" height="18" />
										</button>
									</Tooltip>
									<Tooltip
										content={`Redo (${shortcutLabel("mod", "shift", "Z")})`}
									>
										<button
											type="button"
											onClick={handleRedo}
											disabled={!canRedo}
											className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
											aria-label="Redo"
										>
											<Icon
												icon={tablerArrowForwardUp}
												width="18"
												height="18"
											/>
										</button>
									</Tooltip>
									<ExportDropdown options={exportOptions} compact />
								</div>
							)}
						</motion.div>
					)}
				</AnimatePresence>

				{/* Content area — flex row of sidebars and main content.
				 *  Both sidebars animate width on open/close. ChatSidebar stays mounted
				 *  (width: 0) when collapsed to preserve scroll state and grid controller. */}
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
								<StructureSidebar onClose={() => setStructureOpen(false)} />
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
											onClick={() => setStructureOpen(true)}
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
											onClick={() => setChatOpen(true)}
											className="absolute top-3 right-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
											aria-label="Open chat sidebar"
										>
											<Icon
												icon={tablerMessageChatbot}
												width="20"
												height="20"
											/>
										</button>
									</Tooltip>
								)}

								<ErrorBoundary>
									{isReady && hasData ? (
										<PreviewShell
											hideHeader
											topInset={showToolbar ? TOOLBAR_INSET : 0}
											onBack={handlePreviewBack}
										/>
									) : null}
								</ErrorBoundary>

								{/* Cursor mode pill — absolutely positioned centered pill over
								 *  the scroll container so backdrop-filter samples the scrolling
								 *  content beneath. Pill shape avoids covering sidebar expand
								 *  icons at the edges. topInset on PreviewShell offsets content
								 *  so it starts below this overlay at initial scroll position. */}
								{showToolbar && (
									<div className="absolute top-2.5 inset-x-0 z-raised flex justify-center pointer-events-none">
										<div className="pointer-events-auto rounded-full bg-[rgba(93,88,167,0.25)] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/[0.1] shadow-[0_4px_20px_rgba(139,92,246,0.1),0_2px_8px_rgba(0,0,0,0.2)] px-1 py-1">
											<CursorModeSelector
												mode={cursorMode}
												onChange={handleCursorModeChange}
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
												<GenerationProgress
													stage={generationStage}
													generationError={generationError}
													statusMessage={statusMessage}
												/>
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
							<ChatSidebar
								key="chat"
								centered={isCentered}
								heroLogo={isCentered ? <Logo size="hero" /> : undefined}
								messages={inReplayMode ? replayMessages : messages}
								status={inReplayMode ? "ready" : status}
								onSend={handleSend}
								onClose={() => setChatOpen(false)}
								addToolOutput={addToolOutput}
								readOnly={inReplayMode}
							/>
						</ErrorBoundary>
					</motion.div>
				</div>
			</div>
		</ReferenceProviderWrapper>
	);
}
