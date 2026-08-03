/**
 * How things arrive in and leave the header band.
 *
 * The band itself never moves, so everything inside it has to carry the sense
 * that the surface changed. A cluster that simply appears — the site's nav
 * blinking out and the builder's tools blinking in — reads as a page swap the
 * band failed to notice, and it undoes the one continuous thing on screen.
 *
 * So menus arrive from just above and leave the same way, and exits are
 * quicker than entrances: the room is being handed over, not fought for. One
 * component for every cluster on every surface, because the site's menus and
 * the builder's tools are the two halves of one handoff and must not be tuned
 * apart.
 */

"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Entrances decelerate (the shared entrance ease); exits use a plain
 *  accelerating curve and take about two thirds as long. */
const ENTER = { duration: 0.22, ease: [0.16, 1, 0.3, 1] } as const;
const EXIT = { duration: 0.14, ease: [0.4, 0, 1, 1] } as const;

/**
 * Wraps one header cluster. `delay` staggers an arrival behind the departure
 * it is replacing, so a swap reads as one gesture with two beats rather than
 * a crossfade where both are half-visible.
 *
 * The exit only runs under an `AnimatePresence`, and that is the switch: a
 * cluster that should linger on its way out is wrapped in one, and a cluster
 * that must be GONE the instant its condition turns false simply isn't. The
 * builder's controls are the second kind — they disappear because app access
 * stopped being resolved, and an element mid-fade is still on screen and still
 * takes a click, which is exactly what unmounting them is meant to prevent.
 */
export function HeaderCluster({
	children,
	delay = 0,
	className = "flex min-w-0 items-center gap-1 sm:gap-2",
	...rest
}: {
	children: ReactNode;
	delay?: number;
	className?: string;
	/** Marker attributes the band's own CSS reads. */
	"data-header-site-menus"?: boolean;
}) {
	return (
		<motion.div
			{...rest}
			className={className}
			initial={{ opacity: 0, y: -6 }}
			animate={{ opacity: 1, y: 0, transition: { ...ENTER, delay } }}
			exit={{ opacity: 0, y: -6, transition: EXIT }}
		>
			{children}
		</motion.div>
	);
}

/** The beat an arriving cluster waits out, so the leaving one is gone first. */
export const HEADER_HANDOFF_DELAY = 0.16;
