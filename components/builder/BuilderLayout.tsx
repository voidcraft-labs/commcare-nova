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
import { useAuth } from "@/hooks/useAuth";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useBuilder } from "@/hooks/useBuilder";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { usePreviewNav } from "@/hooks/usePreviewNav";
import { parseApiErrorMessage } from "@/lib/apiError";
import {
	getParentScreen,
	type PreviewScreen,
} from "@/lib/preview/engine/types";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import {
	applyDataPart,
	type Builder,
	BuilderPhase,
	type CursorMode,
	type SelectedElement,
	type ViewContext,
} from "@/lib/services/builder";
import { consumeReplayData } from "@/lib/services/logReplay";
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

/** Scroll margin below the toolbar overlay — keeps the target element from
 *  being flush against the overlay when snapping to the top. */
const SCROLL_MARGIN = 20;

/** Create a Chat instance with transport, data handling, and auto-resend config.
 *  Closures capture refs (not direct values) so they always read the latest
 *  builder and runId — safe across re-renders within the same app session. */
function createChatInstance(
	builderRef: { current: Builder },
	runIdRef: { current: string | undefined },
): Chat<UIMessage> {
	return new Chat<UIMessage>({
		transport: new DefaultChatTransport({
			api: "/api/chat",
			body: () => ({
				blueprint: builderRef.current.blueprint ?? undefined,
				runId: runIdRef.current,
				appId: builderRef.current.appId,
			}),
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
	/* Server layout (`app/build/layout.tsx`) already gates auth — by the time
	 * this component mounts, the user is guaranteed authenticated. We still
	 * call useAuth() for the `isAuthenticated` flag (used by useAutoSave and
	 * the hasAccess guard for replay mode), but we never block rendering on
	 * the client-side pending state since the server already resolved it. */
	const { isAuthenticated, isPending: isAuthPending } = useAuth();
	const builder = useBuilder();

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

	// ── Replay — consumed once on mount, cleared on app switch ───────────
	const [initialReplay] = useState(consumeReplayData);
	const replayStartIndex = initialReplay?.doneIndex ?? 0;
	const [replayData, setReplayDataState] = useState(() => {
		if (initialReplay) {
			for (let i = 0; i <= replayStartIndex; i++) {
				initialReplay.stages[i]?.applyToBuilder(builder);
			}
		}
		return initialReplay;
	});
	const [replayMessages, setReplayMessages] = useState(
		() => initialReplay?.stages[replayStartIndex]?.messages ?? [],
	);

	/* Detect builder identity change (new app via BuilderProvider). Clear
	 * stale local state from the previous app: replay data, run ID, and
	 * the Chat instance. Uses the React "adjusting state during rendering"
	 * pattern — React discards the current render and re-renders immediately
	 * with the updated state, so no stale frame is ever painted. */
	if (builder !== prevBuilderRef.current) {
		prevBuilderRef.current = builder;
		runIdRef.current = undefined;
		setChat(createChatInstance(builderRef, runIdRef));
		if (replayData) {
			setReplayDataState(undefined);
			setReplayMessages([]);
		}
	}

	const [chatOpen, setChatOpen] = useState(true);
	const [structureOpen, setStructureOpen] = useState(true);
	const [cursorMode, setCursorMode] = useState<CursorMode>("inspect");
	const cursorModeRef = useRef(cursorMode);
	const [scrollAnchor, setScrollAnchor] = useState<{
		questionPath: string;
		offsetTop: number;
		allPaths: string[];
	} | null>(null);
	cursorModeRef.current = cursorMode;

	const handleExitReplay = useCallback(() => {
		setReplayDataState(undefined);
		setReplayMessages([]);
		builder.reset();
	}, [builder]);

	const nav = usePreviewNav(builder.blueprint);
	const navRef = useRef(nav);
	navRef.current = nav;

	/* Sync non-DOM view state to Builder so HistoryManager's deriveView()
	 * callback can assemble the full ViewContext at snapshot time.
	 * Plain assignments during render — no DOM reads, no side effects.
	 * focusHint is captured lazily by Builder.deriveViewContext() at mutation
	 * time via document.activeElement, which is safe because mutations only
	 * happen during user interactions (never during SSR or render). */
	builder.setScreen(nav.current);
	builder.setCursorMode(cursorMode);

	const handleCursorModeChange = useCallback((mode: CursorMode) => {
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
						questionPath:
							questionEls[i].getAttribute("data-question-uuid") ?? "",
						offsetTop: rect.top - containerRect.top,
						allPaths: questionEls.map(
							(el) => el.getAttribute("data-question-uuid") ?? "",
						),
					});
					break;
				}
			}
		}

		cursorModeRef.current = mode;
		setCursorMode(mode);
	}, []);

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
			`[data-question-uuid="${scrollAnchor.questionPath}"]`,
		) as HTMLElement | null;

		if (!targetEl) {
			// Anchor hidden in new mode — find nearest visible question above it
			const anchorIdx = scrollAnchor.allPaths.indexOf(
				scrollAnchor.questionPath,
			);
			for (let i = anchorIdx - 1; i >= 0; i--) {
				targetEl = scrollContainer.querySelector(
					`[data-question-uuid="${scrollAnchor.allPaths[i]}"]`,
				) as HTMLElement | null;
				if (targetEl) break;
			}
		}

		if (targetEl) {
			const containerRect = scrollContainer.getBoundingClientRect();
			const currentOffset =
				targetEl.getBoundingClientRect().top - containerRect.top;
			scrollContainer.scrollTop += currentOffset - scrollAnchor.offsetTop;
		}
	}, [scrollAnchor]);

	const inReplayMode = !!replayData;
	const hasAccess = isAuthenticated || inReplayMode;
	const isCentered = builder.phase === BuilderPhase.Idle;

	// ── Navigate to first form when generation completes ──
	const prevPhaseRef = useRef(builder.phase);
	useEffect(() => {
		const wasGenerating = prevPhaseRef.current === BuilderPhase.Generating;
		if (wasGenerating && builder.phase === BuilderPhase.Ready) {
			if (
				builder.blueprint &&
				builder.blueprint.modules.length > 0 &&
				builder.blueprint.modules[0].forms.length > 0
			) {
				nav.navigateToForm(0, 0);
			}
		}
		prevPhaseRef.current = builder.phase;
	}, [builder.phase, builder.blueprint, nav.navigateToForm]);

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
	useEffect(() => {
		if (!chatError) return;
		const message = parseApiErrorMessage(chatError.message);
		if (builder.phase === BuilderPhase.Generating && !builder.generationError) {
			builder.setGenerationError(message, "failed");
		}
		showToast("error", "Generation failed", message);
	}, [chatError, builder]);

	// Auto-save blueprint edits to Firestore (authenticated users only)
	const saveStatus = useAutoSave(builder, isAuthenticated);

	const _isGenerating = builder.isGenerating;

	const handleSend = useCallback(
		(text: string) => {
			if (!text.trim() || !hasAccess) return;
			sendMessage({ text });
		},
		[hasAccess, sendMessage],
	);

	const handleExportCcz = useCallback(async () => {
		if (!builder.blueprint) return;
		try {
			const res = await fetch("/api/compile", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: builder.blueprint }),
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
		if (!builder.blueprint) return;
		try {
			const res = await fetch("/api/compile/json", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ blueprint: builder.blueprint }),
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
			a.download = `${builder.blueprint.app_name || "app"}.json`;
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
	 * Accounts for two layout complexities:
	 * 1. **Toolbar overlay** — the glassmorphic cursor mode toolbar is absolutely
	 *    positioned over the top of the scroll container. The visible region starts
	 *    at `containerRect.top + paddingTop` (set by PreviewShell's `topInset`).
	 * 2. **Collapsing InlineSettingsPanel** — when selection changes, the old
	 *    panel is still at full height in the DOM (AnimatePresence exit hasn't
	 *    started). If it's above the target, its height is subtracted from the
	 *    scroll target to compensate for the layout shift during collapse.
	 */
	const scrollToQuestion = useCallback(
		(
			questionUuid: string,
			prevUuid?: string,
			overrideTarget?: HTMLElement,
			behavior: ScrollBehavior = "smooth",
		) => {
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

			/* Measure collapsing panel height shift when switching questions.
			 * The old InlineSettingsPanel is still at full height in the DOM
			 * (AnimatePresence exit hasn't started). Only compensate when the
			 * panel is above the target — i.e., its collapse will shift the
			 * target upward. Check the panel's position directly, not the
			 * previous question's, because children inside a group are above
			 * the group's panel even though they're below the group element. */
			let collapsingShift = 0;
			if (prevUuid && prevUuid !== questionUuid) {
				const prevEl = scrollContainer.querySelector(
					`[data-question-uuid="${prevUuid}"]`,
				) as HTMLElement | null;
				if (prevEl) {
					const panel = prevEl.nextElementSibling as HTMLElement | null;
					if (panel?.hasAttribute("data-settings-panel")) {
						const panelRect = panel.getBoundingClientRect();
						if (panelRect.top < el.getBoundingClientRect().top) {
							collapsingShift = panelRect.height;
						}
					}
				}
			}

			const containerRect = scrollContainer.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			/* Top of the visible region, accounting for the toolbar overlay. */
			const visibleTop =
				containerRect.top +
				(scrollContainer.style.paddingTop
					? Number.parseInt(scrollContainer.style.paddingTop, 10)
					: 0);
			const adjustedTop = elRect.top - collapsingShift;
			/* Always pin to the top — don't skip when already visible. */
			const targetScrollTop =
				scrollContainer.scrollTop + adjustedTop - visibleTop - SCROLL_MARGIN;
			scrollContainer.scrollTo({
				top: Math.max(0, targetScrollTop),
				behavior,
			});
		},
		[],
	);

	/* Register the scroll implementation so `builder.navigateTo()` can
	 * scroll the design canvas. BuilderLayout owns the DOM — the Builder
	 * service just invokes the callback when navigation intent is expressed. */
	useEffect(() => {
		builder.registerScrollCallback(scrollToQuestion);
		return () => builder.clearScrollCallback();
	}, [builder, scrollToQuestion]);

	// ── Undo/Redo with atomic view restoration ──────────────────────────
	/**
	 * Restore the full UI context from a snapshot's ViewContext.
	 * Selection is already set by builder.undo/redo; this handles
	 * the navigation screen and cursor mode that live in component state.
	 */
	const restoreView = useCallback(
		(view: ViewContext) => {
			/* Restore cursor mode */
			if (view.cursorMode !== cursorModeRef.current) {
				cursorModeRef.current = view.cursorMode;
				setCursorMode(view.cursorMode);
			}

			/* Restore navigation screen from the snapshot — navigates to the
			 * exact screen the user was on when they made the mutation. */
			const screen = view.screen;
			switch (screen.type) {
				case "home":
					nav.navigateToHome();
					break;
				case "module":
					nav.navigateToModule(screen.moduleIndex);
					break;
				case "caseList":
					nav.navigateToCaseList(screen.moduleIndex, screen.formIndex);
					break;
				case "form":
					nav.navigateToForm(
						screen.moduleIndex,
						screen.formIndex,
						screen.caseId,
					);
					break;
			}
		},
		[
			nav.navigateToHome,
			nav.navigateToModule,
			nav.navigateToCaseList,
			nav.navigateToForm,
		],
	);

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
	 * Check whether the InlineSettingsPanel is currently mounted for a
	 * given question (by UUID). The panel renders as the next sibling of
	 * the question wrapper, tagged with `data-settings-panel`.
	 *
	 * Because UUIDs are stable across renames, this returns true for
	 * same-question rename undos — the panel never unmounted.
	 */
	const isPanelMounted = useCallback((questionUuid: string): boolean => {
		const questionEl = document.querySelector(
			`[data-question-uuid="${questionUuid}"]`,
		) as HTMLElement | null;
		const next = questionEl?.nextElementSibling as HTMLElement | null;
		return next?.hasAttribute("data-settings-panel") ?? false;
	}, []);

	/**
	 * Shared restore logic for undo/redo — restores view context then
	 * scrolls to the affected field with a violet flash highlight.
	 *
	 * `flushSync` around `restoreView` forces React to commit all pending
	 * state (external store + component state) before any DOM queries.
	 * This eliminates the need for requestAnimationFrame timing hacks —
	 * fields toggled into existence by the undo are immediately queryable.
	 *
	 * Two scroll strategies based on panel state:
	 * 1. **Panel already mounted** (same question — UUID matches even after
	 *    rename): smooth scroll to the field. The user is already viewing
	 *    this panel, so the smooth motion guides their eye to the change.
	 * 2. **Panel will mount** (cross-question or cross-form undo): defer to
	 *    motion's `onAnimationComplete` via `setPendingPanelScroll`, then
	 *    instant-scroll. The entrance animation provides the visual cue;
	 *    the flash fires after it completes to pinpoint the field.
	 *
	 * With UUID-based identity, rename undos always take path 1 — the UUID
	 * never changes, so `isPanelMounted` always finds the panel.
	 */
	const applyUndoRedo = useCallback(
		(view: ViewContext | undefined) => {
			if (!view) return;

			/* flushSync forces React to commit all pending state — both the
			 * external store update from builder.undo/redo (via notify()) AND
			 * the component state from restoreView (cursor mode, nav screen).
			 * After this returns the DOM reflects the new blueprint, so field
			 * elements toggled by the undo (e.g. Required) are queryable
			 * without a requestAnimationFrame hack. */
			flushSync(() => {
				restoreView(view);
			});

			const questionUuid = view.selected?.questionUuid;
			if (!questionUuid) return;
			const fieldId = view.focusHint;

			/** Scroll to the affected element, then flash it.
			 *  The specific field wrapper if focusHint names one, otherwise
			 *  the question card itself. */
			const scrollAndFlash = (behavior: ScrollBehavior) => {
				const targetEl = findFieldElement(questionUuid, fieldId);
				scrollToQuestion(
					questionUuid,
					undefined,
					targetEl ?? undefined,
					behavior,
				);
				const flashEl =
					targetEl ??
					(document.querySelector(
						`[data-question-uuid="${questionUuid}"]`,
					) as HTMLElement | null);
				if (flashEl) flashUndoHighlight(flashEl);
			};

			if (isPanelMounted(questionUuid)) {
				/* Same-question undo (UUID is stable — true even for rename
				 * undos). Instant scroll + flash — undo/redo is a state-change
				 * affordance ("this changed"), not navigation. */
				scrollAndFlash("instant");
			} else {
				/* Cross-question or cross-form undo — panel will mount with an
				 * entrance animation. Defer until `onAnimationComplete`, then
				 * instant-scroll (the animation itself provides the visual cue). */
				builder.setPendingPanelScroll(questionUuid, () =>
					scrollAndFlash("instant"),
				);
			}
		},
		[
			builder,
			restoreView,
			scrollToQuestion,
			findFieldElement,
			isPanelMounted,
			flashUndoHighlight,
		],
	);

	const handleUndo = useCallback(() => {
		applyUndoRedo(builder.undo());
	}, [builder, applyUndoRedo]);

	const handleRedo = useCallback(() => {
		applyUndoRedo(builder.redo());
	}, [builder, applyUndoRedo]);

	// ── Structure tree selection → select + navigate canvas ─────────────
	const handleTreeSelect = useCallback(
		(sel: SelectedElement) => {
			builder.navigateTo(sel);
			if (!sel) {
				nav.navigateToHome();
				return;
			}
			if (!builder.blueprint) return;
			if (sel.formIndex !== undefined) {
				const currentCaseId =
					nav.current.type === "form" ? nav.current.caseId : undefined;
				nav.navigateToForm(sel.moduleIndex, sel.formIndex, currentCaseId);
			} else {
				nav.navigateToModule(sel.moduleIndex);
			}
		},
		[
			builder,
			nav.navigateToHome,
			nav.navigateToForm,
			nav.navigateToModule,
			nav.current,
		],
	);

	const handleDelete = useCallback(() => {
		const sel = builder.selected;
		if (
			!sel ||
			sel.type !== "question" ||
			sel.formIndex === undefined ||
			!sel.questionPath
		)
			return;
		const mb = builder.mb;
		if (!mb) return;
		const form = mb.getForm(sel.moduleIndex, sel.formIndex);
		if (!form) return;

		const refs = flattenQuestionRefs(form.questions);
		const curIdx = refs.findIndex((r) => r.uuid === sel.questionUuid);
		const next = refs[curIdx + 1] ?? refs[curIdx - 1];

		mb.removeQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath);
		builder.notifyBlueprintChanged();

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
		cursorMode,
		handleCursorModeChange,
		handleDelete,
		handleUndo,
		handleRedo,
	);

	useKeyboardShortcuts("builder-layout", shortcuts);

	/** Sync builder selection to match the given preview screen. */
	const syncSelection = useCallback(
		(screen: PreviewScreen | undefined) => {
			if (!screen || screen.type === "home") {
				builder.select();
			} else if (screen.type === "module") {
				builder.select({ type: "module", moduleIndex: screen.moduleIndex });
			} else if (screen.type === "form" || screen.type === "caseList") {
				builder.select({
					type: "form",
					moduleIndex: screen.moduleIndex,
					formIndex: screen.formIndex,
				});
			}
		},
		[builder],
	);

	const handlePreviewBack = useCallback(() => {
		syncSelection(nav.back());
	}, [nav, syncSelection]);

	const handlePreviewUp = useCallback(() => {
		nav.navigateUp();
		syncSelection(getParentScreen(nav.current));
	}, [nav, syncSelection]);

	// Breadcrumb click handlers — memoized on navigation structure so they're
	// stable across unrelated renders (chat messages, selection changes, etc.).
	// This lets CollapsibleBreadcrumb's memo() skip re-renders when nothing changed.
	const breadcrumbHandlers = useMemo(
		() =>
			nav.breadcrumbPath.map((screen, idx) => () => {
				nav.navigateTo(idx);
				syncSelection(screen);
			}),
		[nav.breadcrumbPath, nav.navigateTo, syncSelection],
	);

	const noop = useCallback(() => {}, []);

	/**
	 * Context getter for the ReferenceProvider. Reads from the builder's current
	 * selection (contextual editor) or the nav's current form screen (preview canvas).
	 * Returns undefined when no form is active (home/module screens).
	 */
	const getRefContext = useCallback(() => {
		const mb = builder.mb;
		if (!mb) return undefined;
		const blueprint = mb.getBlueprint();

		/* Prefer the selected question's form (contextual editor context). */
		const sel = builder.selected;
		if (sel?.type === "question" && sel.formIndex !== undefined) {
			const form = mb.getForm(sel.moduleIndex, sel.formIndex);
			const mod = mb.getModule(sel.moduleIndex);
			if (form)
				return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined };
		}

		/* Fall back to the nav's current form screen (preview canvas context). */
		const screen = navRef.current.current;
		if (screen.type === "form") {
			const form = mb.getForm(screen.moduleIndex, screen.formIndex);
			const mod = mb.getModule(screen.moduleIndex);
			if (form)
				return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined };
		}

		return undefined;
	}, [builder]);

	// ── Redirect guard — all hooks must be above this line ─────────────
	// Server layout handles auth; this only catches edge cases like an
	// expired session or unauthenticated replay-mode exit. Skip while
	// the client-side session check is still in flight — the server layout
	// already verified the cookie, so the pending state is always transient.
	const shouldRedirect = !hasAccess && !isAuthPending;
	useEffect(() => {
		if (shouldRedirect) router.push("/");
	}, [shouldRedirect, router]);
	if (shouldRedirect) return null;

	/* Gate rendering until the app is loaded from Firestore.
	 * The Loading phase is the single source of truth — no separate React state. */
	if (builder.phase === BuilderPhase.Loading) {
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
	const showProgress =
		builder.phase === BuilderPhase.Generating && !inReplayMode;
	const showToolbar = !!(
		builder.treeData &&
		builder.phase === BuilderPhase.Ready &&
		builder.blueprint
	);
	const editMode =
		cursorMode === "pointer" ? ("test" as const) : ("edit" as const);

	// Breadcrumb parts — labels are derived unmemoized (for live inline title edits),
	// handlers are stable memoized references. Keys are derived from the underlying
	// PreviewScreen identity (type + indices) since labels aren't unique ("App > Intake > Intake").
	// During generation (no blueprint), show app name as a static non-clickable breadcrumb.
	const breadcrumbParts: BreadcrumbPart[] = builder.blueprint
		? nav.breadcrumb.map((item, i) => ({
				key: item.key,
				label: item.label,
				onClick: breadcrumbHandlers[i] ?? noop,
			}))
		: builder.treeData?.app_name
			? [{ key: "home", label: builder.treeData.app_name, onClick: noop }]
			: [];

	return (
		<ReferenceProviderWrapper
			getContext={getRefContext}
			subscribeMutation={builder.subscribeMutation}
		>
			<div className="h-full flex flex-col overflow-hidden">
				{/* Replay controller — between header and content so it's visible in both centered and sidebar modes */}
				{inReplayMode && replayData && (
					<ReplayController
						stages={replayData.stages}
						appName={replayData.appName}
						initialIndex={replayStartIndex}
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
								{builder.blueprint && (
									<ScreenNavButtons
										canGoBack={nav.canGoBack}
										canGoUp={nav.canGoUp}
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
									<button
										type="button"
										onClick={handleUndo}
										disabled={!builder.canUndo}
										className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
										title="Undo (⌘Z)"
										aria-label="Undo"
									>
										<Icon icon={tablerArrowBackUp} width="18" height="18" />
									</button>
									<button
										type="button"
										onClick={handleRedo}
										disabled={!builder.canRedo}
										className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
										title="Redo (⌘⇧Z)"
										aria-label="Redo"
									>
										<Icon icon={tablerArrowForwardUp} width="18" height="18" />
									</button>
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
						{!isCentered && builder.treeData && structureOpen && (
							<motion.div
								key="structure"
								initial={{ width: 0 }}
								animate={{ width: STRUCTURE_SIDEBAR_WIDTH }}
								exit={{ width: 0 }}
								transition={SIDEBAR_TRANSITION}
								className="shrink-0 overflow-hidden"
							>
								<StructureSidebar
									builder={builder}
									onClose={() => setStructureOpen(false)}
									onTreeSelect={handleTreeSelect}
								/>
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
								{/* Floating reopen buttons for collapsed sidebars */}
								{!structureOpen && builder.treeData && (
									<button
										type="button"
										onClick={() => setStructureOpen(true)}
										className="absolute top-3 left-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
										title="Open structure"
										aria-label="Open structure sidebar"
									>
										<Icon icon={tablerListTree} width="20" height="20" />
									</button>
								)}
								{!chatOpen && (
									<button
										type="button"
										onClick={() => setChatOpen(true)}
										className="absolute top-3 right-3 z-ground p-2 bg-nova-surface border border-nova-border rounded-lg hover:border-nova-border-bright transition-colors cursor-pointer"
										title="Open chat"
										aria-label="Open chat sidebar"
									>
										<Icon icon={tablerMessageChatbot} width="20" height="20" />
									</button>
								)}

								<ErrorBoundary>
									{builder.phase === BuilderPhase.Ready && builder.blueprint ? (
										<PreviewShell
											blueprint={builder.blueprint}
											builder={builder}
											mode={editMode}
											cursorMode={cursorMode}
											nav={nav}
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
										<div className="pointer-events-auto rounded-full bg-[rgba(10,10,26,0.5)] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/[0.06] shadow-[0_8px_24px_rgba(0,0,0,0.3)] px-1.5 py-1.5">
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
													stage={builder.generationStage}
													generationError={builder.generationError}
													statusMessage={builder.statusMessage}
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
