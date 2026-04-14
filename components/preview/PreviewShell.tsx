/**
 * PreviewShell — renders the correct screen (home, module, case list, form)
 * based on the URL-driven location.
 *
 * ## Architecture
 *
 * Uses React 19's `<Activity>` component for screen retention: previously
 * visited screens stay mounted but hidden (`display: none`, effects cleaned
 * up, state preserved). Return visits are instant — Activity reveals the
 * preserved DOM and re-creates effects without remounting 800+ components.
 *
 * `useDeferredValue` wraps the derived PreviewScreen so first-visit
 * mounts are concurrent. When the URL changes, React schedules a deferred
 * re-render at lower priority for the Activity mode flip — the old screen
 * stays visible while the new screen prepares in the background. Return
 * visits (Activity reveal of an already-mounted tree) are near-instant.
 *
 * ## Location→PreviewScreen adapter
 *
 * The interact-mode preview pipeline (case data flow, form engine) still
 * uses `PreviewScreen` with integer indices. Rather than push uuid-or-index
 * knowledge into the preview engine, we translate `Location` → `PreviewScreen`
 * at this boundary. The adapter reads `moduleOrder` / `formOrder` from the
 * doc store and resolves uuid → index.
 *
 * ## Screen identity ownership
 *
 * PreviewShell owns the "last screen of each type" state via refs. Each
 * screen component receives its coordinates (moduleIndex / formIndex /
 * caseId) as props rather than reading the global screen.
 *
 * This matches Activity's semantics: when Activity hides FormScreen, the
 * current screen has moved on (e.g., to "module"), but FormScreen's own
 * identity hasn't changed — it's still form X in module Y. Passing that
 * identity as a prop keeps FormScreen's component tree rendering correctly
 * while hidden.
 */
