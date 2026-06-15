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
 * - BuilderHeader — logo, Preview toggle (centered), undo/redo, save,
 *   export, account
 * - BuilderContentArea — sidebar wrappers, breadcrumb strip, preview, chat
 * - ReplayController — replay transport bar
 * - ChatContainer — useChat lifecycle, stream effects
 * - GenerationProgress — generation stage/error/status
 * - StructureSidebar — fully propless
 *
 * BuilderLayout subscribes to two store fields: `phase` and `inReplayMode`.
 * All other store subscriptions live in the child components listed above.
 * This means BuilderLayout re-renders only on app lifecycle transitions
 * and replay mode toggle — not on messages, keystrokes, or clicks.
 */
"use client";
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { BuilderContentArea } from "@/components/builder/BuilderContentArea";
import { BuilderHeader } from "@/components/builder/BuilderHeader";
import { BuilderReferenceProvider } from "@/components/builder/BuilderReferenceProvider";
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
	useInReplayMode,
	usePreviewing,
	useSetFlipbookScrollAnchor,
	useSetPreviewing,
} from "@/lib/session/hooks";
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
	/** Active impersonation info, or null/omitted when viewing as
	 *  yourself — surfaces the banner in BuilderHeader, mirroring the
	 *  site header. */
	impersonating?: { userName: string; userEmail: string } | null;
}

/**
 * Stable empty reference for the unconfigured / not-yet-loaded case. Reusing
 * one module-level array keeps `commcareAvailableDomains`'s identity constant
 * across renders so `ExportPanel`'s `memo` holds — a fresh `[]` literal each
 * render would defeat it (and re-fire the upload dialog's reset effect).
 */
const EMPTY_DOMAINS: { name: string; displayName: string }[] = [];

export function BuilderLayout({
	children,
	isExistingApp,
	commcareSettings,
	impersonating,
}: BuilderLayoutProps) {
	const docStore = useContext(BlueprintDocContext);
	const phase = useBuilderPhase();

	/* inReplayMode controls ReplayController mount in the header area. */
	const inReplayMode = useInReplayMode();

	/* CommCare settings — server-resolved, passed through to BuilderSubheader.
	 * `commcareSettings` is a discriminated union; narrow on `configured` to
	 * read the full reachable set `availableDomains` (the upload dialog picks
	 * the target from it per upload). */
	const commcareConfigured = commcareSettings?.configured ?? false;
	const commcareAvailableDomains = commcareSettings?.configured
		? commcareSettings.availableDomains
		: EMPTY_DOMAINS;

	// ── Flipbook scroll sync ──────────────────────────────────────────────
	// Toggling preview preserves scroll position so the same field stays
	// at the same pixel offset. This is the one piece of cross-component
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

	const setPreviewing = useSetPreviewing();
	const setFlipbookScrollAnchor = useSetFlipbookScrollAnchor();

	/* Track the current preview flag in a ref so the stable
	 * handleSetPreviewing callback can read it without re-creating. */
	const previewing = usePreviewing();
	const previewingRef = useRef(previewing);
	previewingRef.current = previewing;

	/** Capture scroll anchor before the preview toggle, then delegate
	 *  the actual flip to the session store's atomic setPreviewing. */
	const handleSetPreviewing = useCallback(
		(on: boolean) => {
			/* Early exit on same-value: avoids DOM measurement + scroll anchor
			 * thrash on a redundant toggle. The session store also guards
			 * against same-value no-ops internally, but by that point we've
			 * already run querySelectorAll + getBoundingClientRect +
			 * setScrollAnchor, which triggers a re-render and a
			 * useLayoutEffect that mutates scrollTop. */
			if (on === previewingRef.current) return;

			let topVisibleUuid: string | undefined;
			const scrollContainer = document.querySelector(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (scrollContainer) {
				const containerRect = scrollContainer.getBoundingClientRect();
				const fieldEls = Array.from(
					scrollContainer.querySelectorAll("[data-field-uuid]"),
				);
				for (let i = 0; i < fieldEls.length; i++) {
					const rect = fieldEls[i].getBoundingClientRect();
					if (rect.bottom > containerRect.top) {
						topVisibleUuid = fieldEls[i].getAttribute("data-field-uuid") ?? "";
						setScrollAnchor({
							fieldUuid: topVisibleUuid,
							offsetTop: rect.top - containerRect.top,
							allUuids: fieldEls.map(
								(el) => el.getAttribute("data-field-uuid") ?? "",
							),
						});
						break;
					}
				}
			}

			/* The DOM-nudge restore above (consumed by the layout effect) only
			 * reaches the live canvas, whose every field is in the DOM. The edit
			 * canvas is a virtualized list whose target row isn't mounted yet, so
			 * preview→edit needs the virtualizer to scroll. Hand the freshly-
			 * mounting edit list the field to land on; clear it when entering
			 * preview so the anchor never lingers into a later edit-list mount. */
			setFlipbookScrollAnchor(on ? undefined : topVisibleUuid);

			setPreviewing(on);
		},
		[setPreviewing, setFlipbookScrollAnchor],
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
	const scrollToField = useCallback(
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

			const fieldEl = document.querySelector(
				`[data-field-uuid="${fieldUuid}"]`,
			) as HTMLElement | null;
			const scrollContainer = fieldEl?.closest(
				"[data-preview-scroll-container]",
			) as HTMLElement | null;
			if (!fieldEl || !scrollContainer) return;

			// `overrideTarget` must be within `scrollContainer` (see ScrollCallback) —
			// it's measured against it. Defaults to the field row.
			const el = overrideTarget ?? fieldEl;
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

	useRegisterScrollCallback(scrollToField);

	// ── Keyboard shortcuts ──────────────────────────────────────────────

	const shortcuts = useBuilderShortcuts(handleSetPreviewing);

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
			<div className="h-full flex flex-col overflow-hidden">
				<BuilderHeader
					commcareConfigured={commcareConfigured}
					commcareAvailableDomains={commcareAvailableDomains}
					onSetPreviewing={handleSetPreviewing}
					impersonating={impersonating ?? null}
				/>
				<div className="flex-1 flex items-center justify-center">
					<div className="animate-pulse">
						<Logo size="md" />
					</div>
				</div>
			</div>
		);
	}

	return (
		<BuilderReferenceProvider>
			<div className="h-full flex flex-col overflow-hidden">
				{/* Replay controller — self-sufficient, reads/writes replay state from store */}
				{inReplayMode && <ReplayController />}

				{/* Builder header — logo, centered Preview toggle, doc tools, account.
				 *  Always rendered: it replaces the site AppHeader inside /build. */}
				<BuilderHeader
					commcareConfigured={commcareConfigured}
					commcareAvailableDomains={commcareAvailableDomains}
					onSetPreviewing={handleSetPreviewing}
					impersonating={impersonating ?? null}
				/>

				{/* Content area — self-sufficient, owns sidebar/preview/chat layout */}
				<BuilderContentArea
					isCentered={isCentered}
					isExistingApp={!!isExistingApp}
				>
					{children}
				</BuilderContentArea>
			</div>
		</BuilderReferenceProvider>
	);
}
