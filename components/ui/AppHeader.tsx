/**
 * The app header. One band, one geometry, every signed-in surface.
 *
 * There used to be two: a site header and a builder header, 8px apart in
 * height with their marks 4px apart horizontally, so crossing between them
 * made the brand hop. That split was never a design decision, only a
 * consequence of where each was mounted — and the things that actually differ
 * between the surfaces are exactly the things a header is supposed to hold.
 * So the band is fixed here and the contents arrive as slots:
 *
 *   [ mark  start ] [ center ] [ actions  account ]
 *
 * The mark and the account control are the constants. `start` and `actions`
 * are the menus, `center` is whatever the surface puts directly above its
 * work. Nothing else may set the height, the insets, or the brand: those are
 * the whole reason this component exists.
 *
 * The mark is a link home at every width. In the builder it is also the way
 * OUT, which is the job a logo has always had, and why the builder can hand
 * the wordmark back for the room (`markOnly`, and `Logo` for the collapse).
 *
 * 64px because that is one 44px control with real air around it, and because
 * the builder's own second band (breadcrumb, sidebar headers) is already 64px,
 * so the whole of the app's chrome now stands on one rhythm. Short windows
 * take it to 60px, where a 44px control still keeps 8px rather than touching
 * its borders.
 */

"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SimpleTooltip } from "@/components/shadcn/tooltip";
import { Logo } from "@/components/ui/Logo";
import { useIsBreakpoint } from "@/lib/ui/hooks/useIsBreakpoint";

/** The keyframe whose end means the whole handoff is over. The rim outlasts
 *  the swell riding over it, so this is the one to wait on. */
const ABSORB_ANIMATION = "nova-logo-absorb-rim";

export interface AppHeaderProps {
	/** The mark's accessible name, and its hover text. It says what following
	 *  the link DOES, which is not the same sentence on a settings page as it
	 *  is mid-build. */
	homeLabel: string;
	/** Hand the wordmark back and keep the sphere. Flipping this on a mounted
	 *  header plays the handoff: the word is drawn in, then the sphere answers
	 *  with the swell it gives the pointer. */
	markOnly?: boolean;
	/** Right of the mark: the site's nav links. */
	start?: ReactNode;
	/** The impersonation banner, or null. Its own slot rather than part of
	 *  `start`, because it is the one thing that takes a row of its own when
	 *  `stacked` — and a slot that is merely PASSED cannot be distinguished
	 *  from a slot with something standing in it, which is how the band grew a
	 *  17px row of nothing under a header that had no banner. */
	banner?: ReactNode;
	/** Dead centre, whatever the row's flanks weigh: the builder's Preview
	 *  control sits directly above the canvas it flips. */
	center?: ReactNode;
	/** Right, before the account control: the Project switcher and Help on the
	 *  site, the document tools in the builder. */
	actions?: ReactNode;
	/** Far right, and the second of the two constants. It is still a slot
	 *  because the builder unmounts it while app access is unresolved: a
	 *  control whose popup is deliberately quarantined must not be on screen. */
	account?: ReactNode;
	/** Give `actions` (and then the banner) rows of their own under the band,
	 *  for a surface whose tools cannot fit beside everything else at the width
	 *  it is being asked to. Nothing shrinks: the 44px floor is a floor. */
	stacked?: boolean;
}