"use client";
import { Activity, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { type PreviewScreen, screenKey } from "@/lib/preview/engine/types";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import type { Location } from "@/lib/routing/types";
import { useEditMode } from "@/lib/session/hooks";
import { PreviewHeader } from "./PreviewHeader";
import { CaseListScreen } from "./screens/CaseListScreen";
import { FormScreen } from "./screens/FormScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ModuleScreen } from "./screens/ModuleScreen";

interface PreviewShellProps {
	actions?: React.ReactNode;
	hideHeader?: boolean;
	/** Pixels of top padding inside the scroll container — used by BuilderLayout
	 *  to offset content below the absolutely-positioned glassmorphic toolbar so
	 *  the first screen element isn't hidden behind the overlay on initial load. */
	topInset?: number;
	/** Back handler override — used by BuilderLayout to sync selection on back navigation.
	 *  Also used by FormScreen for post-submit navigation. */
	onBack?: () => void;
}

/**
 * Translate a URL-derived `Location` into the legacy `PreviewScreen` shape
 * (integer indices) that the interact-mode preview pipeline expects. Falls
 * back to `{ type: "home" }` when a uuid can't be resolved — the stale
 * param will be scrubbed by LocationRecoveryEffect on the next tick.
 */
function locationToScreen(
	loc: Location,
	moduleOrder: Uuid[],
	formOrder: Record<Uuid, Uuid[]>,
): PreviewScreen {
	if (loc.kind === "home") return { type: "home" };

	const moduleIndex = moduleOrder.indexOf(loc.moduleUuid);
	if (moduleIndex < 0) return { type: "home" };

	if (loc.kind === "module") return { type: "module", moduleIndex };

	if (loc.kind === "cases") {
		return { type: "caseList", moduleIndex, formIndex: 0 };
	}

	/* Form screen — resolve formUuid to index within the module's form list. */
	const formIds = formOrder[loc.moduleUuid] ?? [];
	const formIndex = formIds.indexOf(loc.formUuid);
	if (formIndex < 0) return { type: "module", moduleIndex };
	return { type: "form", moduleIndex, formIndex };
}

export function PreviewShell({
	actions,
	hideHeader,
	topInset = 0,
	onBack,
}: PreviewShellProps) {
	/* ── Location → PreviewScreen adapter ─────────────────────────────
	 * Read the URL location and translate to the legacy index-based screen
	 * shape so the Activity boundaries and interact-mode pipeline keep working. */
	const loc = useLocation();
	const navigate = useNavigate();
	const moduleOrder = useBlueprintDoc((s) => s.moduleOrder);
	const formOrder = useBlueprintDoc((s) => s.formOrder);

	/* Default back handler — callers can override (e.g. for selection sync),
	 * otherwise fall back to URL-driven `navigate.back()`. */
	const handleBack = onBack ?? (() => navigate.back());

	const zustandScreen: PreviewScreen = useMemo(
		() => locationToScreen(loc, moduleOrder, formOrder),
		[loc, moduleOrder, formOrder],
	);

	/* ── Concurrent screen transition ──────────────────────────────────
	 * `zustandScreen` updates immediately on URL change. `screen` is the
	 * deferred value — React schedules the Activity mode flip at lower
	 * priority, keeping the old screen visible while the new screen mounts
	 * in the background. Return visits are near-instant. */
	const screen = useDeferredValue(zustandScreen);

	const mode = useEditMode();

	/* ── Per-type screen identity ──────────────────────────────────────
	 * Track the last screen data for each type so Activity boundaries can
	 * be mounted before the screen has ever been visited, and screen
	 * components can receive their coordinates as props rather than
	 * reading the (possibly-changed) global screen from the store.
	 *
	 * Ref mutation during render is safe here: writes are idempotent per
	 * render (the same zustandScreen produces the same ref contents), and
	 * React's concurrent mode tolerates this pattern for externally-sourced
	 * state. Uses `zustandScreen` (the immediate value), not `screen` (the
	 * deferred value), so boundaries are created eagerly on navigation —
	 * the deferred value then controls when they become visible. */
	const moduleScreenRef =
		useRef<Extract<PreviewScreen, { type: "module" }>>(undefined);
	const caseListScreenRef =
		useRef<Extract<PreviewScreen, { type: "caseList" }>>(undefined);
	const formScreenRef =
		useRef<Extract<PreviewScreen, { type: "form" }>>(undefined);
	/** Whether the home screen has been visited at least once. Home carries
	 *  no per-screen identity, so a boolean flag suffices. */
	const homeVisitedRef = useRef(false);

	switch (zustandScreen.type) {
		case "home":
			homeVisitedRef.current = true;
			break;
		case "module":
			moduleScreenRef.current = zustandScreen;
			break;
		case "caseList":
			caseListScreenRef.current = zustandScreen;
			break;
		case "form":
			formScreenRef.current = zustandScreen;
			break;
	}

	/* ── Per-screen scroll position save/restore ───────────────────────
	 * All Activity-wrapped screens share a single scroll container. Save
	 * the scroll position when leaving a screen and restore it on return
	 * so navigating back to a scrolled form doesn't land at the top.
	 *
	 * Keyed by `screenKey()` (encodes type + indices) rather than just
	 * `screen.type` — otherwise navigating Form A → Module → Form B would
	 * incorrectly restore Form A's scroll position for Form B. */
	const scrollPositions = useRef(new Map<string, number>());
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const prevScreenKeyRef = useRef(screenKey(screen));

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const currentKey = screenKey(screen);
		if (prevScreenKeyRef.current !== currentKey) {
			/* Save position of the screen we're leaving */
			scrollPositions.current.set(
				prevScreenKeyRef.current,
				container.scrollTop,
			);
			/* Restore position of the screen we're entering */
			container.scrollTop = scrollPositions.current.get(currentKey) ?? 0;
			prevScreenKeyRef.current = currentKey;
		}
	}, [screen]);

	return (
		<div
			className={`preview-theme ${mode === "edit" ? "design-theme" : ""} h-full flex flex-col`}
		>
			{!hideHeader && <PreviewHeader actions={actions} />}

			<div
				ref={scrollContainerRef}
				data-preview-scroll-container
				className="flex-1 overflow-y-auto overflow-x-hidden bg-pv-bg [overflow-anchor:none]"
				style={topInset ? { paddingTop: topInset } : undefined}
			>
				{/* Each screen is wrapped in an Activity boundary that preserves
				 *  the component tree when hidden. Boundaries are only rendered
				 *  for screen types that have been visited (the ref is populated).
				 *  Activity `mode` uses the deferred `screen` value so the old
				 *  screen stays visible while the new screen mounts concurrently.
				 *  Screen components receive their identity as props — they never
				 *  read the global current screen, so Activity can hide them
				 *  without destroying their subtree. */}
				{homeVisitedRef.current && (
					<Activity
						mode={screen.type === "home" ? "visible" : "hidden"}
						name="HomeScreen"
					>
						<HomeScreen />
					</Activity>
				)}
				{moduleScreenRef.current && (
					<Activity
						mode={screen.type === "module" ? "visible" : "hidden"}
						name="ModuleScreen"
					>
						<ModuleScreen screen={moduleScreenRef.current} />
					</Activity>
				)}
				{caseListScreenRef.current && (
					<Activity
						mode={screen.type === "caseList" ? "visible" : "hidden"}
						name="CaseListScreen"
					>
						<CaseListScreen screen={caseListScreenRef.current} />
					</Activity>
				)}
				{formScreenRef.current && (
					<Activity
						mode={screen.type === "form" ? "visible" : "hidden"}
						name="FormScreen"
					>
						<FormScreen screen={formScreenRef.current} onBack={handleBack} />
					</Activity>
				)}
			</div>
		</div>
	);
}
