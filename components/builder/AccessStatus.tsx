/** Access-state surfaces shared by builder chrome and the content boundary. */

"use client";

import { type ReactNode, useLayoutEffect } from "react";
import { Button } from "@/components/shadcn/button";
import {
	type AccessPhase,
	useAccessPhase,
	useCanEdit,
	useHasWaitingAccessChanges,
} from "@/lib/session/hooks";

const ACCESS_COPY: Record<
	Exclude<AccessPhase, "authorized">,
	{ label: string; heading: string; detail: string }
> = {
	refreshing: {
		label: "Refreshing app…",
		heading: "Refreshing app",
		detail:
			"Nova is loading the latest app and Project access. Editing is paused, and changes waiting to save are still kept in this tab.",
	},
	reconnecting: {
		label: "Reconnecting…",
		heading: "Reconnecting",
		detail:
			"Nova couldn’t refresh access yet. It will keep trying, and changes waiting to save remain in this tab.",
	},
	upgradeRequired: {
		label: "Refresh needed",
		heading: "Nova needs to refresh",
		detail:
			"A newer version is required to keep this app in sync. Refresh when you’re ready to continue.",
	},
	revoked: {
		label: "App unavailable",
		heading: "This app is no longer available",
		detail:
			"It may have been deleted, moved out of a Project you can view, or your access may have changed. Ask a Project admin if you still need this app.",
	},
};

/** Compact, non-modal status for the header. The live region stays mounted
 *  even for editors (when no visible chip is needed), so capability changes
 *  are announced politely without moving focus. */
export function BuilderAccessStatus({
	compact = false,
}: {
	compact?: boolean;
}) {
	const phase = useAccessPhase();
	const canEdit = useCanEdit();
	const hasWaitingChanges = useHasWaitingAccessChanges();
	const visibleLabel =
		phase === "authorized"
			? canEdit
				? null
				: hasWaitingChanges
					? "View only · Changes kept"
					: "View only"
			: ACCESS_COPY[phase].label;
	const announcement =
		phase === "authorized"
			? canEdit
				? "Edit access available."
				: hasWaitingChanges
					? "View-only access. Your changes are kept in this tab and will wait for edit access."
					: "View-only access. You can explore and preview this app, but cannot edit it."
			: `${ACCESS_COPY[phase].heading}. ${ACCESS_COPY[phase].detail}`;

	return (
		<>
			<span className="sr-only" role="status" aria-live="polite" aria-atomic>
				{announcement}
			</span>
			{visibleLabel ? (
				<span
					aria-hidden
					className={`inline-flex min-h-7 items-center rounded-lg border border-nova-border bg-nova-surface px-2.5 text-xs font-medium text-nova-text-muted ${
						compact ? "mx-1" : "ml-3 mr-1"
					}`}
				>
					{visibleLabel}
				</span>
			) : null}
		</>
	);
}

/** Content mask for an unresolved or terminal access boundary. It is a normal
 *  page state (not a dialog): focus already inside the retained page is not
 *  moved, while a focused floating layer is closed and quarantined because it
 *  lives outside this tree. Routine transitions are communicated through the
 *  polite status region above. */
export function BuilderAccessBoundary() {
	const phase = useAccessPhase();
	if (phase === "authorized") return null;
	const copy = ACCESS_COPY[phase];

	return (
		<main
			className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-5 py-10"
			aria-labelledby="builder-access-heading"
		>
			<div className="w-full max-w-lg rounded-2xl border border-nova-border bg-nova-surface p-6 text-center shadow-lg sm:p-8">
				<p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-nova-text-muted">
					Project access
				</p>
				<h1
					id="builder-access-heading"
					className="text-balance text-xl font-semibold text-nova-text sm:text-2xl"
				>
					{copy.heading}
				</h1>
				<p className="mx-auto mt-3 max-w-md text-pretty text-sm leading-6 text-nova-text-secondary">
					{copy.detail}
				</p>
				{phase === "upgradeRequired" ? (
					<Button
						type="button"
						size="xl"
						className="mt-6"
						onClick={() => window.location.reload()}
					>
						Refresh Nova
					</Button>
				) : null}
				{phase === "revoked" ? (
					<Button
						type="button"
						size="xl"
						variant="outline"
						className="mt-6"
						onClick={() => window.location.assign("/")}
					>
						Back to apps
					</Button>
				) : null}
			</div>
		</main>
	);
}

/** Keep the live builder tree mounted through reversible refreshes so chat,
 *  drafts, cooldowns, and panels retain their local state. `inert` removes the
 *  covered tree from focus, pointer interaction, and the accessibility tree.
 *  Terminal states unmount it so an old document can never be revealed behind
 *  the boundary.
 *
 * Base UI portals mount as siblings under `body`, outside that inert subtree.
 * At every access boundary we therefore close ordinary floating roots with an
 * Escape event and permanently quarantine every body sibling from that source
 * generation. Owners of Project data also clear their controlled state. A
 * floating root that ignored Escape stays hidden+inert instead of reappearing
 * when authorization resumes; reopening later creates a fresh destination-
 * generation portal. */
export function BuilderAccessGate({ children }: { children: ReactNode }) {
	const phase = useAccessPhase();
	useLayoutEffect(() => {
		if (phase === "authorized" || typeof document === "undefined") return;
		const body = document.body;
		const appShell = body.querySelector<HTMLElement>("[data-nova-app-shell]");
		const ignoredTags = new Set([
			"SCRIPT",
			"STYLE",
			"LINK",
			"NEXT-ROUTE-ANNOUNCER",
			"NEXTJS-PORTAL",
		]);
		const quarantine = (element: Element) => {
			if (!(element instanceof HTMLElement)) return;
			if (ignoredTags.has(element.tagName)) return;
			if (
				appShell !== null &&
				(element === appShell || element.contains(appShell))
			)
				return;
			if (element.hasAttribute("data-nova-access-quarantined")) return;
			const focused = document.activeElement;
			if (focused instanceof HTMLElement && element.contains(focused)) {
				focused.blur();
			}
			element.setAttribute("data-nova-access-quarantined", "");
			/* `hidden` is useful to the accessibility tree, while the important
			 * display rule makes quarantine generation-permanent even if a retained
			 * controlled portal later removes `hidden` while trying to reopen. The
			 * matching global CSS keeps the marker authoritative if a floating-layer
			 * library rewrites the element's ordinary inline styles. */
			element.style.setProperty("display", "none", "important");
			element.inert = true;
			element.hidden = true;
		};

		/* Give controlled Base UI roots their normal close path first. Project-
		 * data owners additionally reset from scopeEpoch, so a pending operation
		 * that deliberately refuses Escape still cannot retain its payload. */
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Escape",
				code: "Escape",
				bubbles: true,
				cancelable: true,
			}),
		);
		for (const child of body.children) quarantine(child);
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const added of record.addedNodes) {
					if (added instanceof Element && added.parentElement === body) {
						quarantine(added);
					}
				}
			}
		});
		observer.observe(body, { childList: true });
		return () => observer.disconnect();
	}, [phase]);
	const paused = phase === "refreshing" || phase === "reconnecting";
	if (phase === "revoked" || phase === "upgradeRequired") {
		return <BuilderAccessBoundary />;
	}

	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
			<div
				className="flex min-h-0 min-w-0 flex-1"
				inert={paused ? true : undefined}
			>
				{children}
			</div>
			{paused ? (
				<div className="absolute inset-0 z-raised flex bg-nova-void">
					<BuilderAccessBoundary />
				</div>
			) : null}
		</div>
	);
}
