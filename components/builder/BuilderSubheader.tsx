/**
 * BuilderSubheader — navigation, breadcrumbs, undo/redo, save, and export
 * controls. Fully self-sufficient — subscribes to store state and calls
 * engine methods directly. No callback props from BuilderLayout needed
 * for any interactive behavior.
 *
 * Owns all subheader-related Zustand subscriptions: canGoBack, canGoUp,
 * canUndo, canRedo, breadcrumbs, hasData, isReady. These subscriptions
 * trigger re-renders ONLY in this component, not in BuilderLayout.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AppConnectSettings } from "@/components/builder/detail/AppConnectSettings";
import { ExportPanel } from "@/components/builder/ExportPanel";
import { SaveIndicator } from "@/components/builder/SaveIndicator";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { Tooltip } from "@/components/ui/Tooltip";
import {
	useBreadcrumbs,
	useBuilderEngine,
	useBuilderHasData,
	useBuilderIsReady,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { shortcutLabel } from "@/lib/platform";
import {
	selectAppName,
	selectCanGoBack,
	selectCanGoUp,
} from "@/lib/services/builderSelectors";

/* Module-scope selectors for the temporal store. Hoisted so useStore doesn't
 * re-subscribe on every render (inline functions create new references). */
function selectCanUndo(s: { pastStates: unknown[] }): boolean {
	return s.pastStates.length > 0;
}
function selectCanRedo(s: { futureStates: unknown[] }): boolean {
	return s.futureStates.length > 0;
}

/** Stable no-op handler for breadcrumb items that don't navigate. */
const noop = () => {};

interface BuilderSubheaderProps {
	/** Whether CommCare HQ credentials are configured. */
	commcareConfigured: boolean;
	/** The user's authorized project space domain, or null if not configured. */
	commcareDomain: { name: string; displayName: string } | null;
}

export function BuilderSubheader({
	commcareConfigured,
	commcareDomain,
}: BuilderSubheaderProps) {
	const builder = useBuilderEngine();
	const hasData = useBuilderHasData();
	const isReady = useBuilderIsReady();

	/* Navigation state — own subscriptions. These trigger re-renders only
	 * in this component, never cascading to BuilderLayout or its children. */
	const canGoBack = useBuilderStore(selectCanGoBack);
	const canGoUp = useBuilderStore(selectCanGoUp);

	/* Undo/redo availability — subscriptions to the temporal store.
	 * Uses `useStoreWithEqualityFn` (zundo's recommended API) instead of
	 * plain `useStore`. Plain `useStore` re-renders on every temporal state
	 * change regardless of selector result. `useStoreWithEqualityFn` with
	 * `Object.is` correctly compares the boolean output and skips re-renders
	 * when canUndo stays true→true (which is every mutation after the first). */
	const canUndo = useStoreWithEqualityFn(
		builder.store.temporal,
		selectCanUndo,
		Object.is,
	);
	const canRedo = useStoreWithEqualityFn(
		builder.store.temporal,
		selectCanRedo,
		Object.is,
	);

	/* Breadcrumbs derived from screen + entity names. Uses structural
	 * equality internally so unrelated mutations don't trigger re-renders. */
	const breadcrumbs = useBreadcrumbs();
	const appName = useBuilderStore(selectAppName);

	/* Breadcrumb click handlers — memoized on navigation structure so they're
	 * stable across unrelated renders. This lets CollapsibleBreadcrumb's
	 * memo() skip re-renders when nothing changed. */
	const breadcrumbHandlers = useMemo(
		() =>
			breadcrumbs.map((item) => () => builder.navigateToScreen(item.screen)),
		[breadcrumbs, builder],
	);

	/* Assemble breadcrumb parts — memoized so CollapsibleBreadcrumb's memo
	 * boundary actually works. Without useMemo, every render creates a new
	 * array reference, defeating the child's memo check. */
	const breadcrumbParts: BreadcrumbPart[] = useMemo(() => {
		if (!hasData) {
			return appName ? [{ key: "home", label: appName, onClick: noop }] : [];
		}
		return breadcrumbs.map((item, i) => ({
			key: item.key,
			label: item.label,
			onClick: breadcrumbHandlers[i] ?? noop,
		}));
	}, [hasData, appName, breadcrumbs, breadcrumbHandlers]);

	const showToolbar = isReady && hasData;

	return (
		<>
			<div className="flex items-center gap-2 min-w-0">
				{hasData && (
					<ScreenNavButtons
						canGoBack={canGoBack}
						canGoUp={canGoUp}
						onBack={() => builder.navBackWithSync()}
						onUp={() => builder.navUpWithSync()}
					/>
				)}
				<CollapsibleBreadcrumb parts={breadcrumbParts} />
			</div>
			{showToolbar && (
				<div className="flex items-center gap-1 shrink-0">
					<SaveIndicator />
					<AppConnectSettings builder={builder} />
					<Tooltip content={`Undo (${shortcutLabel("mod", "Z")})`}>
						<button
							type="button"
							onClick={() => builder.undo()}
							disabled={!canUndo}
							className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
							aria-label="Undo"
						>
							<Icon icon={tablerArrowBackUp} width="18" height="18" />
						</button>
					</Tooltip>
					<Tooltip content={`Redo (${shortcutLabel("mod", "shift", "Z")})`}>
						<button
							type="button"
							onClick={() => builder.redo()}
							disabled={!canRedo}
							className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-nova-text-muted transition-colors cursor-pointer enabled:hover:text-nova-text enabled:hover:bg-white/5 disabled:opacity-[0.38] disabled:cursor-default"
							aria-label="Redo"
						>
							<Icon icon={tablerArrowForwardUp} width="18" height="18" />
						</button>
					</Tooltip>
					<ExportPanel
						commcareConfigured={commcareConfigured}
						commcareDomain={commcareDomain}
					/>
				</div>
			)}
		</>
	);
}
