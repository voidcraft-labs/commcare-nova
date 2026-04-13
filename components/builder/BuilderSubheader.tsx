/**
 * BuilderSubheader — navigation, breadcrumbs, undo/redo, save, and export
 * controls. Fully self-sufficient — subscribes to URL-driven location hooks
 * and doc-backed undo/redo. No callback props from BuilderLayout needed
 * for any interactive behavior.
 *
 * Navigation state comes from `useLocation` / `useNavigate` / `useBreadcrumbs`
 * (Phase 2 URL hooks). Undo/redo from `useUndoRedo` (doc temporal).
 * Engine is retained only for `AppConnectSettings`.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerArrowForwardUp from "@iconify-icons/tabler/arrow-forward-up";
import { useMemo } from "react";
import { AppConnectSettings } from "@/components/builder/detail/AppConnectSettings";
import { ExportPanel } from "@/components/builder/ExportPanel";
import { SaveIndicator } from "@/components/builder/SaveIndicator";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { Tooltip } from "@/components/ui/Tooltip";
import {
	useBuilderEngine,
	useBuilderHasData,
	useBuilderIsReady,
} from "@/hooks/useBuilder";
import {
	useBlueprintDoc,
	useBlueprintDocTemporal,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { shortcutLabel } from "@/lib/platform";
import { useUndoRedo } from "@/lib/routing/builderActions";
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";

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
	/* Engine retained for AppConnectSettings (imperative connect stash). */
	const builder = useBuilderEngine();
	const hasData = useBuilderHasData();
	const isReady = useBuilderIsReady();

	/* Navigation state from URL — replaces legacy store selectors. */
	const loc = useLocation();
	const navigate = useNavigate();
	const canGoBack = loc.kind !== "home";
	const canGoUp = loc.kind !== "home";

	/* Undo/redo from doc temporal — replaces engine.undo/redo. */
	const { undo, redo } = useUndoRedo();

	/* Undo/redo availability — subscribe to the doc store's temporal state.
	 * `useBlueprintDocTemporal` uses `useStoreWithEqualityFn` internally to
	 * compare the boolean output and skip re-renders when canUndo stays
	 * true→true (which is every mutation after the first). */
	const canUndo = useBlueprintDocTemporal(
		(t) => t.pastStates.length > 0,
		Object.is,
	);
	const canRedo = useBlueprintDocTemporal(
		(t) => t.futureStates.length > 0,
		Object.is,
	);

	/* Breadcrumbs derived from URL + doc entity names. */
	const breadcrumbs = useBreadcrumbs();
	const appName = useBlueprintDoc((s) => s.appName);

	/* Breadcrumb click handlers — navigate to each breadcrumb's location.
	 * Memoized on navigation structure so CollapsibleBreadcrumb's memo()
	 * skip re-renders when nothing changed. */
	const breadcrumbHandlers = useMemo(
		() => breadcrumbs.map((item) => () => navigate.push(item.location)),
		[breadcrumbs, navigate],
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
						onBack={() => navigate.back()}
						onUp={() => navigate.up()}
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
							onClick={undo}
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
							onClick={redo}
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
