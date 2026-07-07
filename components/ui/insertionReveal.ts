// components/ui/insertionReveal.ts
//
// The shared reveal visuals for insertion affordances — the ONE place the
// arming-glow curve and the line/circle animation live, so the form canvas,
// the app tree, and the insertion lab reveal identically (retuning is a
// one-file change). The intent model behind the `progress` / `open` inputs
// is lib/ui/insertionIntent.ts.
//
// The open transition is deliberately slow-attack: a 50ms delay + 200ms ease
// (the original slide-open timing) acts as a visual low-pass filter — a
// sub-100ms transient the model lets slip (an aim that lands just past a
// gap, a swipe endpoint) barely registers before the quick collapse takes
// it back, while a committed open blooms in confidently.

import type { CSSProperties } from "react";

/** Arming evidence below this shows nothing — a casual crossing must not
 *  flash every gap it grazes. */
const GLOW_DEAD_BAND = 0.5;

/** The glow's ceiling while still arming; the commit to `open` jumps to 1. */
const GLOW_MAX = 0.5;

/** The expand curve the original height-based reveal used. */
const OPEN_EASE = "cubic-bezier(0.6, 0, 0.1, 1)";

/** Line opacity for the current intent state: full on open, a rising glow
 *  while evidence accumulates, dark otherwise. */
export function insertionGlowOpacity(progress: number, open: boolean): number {
	if (open) return 1;
	return (
		Math.max(0, (progress - GLOW_DEAD_BAND) / (1 - GLOW_DEAD_BAND)) * GLOW_MAX
	);
}

/** The reveal transition: delayed, easeful bloom on open; quick, undelayed
 *  collapse (and smooth glow steps) otherwise. `extra` appends properties a
 *  call site also animates (e.g. the trigger's hover background). */
export function insertionRevealTransition(
	open: boolean,
	extra?: string,
): string {
	const base = open
		? `opacity 200ms ${OPEN_EASE} 50ms, transform 200ms ${OPEN_EASE} 50ms`
		: "opacity 90ms ease-in, transform 90ms ease-in";
	return extra ? `${base}, ${extra}` : base;
}

/** The container's slide-open: the gap physically expands and pushes the
 *  neighboring rows apart, on the same delayed bloom the line/circle use.
 *  The intent binding re-measures zone rects through this animation (a
 *  reveal is a layout change nothing else observes) — see
 *  lib/ui/hooks/useInsertionZone.tsx. */
export function insertionExpandStyle(
	open: boolean,
	restPx: number,
	openPx: number,
): CSSProperties {
	return {
		height: open ? openPx : restPx,
		transition: open ? `height 200ms ${OPEN_EASE} 50ms` : "height 90ms ease-in",
	};
}

/** Class for each violet flanking line; pass the side the line GROWS from
 *  (its transform origin faces the center "+"). Full literals — Tailwind's
 *  scanner can't see interpolated class names. */
export function insertionLineCls(origin: "left" | "right"): string {
	return origin === "right"
		? "h-px flex-1 bg-nova-violet/40 origin-right"
		: "h-px flex-1 bg-nova-violet/40 origin-left";
}

/** Inline style for a flanking line — glow opacity, the expand-in scale, and
 *  the shared reveal transition. */
export function insertionLineStyle(
	progress: number,
	open: boolean,
): CSSProperties {
	return {
		opacity: insertionGlowOpacity(progress, open),
		transform: open ? "scaleX(1)" : "scaleX(0.7)",
		transition: insertionRevealTransition(open),
	};
}

/** The centered "+" circle chrome (border, fill, color) — layout (size,
 *  margin, pointer-events) stays with the call site. */
export const INSERTION_CIRCLE_CLS =
	"flex items-center justify-center rounded-full border border-nova-violet/40 bg-nova-surface text-nova-violet-bright";

/** Inline style for the circle — pops in with the same delayed bloom the
 *  lines use. `extraTransition` lets the form trigger keep its hover tint. */
export function insertionCircleStyle(
	open: boolean,
	extraTransition?: string,
): CSSProperties {
	return {
		opacity: open ? 1 : 0,
		transform: open ? "scale(1)" : "scale(0.25)",
		transition: insertionRevealTransition(open, extraTransition),
	};
}
