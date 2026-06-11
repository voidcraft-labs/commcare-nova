/**
 * BreadcrumbStrip — back/up navigation + the breadcrumb trail, docked
 * at the top of the canvas column (between the sidebars, not in the
 * full-width header). The sidebars bound its width, so a long trail
 * collapses through `CollapsibleBreadcrumb` instead of growing toward
 * the header's centered Preview toggle — wayfinding and the mode
 * toggle can never collide.
 *
 * Self-sufficient: navigation state from `useLocation` / `useNavigate`
 * / `useBreadcrumbs` (URL-driven), names from the doc store.
 *
 * The row adopts the same centered container as the screen below it,
 * so the trail's left edge tracks the content's left edge in BOTH
 * modes — and because `mx-auto` re-centers continuously while the
 * sidebar widths animate, toggling preview never snaps the crumbs to
 * the window edge and back.
 */
"use client";
import { useMemo } from "react";
import type { BreadcrumbPart } from "@/components/builder/SubheaderToolbar";
import { CollapsibleBreadcrumb } from "@/components/builder/SubheaderToolbar";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";
import { useAppName } from "@/lib/doc/hooks/useAppName";
import { useDocHasData } from "@/lib/doc/hooks/useDocHasData";
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";

/** Stable no-op handler for breadcrumb items that don't navigate. */
const noop = () => {};

export function BreadcrumbStrip() {
	const hasData = useDocHasData();

	const loc = useLocation();
	const navigate = useNavigate();
	const canGoBack = loc.kind !== "home";
	const canGoUp = loc.kind !== "home";

	/* Match the screen's own centered container so the strip's left
	 * edge tracks the content's left edge: the case-list surfaces
	 * render at `max-w-5xl px-8`; home / module / form screens at
	 * `max-w-3xl` with 24px side padding. */
	const onCaseSurface =
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config";
	const rowClass = onCaseSurface
		? "mx-auto w-full max-w-5xl px-8"
		: "mx-auto w-full max-w-3xl px-6";

	/* Breadcrumbs derived from URL + doc entity names. */
	const breadcrumbs = useBreadcrumbs();
	const appName = useAppName();

	/* Breadcrumb click handlers — navigate to each breadcrumb's location.
	 * Memoized on navigation structure so CollapsibleBreadcrumb's memo()
	 * skips re-renders when nothing changed. */
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

	return (
		<div className="shrink-0 h-12 border-b border-nova-border bg-pv-bg">
			<div className={`flex items-center gap-2 min-w-0 h-full ${rowClass}`}>
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
		</div>
	);
}
