/**
 * BuilderLayout — thin structural shell for the builder page.
 *
 * Owns only:
 * - Phase-dependent layout structure (centered chat vs sidebar mode)
 * - Keyboard shortcuts (delegated to engine methods)
 * - Flipbook scroll sync (DOM measurement coordination during mode switches)
 * - The scroll-to-field callback registration
 * - BuilderReferenceProvider wrapping (the URL-aware reference context) —
 *   extracted into its own child so the `useLocation()` subscription for
 *   reference resolution doesn't cascade into layout re-renders on every
 *   `router.replace` for selection changes.
 *
 * All content, data subscriptions, and interactive behavior live in
 * self-sufficient child components:
 * - BuilderSubheader — nav, breadcrumbs, undo/redo, save, export
 * - BuilderContentArea — sidebar wrappers, reopen buttons, preview, chat
 * - ReplayController — replay transport bar
 * - ChatContainer — useChat lifecycle, stream effects
 * - GenerationProgress — generation stage/error/status
 * - CursorModeSelector — cursor mode from store
 * - StructureSidebar — fully propless
 *
 * BuilderLayout subscribes to two store fields: `phase` and `inReplayMode`.
 * All other store subscriptions live in the child components listed above.
 * This means BuilderLayout re-renders only on app lifecycle transitions
 * and replay mode toggle — not on messages, keystrokes, or clicks.
 */