export function AppHeader({
	homeLabel,
	markOnly = false,
	start,
	banner,
	center,
	actions,
	account,
	stacked = false,
}: AppHeaderProps) {
	/* Under 360px of height every band gives up its outer air first: the
	 * controls inside are already at the floor and cannot. */
	const shortViewport = useIsBreakpoint("max", 360, "height");
	const band = shortViewport ? "60px" : "64px";

	/* The handoff is a consequence of the lockup collapsing, so it is armed by
	 * the change and never by a caller: a surface that renders `markOnly` from
	 * its first frame is not handing anything over, it simply never had the
	 * word. `onAnimationEnd` clears it rather than a timer, so the state and
	 * the animation cannot disagree — including under reduced motion, where the
	 * global near-zero rule ends it almost immediately. */
	const [absorbing, setAbsorbing] = useState(false);
	const wasMarkOnly = useRef(markOnly);
	useEffect(() => {
		const collapsing = markOnly && !wasMarkOnly.current;
		wasMarkOnly.current = markOnly;
		if (collapsing) setAbsorbing(true);
	}, [markOnly]);

	/* The tooltip is UNCONDITIONAL, and that is load-bearing rather than a
	 * preference. `SimpleTooltip` returns its child bare when `content` is
	 * falsy, so a tooltip that comes and goes moves the mark between two
	 * positions in the tree — React rebuilds the `<Link>`, the fresh `Logo`
	 * renders already collapsed, and the handoff loses its wordmark half while
	 * the sphere (owned up here, and not remounted) still swells. It reads as
	 * the word vanishing under a pulse. `homeLabel` is the right text anyway:
	 * it is what the mark IS on this surface, which is exactly what a bare
	 * sphere needs saying. */
	const mark = (
		<Link
			href="/"
			aria-label={homeLabel}
			onAnimationEnd={(event) => {
				if (event.animationName === ABSORB_ANIMATION) setAbsorbing(false);
			}}
			/* No horizontal padding: the 44px mark IS the 44px target, so the
			 * band's own inset is the only thing between it and the edge, and the
			 * mark lands on the same x on every surface. */
			className="nova-focusable inline-flex min-h-11 min-w-11 shrink-0 items-center rounded-xl outline-none"
		>
			<Logo size="chrome" markOnly={markOnly} absorbing={absorbing} />
		</Link>
	);

	return (
		/* `minmax(0, 1fr)` on the flanks, not `1fr`: a bare `1fr` floors at the
		 * column's min-content, so a long impersonation banner or a wide tool
		 * cluster would push the centre off centre instead of compressing. */
		<header
			data-app-header
			data-header-layout={stacked ? "stacked" : "standard"}
			style={{ gridTemplateRows: stacked ? `${band} auto` : band }}
			className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-nova-border bg-nova-void px-2 sm:px-4"
		>
			<div className="col-start-1 row-start-1 flex min-w-0 items-center sm:gap-4">
				<SimpleTooltip content={homeLabel} side="bottom">
					{mark}
				</SimpleTooltip>
				{stacked ? null : banner}
				{start}
			</div>

			<div className="col-start-2 row-start-1 min-w-0 justify-self-center">
				{center}
			</div>

			{/* One element, two placements. `actions` may own a live subscription
			    (the builder's save indicator does), so crossing the stacking width
			    must change where this box SITS and never which box it is. */}
			<div
				data-app-header-tools
				className={
					stacked
						? "col-span-3 row-start-2 -mx-2 flex min-h-12 min-w-0 items-center justify-center gap-1 border-t border-nova-border px-2 sm:-mx-4 sm:px-4"
						: "col-start-3 row-start-1 flex min-w-0 items-center gap-1 justify-self-end sm:gap-2"
				}
			>
				{/* The handing-over cluster and the arriving one share ONE cell,
				    stacked on top of each other. Side by side they would both hold
				    layout width for the length of the swap — an entering cluster is
				    transparent but not weightless — and the visible menus would jump
				    sideways to make room for something nobody can see yet. Overlapped,
				    only the box's own left edge moves, and the account control beyond
				    it never shifts at all. */}
				<div
					className={`grid min-w-0 items-center [&>*]:[grid-area:1/1] ${
						stacked ? "justify-items-center" : "justify-items-end"
					}`}
				>
					{actions}
				</div>
				{stacked ? null : account}
			</div>

			{stacked ? (
				<div className="col-start-3 row-start-1 justify-self-end">
					{account}
				</div>
			) : null}

			{stacked && banner ? (
				<div className="col-span-3 row-start-3 -mx-2 min-w-0 border-t border-nova-border px-2 py-2 sm:-mx-4 sm:px-4">
					{banner}
				</div>
			) : null}
		</header>
	);
}
