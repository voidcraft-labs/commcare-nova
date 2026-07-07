// components/ui/insertionReveal.ts
//
// The shared reveal visuals for insertion affordances — the ONE place the
// arming-glow curve and the line/circle animation classes live, so the form
// canvas, the app tree, and the insertion lab reveal identically (retuning
// the glow is a one-file change). The intent model behind the `progress` /
// `open` inputs is lib/ui/insertionIntent.ts.

import type { CSSProperties } from "react";

/** Arming evidence below this shows nothing — a casual crossing must not
 *  flash every gap it grazes. */
const GLOW_DEAD_BAND = 0.25;

/** The glow's ceiling while still arming; the commit to `open` jumps to 1. */
const GLOW_MAX = 0.5;

/** Line opacity for the current intent state: full on open, a rising glow
 *  while evidence accumulates, dark otherwise. */
export function insertionGlowOpacity(progress: number, open: boolean): number {
	if (open) return 1;
	return (
		Math.max(0, (progress - GLOW_DEAD_BAND) / (1 - GLOW_DEAD_BAND)) * GLOW_MAX
	);
}

/** Class for each violet flanking line; pass the side the line GROWS from
 *  (its transform origin faces the center "+"). Full literals — Tailwind's
 *  scanner can't see interpolated class names. */
export function insertionLineCls(origin: "left" | "right"): string {
	return origin === "right"
		? "h-px flex-1 bg-nova-violet/40 origin-right transition-[opacity,transform] duration-100"
		: "h-px flex-1 bg-nova-violet/40 origin-left transition-[opacity,transform] duration-100";
}

/** Inline style for a flanking line — glow opacity + the settle-in scale. */
export function insertionLineStyle(
	progress: number,
	open: boolean,
): CSSProperties {
	return {
		opacity: insertionGlowOpacity(progress, open),
		transform: open ? "scaleX(1)" : "scaleX(0.92)",
	};
}

/** The centered "+" circle chrome (border, fill, color) — layout (size,
 *  margin, pointer-events) stays with the call site. */
export const INSERTION_CIRCLE_CLS =
	"flex items-center justify-center rounded-full border border-nova-violet/40 bg-nova-surface text-nova-violet-bright transition-[opacity,transform] duration-150";

/** The circle's pop-in/out state classes. */
export function insertionCircleStateCls(open: boolean): string {
	return open ? "opacity-100 scale-100" : "opacity-0 scale-50";
}