"use client";
import { AnimatePresence, motion } from "motion/react";
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { BuilderContentArea } from "@/components/builder/BuilderContentArea";
import { BuilderReferenceProvider } from "@/components/builder/BuilderReferenceProvider";
import { BuilderSubheader } from "@/components/builder/BuilderSubheader";
import { useRegisterScrollCallback } from "@/components/builder/contexts/ScrollRegistryContext";
import { ReplayController } from "@/components/builder/ReplayController";
import { useBuilderShortcuts } from "@/components/builder/useBuilderShortcuts";
import { Logo } from "@/components/ui/Logo";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import { useAppStructure } from "@/lib/doc/hooks/useAppStructure";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { useNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/session/builderTypes";
import {
	useBuilderPhase,
	useCursorMode,
	useInReplayMode,
	useSwitchCursorMode,
} from "@/lib/session/hooks";
import type { CursorMode } from "@/lib/session/types";
import { useKeyboardShortcuts } from "@/lib/ui/hooks/useKeyboardShortcuts";

/** Extra space above the scroll target so the field isn't flush with the
 *  cursor mode overlay. Two values: a compact margin for plain selection,
 *  and an expanded margin when a TipTap inline editor is active. */
const SCROLL_MARGIN = 20;
const SCROLL_MARGIN_WITH_TOOLBAR = 60;

interface BuilderLayoutProps {
	/** Server-rendered thread history — passed through to ChatContainer.
	 *  Rendered inside a Suspense boundary by the RSC page. */
	children?: React.ReactNode;
	/** True when the app was loaded from Firestore (not a new build).
	 *  Drives thread type classification (build vs edit). */
	isExistingApp?: boolean;
	/** CommCare HQ settings read by the RSC page — drives the export
	 *  dropdown's configured/unconfigured state and upload dialog domain. */
	commcareSettings?: CommCareSettingsPublic;
}

export function BuilderLayout({
	children,
	isExistingApp,
	commcareSettings,
}: BuilderLayoutProps) {
	const docStore = useContext(BlueprintDocContext);
	const phase = useBuilderPhase();

	/* inReplayMode controls ReplayController mount in the header area. */
	const inReplayMode = useInReplayMode();

	/* CommCare settings — server-resolved, passed through to BuilderSubheader. */
	const commcareConfigured = commcareSettings?.configured ?? false;
	const commcareDomain = commcareSettings?.domain ?? null;

	// ── Flipbook scroll sync ──────────────────────────────────────────────
	// Switching cursor modes preserves scroll position so the same field
	// stays at the same pixel offset. This is the one piece of cross-component
	// coordination that BuilderLayout still owns because it needs to measure
	// the DOM before the mode switch and correct scroll during the sidebar
	// width animation that follows.

	const pendingScrollAnchorRef = useRef<{
		fieldUuid: string;
		offsetTop: number;
	} | null>(null);

	const [scrollAnchor, setScrollAnchor] = useState<{
		fieldUuid: string;
		offsetTop: number;
		allUuids: string[];
	} | null>(null);

	const switchCursorMode = useSwitchCursorMode();

	/* Track current cursor mode in a ref so the stable handleCursorModeChange
	 * callback can read it without adding cursorMode as a dependency. */
	const cursorMode = useCursorMode();
	const cursorModeRef = useRef(cursorMode);
	cursorModeRef.current = cursorMode;

	/** Capture scroll anchor before cursor mode switch, then delegate
	 *  the actual mode change to the session store's atomic switchCursorMode. */
	const handleCursorModeChange = useCallback(
		(mode: CursorMode) => {
			/* Early exit on same-mode: avoids DOM measurement + scroll anchor
			 * thrash that otherwise fires on every click of the already-active
			 * CursorModeSelector button. The session store also guards against
			 * same-mode no-ops internally, but by that point we've already run
			 * querySelectorAll + getBoundingClientRect + setScrollAnchor, which
			 * triggers a re-render and a useLayoutEffect that mutates scrollTop. */
			if (mode === cursorModeRef.current) return;

			const scrollContainer = document.querySelector(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (scrollContainer) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const questionEls = Array.from(
					scrollContainer.querySelectorAll("[data-field-uuid]"),
				);
				for (let i = 0; i < questionEls.length; i++) {
					const rect = questionEls[i].getBoundingClientRect();
					if (rect.bottom > containerRect.top) {
						setScrollAnchor({
							fieldUuid: questionEls[i].getAttribute("data-field-uuid") ?? "",
							offsetTop: rect.top - containerRect.top,
							allUuids: questionEls.map(
								(el) => el.getAttribute("data-field-uuid") ?? "",
							),
						});
						break;
					}
				}
			}

			switchCursorMode(mode);
		},
		[switchCursorMode],
	);

	/* Restore scroll position after mode switch. */
	useLayoutEffect(() => {
		if (!scrollAnchor) return;
		setScrollAnchor(null);

		const scrollContainer = document.querySelector(
			"[data-preview-scroll-container]",
		) as HTMLElement | null;
		if (!scrollContainer) return;

		let targetEl = scrollContainer.querySelector(
			`[data-field-uuid="${scrollAnchor.fieldUuid}"]`,
		) as HTMLElement | null;

		if (!targetEl) {
			/* Anchor hidden in new mode — bidirectional search for nearest visible. */
			const anchorIdx = scrollAnchor.allUuids.indexOf(scrollAnchor.fieldUuid);
			for (let dist = 1; dist < scrollAnchor.allUuids.length; dist++) {
				const backIdx = anchorIdx - dist;
				if (backIdx >= 0) {
					targetEl = scrollContainer.querySelector(
						`[data-field-uuid="${scrollAnchor.allUuids[backIdx]}"]`,
					) as HTMLElement | null;
					if (targetEl) break;
				}
				const fwdIdx = anchorIdx + dist;
				if (fwdIdx < scrollAnchor.allUuids.length) {
					targetEl = scrollContainer.querySelector(
						`[data-field-uuid="${scrollAnchor.allUuids[fwdIdx]}"]`,
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

			pendingScrollAnchorRef.current = {
				fieldUuid:
					targetEl.getAttribute("data-field-uuid") ?? scrollAnchor.fieldUuid,
				offsetTop: scrollAnchor.offsetTop,
			};
			setTimeout(() => {
				pendingScrollAnchorRef.current = null;
			}, 250);
		}
	}, [scrollAnchor]);

	/* ResizeObserver correction during sidebar width animation. `phase` is
	 * included as a dep to re-attach when the scroll container mounts (it
	 * doesn't exist during Idle/Generating phases). isReady is derived
	 * directly from phase; hasModules is read imperatively since the effect
	 * re-runs on phase change anyway. */
	useEffect(() => {
		const isReady =
			phase === BuilderPhase.Ready || phase === BuilderPhase.Completed;
		/* `hasModules` comes from the doc store — it owns blueprint entity data.
		 * Reading imperatively (no subscription) since we only branch on the
		 * condition at effect time; the effect re-runs on phase change. */
		const hasModules = (docStore?.getState().moduleOrder.length ?? 0) > 0;
		if (!isReady || !hasModules) return;

		const scrollContainer = document.querySelector(
			"[data-preview-scroll-container]",
		) as HTMLElement | null;
		if (!scrollContainer) return;

		const observer = new ResizeObserver(() => {
			const anchor = pendingScrollAnchorRef.current;
			if (!anchor) return;

			const el = scrollContainer.querySelector(
				`[data-field-uuid="${anchor.fieldUuid}"]`,
			) as HTMLElement | null;
			if (!el) return;

			const containerRect = scrollContainer.getBoundingClientRect();
			const currentOffset = el.getBoundingClientRect().top - containerRect.top;
			scrollContainer.scrollTop += currentOffset - anchor.offsetTop;
		});

		observer.observe(scrollContainer);
		return () => observer.disconnect();
	}, [docStore, phase]);

	// ── Scroll-to-field callback ─────────────────────────────────────

	const scrollAnimationRef = useRef<number | null>(null);
	const scrollToQuestion = useCallback(
		(
			fieldUuid: string,
			overrideTarget?: HTMLElement,
			behavior: ScrollBehavior = "smooth",
			hasToolbar = false,
		) => {
			if (scrollAnimationRef.current !== null) {
				cancelAnimationFrame(scrollAnimationRef.current);
				scrollAnimationRef.current = null;
			}

			const questionEl = document.querySelector(
				`[data-field-uuid="${fieldUuid}"]`,
			) as HTMLElement | null;
			const scrollContainer = questionEl?.closest(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (!questionEl || !scrollContainer) return;

			const el = overrideTarget ?? questionEl;
			const paddingTop = scrollContainer.style.paddingTop
				? Number.parseInt(scrollContainer.style.paddingTop, 10)
				: 0;
			const margin = hasToolbar ? SCROLL_MARGIN_WITH_TOOLBAR : SCROLL_MARGIN;
			const measureTarget = (): number => {
				const containerRect = scrollContainer.getBoundingClientRect();
				const elRect = el.getBoundingClientRect();
				const absoluteOffset =
					elRect.top - containerRect.top + scrollContainer.scrollTop;
				return Math.max(0, absoluteOffset - paddingTop - margin);
			};

			if (behavior === "instant") {
				scrollContainer.scrollTop = measureTarget();
				return;
			}

			const duration = 300;
			const startTime = performance.now();
			const startTop = scrollContainer.scrollTop;

			const step = (now: number) => {
				const elapsed = now - startTime;
				const progress = Math.min(elapsed / duration, 1);
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

	useRegisterScrollCallback(scrollToQuestion);

	// ── Keyboard shortcuts ──────────────────────────────────────────────

	const shortcuts = useBuilderShortcuts(handleCursorModeChange);

	useKeyboardShortcuts("builder-layout", shortcuts);

	// ── Navigate to first form when generation completes ──────────────

	const navigate = useNavigate();
	/* Read the two top-level order arrays together — `useAppStructure`
	 * returns a shallow-stable `{moduleOrder, formOrder}` pair so the
	 * navigate-to-first-form effect only re-fires when one of them
	 * actually changes reference. */
	const { moduleOrder: docModuleOrder, formOrder: docFormOrder } =
		useAppStructure();

	const prevPhaseRef = useRef(phase);
	useEffect(() => {
		const wasGenerating = prevPhaseRef.current === BuilderPhase.Generating;
		if (wasGenerating && phase === BuilderPhase.Completed) {
			const firstModuleUuid = docModuleOrder[0] as Uuid | undefined;
			const firstFormUuid = firstModuleUuid
				? (docFormOrder[firstModuleUuid]?.[0] as Uuid | undefined)
				: undefined;
			if (firstModuleUuid && firstFormUuid) {
				navigate.openForm(firstModuleUuid, firstFormUuid);
			}
		}
		prevPhaseRef.current = phase;
	}, [phase, docModuleOrder, docFormOrder, navigate]);

	// ── Render ──────────────────────────────────────────────────────────

	const isCentered = phase === BuilderPhase.Idle;

	if (phase === BuilderPhase.Loading) {
		return (
			<div className="h-full flex items-center justify-center">
				<div className="animate-pulse">
					<Logo size="md" />
				</div>
			</div>
		);
	}

	return (
		<BuilderReferenceProvider>
			<div className="h-full flex flex-col overflow-hidden">
				{/* Replay controller — self-sufficient, reads/writes replay state from store */}
				{inReplayMode && <ReplayController />}

				{/* Builder subheader — self-sufficient, owns nav/breadcrumbs/undo/redo/export */}
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
							<BuilderSubheader
								commcareConfigured={commcareConfigured}
								commcareDomain={commcareDomain}
							/>
						</motion.div>
					)}
				</AnimatePresence>

				{/* Content area — self-sufficient, owns sidebar/preview/chat layout */}
				<BuilderContentArea
					isCentered={isCentered}
					onCursorModeChange={handleCursorModeChange}
					isExistingApp={!!isExistingApp}
				>
					{children}
				</BuilderContentArea>
			</div>
		</BuilderReferenceProvider>
	);
}
