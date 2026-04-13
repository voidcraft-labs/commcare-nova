/**
 * BuilderLayout — thin structural shell for the builder page.
 *
 * Owns only:
 * - Phase-dependent layout structure (centered chat vs sidebar mode)
 * - Keyboard shortcuts (delegated to engine methods)
 * - Flipbook scroll sync (DOM measurement coordination during mode switches)
 * - The scroll-to-question callback registration
 * - ReferenceProviderWrapper (the root context provider)
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
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { BuilderContentArea } from "@/components/builder/BuilderContentArea";
import { BuilderSubheader } from "@/components/builder/BuilderSubheader";
import { ReplayController } from "@/components/builder/ReplayController";
import { useBuilderShortcuts } from "@/components/builder/useBuilderShortcuts";
import { Logo } from "@/components/ui/Logo";
import {
	useBuilderEngine,
	useBuilderPhase,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import type { CommCareSettingsPublic } from "@/lib/db/settings";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { ReferenceProviderWrapper } from "@/lib/references/ReferenceContext";
import { useNavigate } from "@/lib/routing/hooks";
import { BuilderPhase } from "@/lib/services/builder";
import { selectInReplayMode } from "@/lib/services/builderSelectors";
import type { CursorMode } from "@/lib/services/builderStore";
import {
	assembleBlueprint,
	getEntityData,
} from "@/lib/services/normalizedState";

/** Extra space above the scroll target so the question isn't flush with the
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
	const builder = useBuilderEngine();
	const phase = useBuilderPhase();

	/* inReplayMode controls ReplayController mount in the header area. */
	const inReplayMode = useBuilderStore(selectInReplayMode);

	/* CommCare settings — server-resolved, passed through to BuilderSubheader. */
	const commcareConfigured = commcareSettings?.configured ?? false;
	const commcareDomain = commcareSettings?.domain ?? null;

	// ── Flipbook scroll sync ──────────────────────────────────────────────
	// Switching cursor modes preserves scroll position so the same question
	// stays at the same pixel offset. This is the one piece of cross-component
	// coordination that BuilderLayout still owns because it needs to measure
	// the DOM before the mode switch and correct scroll during the sidebar
	// width animation that follows.

	const pendingScrollAnchorRef = useRef<{
		questionUuid: string;
		offsetTop: number;
	} | null>(null);

	const [scrollAnchor, setScrollAnchor] = useState<{
		questionUuid: string;
		offsetTop: number;
		allUuids: string[];
	} | null>(null);

	/** Capture scroll anchor before cursor mode switch, then delegate
	 *  the actual mode change to the store's atomic switchCursorMode. */
	const handleCursorModeChange = useCallback(
		(mode: CursorMode) => {
			if (mode === builder.store.getState().cursorMode) return;

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

			builder.store.getState().switchCursorMode(mode);
		},
		[builder],
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
			`[data-question-uuid="${scrollAnchor.questionUuid}"]`,
		) as HTMLElement | null;

		if (!targetEl) {
			/* Anchor hidden in new mode — bidirectional search for nearest visible. */
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

			pendingScrollAnchorRef.current = {
				questionUuid:
					targetEl.getAttribute("data-question-uuid") ??
					scrollAnchor.questionUuid,
				offsetTop: scrollAnchor.offsetTop,
			};
			setTimeout(() => {
				pendingScrollAnchorRef.current = null;
			}, 250);
		}
	}, [scrollAnchor]);

	/* ResizeObserver correction during sidebar width animation. `phase` is
	 * included as a dep to re-attach when the scroll container mounts (it
	 * doesn't exist during Idle/Generating phases). isReady/hasData are
	 * read imperatively since they're derived from phase. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: phase triggers re-attachment when scroll container mounts
	useEffect(() => {
		const s = builder.store.getState();
		const isReady =
			s.phase === BuilderPhase.Ready || s.phase === BuilderPhase.Completed;
		if (!isReady || s.moduleOrder.length === 0) return;

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
	}, [builder, phase]);

	// ── Scroll-to-question callback ─────────────────────────────────────

	const scrollAnimationRef = useRef<number | null>(null);
	const scrollToQuestion = useCallback(
		(
			questionUuid: string,
			overrideTarget?: HTMLElement,
			behavior: ScrollBehavior = "smooth",
			hasToolbar = false,
		) => {
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

	useEffect(() => {
		builder.registerScrollCallback(scrollToQuestion);
		return () => builder.clearScrollCallback();
	}, [builder, scrollToQuestion]);

	// ── Keyboard shortcuts ──────────────────────────────────────────────

	const shortcuts = useBuilderShortcuts(handleCursorModeChange);

	useKeyboardShortcuts("builder-layout", shortcuts);

	// ── Navigation ──────────────────────────────────────────────────────

	const navigate = useNavigate();

	// ── Navigate to first form when generation completes ──
	// Look up the first module and form UUIDs from the doc store so we can
	// call `navigate.openForm` with UUIDs instead of legacy indices.

	const docModuleOrder = useBlueprintDoc((s) => s.moduleOrder);
	const docFormOrder = useBlueprintDoc((s) => s.formOrder);

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

	// ── Reference provider ──────────────────────────────────────────────

	const getRefContext = useCallback(() => {
		const s = builder.store.getState();
		if (s.moduleOrder.length === 0) return undefined;

		const bp = assembleBlueprint(getEntityData(s));
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

	/** Subscribe to entity changes that invalidate the ReferenceProvider cache.
	 *  Covers questions (question references, case_property_on), modules
	 *  (case_type renames), and forms (form type changes affecting case config).
	 *  Uses a tuple selector with reference equality — only fires when at least
	 *  one entity map gets a new Immer reference. */
	const subscribeMutation = useCallback(
		(listener: () => void) =>
			builder.store.subscribe(
				(s) => [s.questions, s.modules, s.forms] as const,
				() => listener(),
				{
					equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
				},
			),
		[builder],
	);

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
		<ReferenceProviderWrapper
			getContext={getRefContext}
			subscribeMutation={subscribeMutation}
		>
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
		</ReferenceProviderWrapper>
	);
}
