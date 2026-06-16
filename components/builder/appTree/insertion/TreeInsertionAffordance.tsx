// components/builder/appTree/insertion/TreeInsertionAffordance.tsx
//
// The hover-reveal "+" affordance between app-tree rows — the tree analog of
// the form canvas's `InsertionPoint`, and now sharing its EXACT reveal gating
// (`lib/ui/hooks/useInsertionHover`): the strip opens only once the cursor
// SLOWS over it, so sweeping past a gap never pops it open. The Base UI
// Menu/Popover TRIGGER itself is the affordance — a full-width, click-anywhere
// strip that expands (and fades its "+" in) while `revealed`, so the circle
// gets room and never overlaps the rows above/below. The host composes three
// pieces:
//   - useTreeInsertionHover(open) — the gated `revealed` state + the handlers
//     to spread onto the trigger; reads the surface-wide cursor speed from
//     context (AppTree mounts the tracker via CursorSpeedProvider).
//   - insertionTriggerCls(revealed) — the trigger's className.
//   - TreeInsertionLine — the violet lines + "+" circle rendered inside it.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import {
	useCursorSpeedContext,
	useInsertionHover,
} from "@/lib/ui/hooks/useInsertionHover";

interface TreeInsertionHover {
	/** Whether the strip is expanded + the "+" shown. */
	readonly revealed: boolean;
	/** Attach to the Base UI `Menu.Trigger` / `Popover.Trigger`. */
	readonly ref: RefObject<HTMLButtonElement | null>;
	/** Spread onto the same trigger. */
	readonly hoverProps: {
		readonly onMouseEnter: () => void;
		readonly onMouseMove: () => void;
		readonly onMouseLeave: () => void;
	};
}

/**
 * Cursor-speed-gated reveal for a tree insertion affordance, sharing the form
 * canvas's `useInsertionHover`. `open` is the host popup's open state: the strip
 * stays revealed while open and collapses when it closes — the tree equivalent
 * of the form InsertionPoint's subscribeClose reset.
 */
export function useTreeInsertionHover(open: boolean): TreeInsertionHover {
	const { cursorSpeedRef, lastCursorRef } = useCursorSpeedContext();
	// Latest open in a ref so the leave handler reads it without re-subscribing.
	const openRef = useRef(open);
	openRef.current = open;

	const hover = useInsertionHover<HTMLButtonElement>({
		cursorSpeedRef,
		lastCursorRef,
		keepOpen: () => openRef.current,
	});

	// Collapse when the popup closes (matches the form's subscribeClose reset).
	const { reset } = hover;
	useEffect(() => {
		if (!open) reset();
	}, [open, reset]);

	return {
		revealed: hover.revealed || open,
		ref: hover.containerRef,
		hoverProps: {
			onMouseEnter: hover.onMouseEnter,
			onMouseMove: hover.onMouseMove,
			onMouseLeave: hover.onMouseLeave,
		},
	};
}

/** The insertion trigger's static className: a full-width, pointer-cursor strip
 *  so the WHOLE line is clickable, not just the "+". Height + its animation come
 *  from `insertionTriggerStyle` (an inline transition, not a class). */
export const INSERTION_TRIGGER_CLS =
	"relative block w-full cursor-pointer outline-none";

/**
 * The trigger's animated height: grows from a thin idle gap (14px) to 32px while
 * `revealed`, giving the 20px "+" circle clearance so it doesn't cut into
 * adjacent rows. Uses the SAME inline transition as the form canvas's
 * InsertionPoint — eased-and-delayed on expand, quick on collapse — so the two
 * surfaces animate identically (a Tailwind class swap chops instead of glides).
 */
export function insertionTriggerStyle(revealed: boolean): CSSProperties {
	return {
		height: revealed ? 32 : 14,
		transition: revealed
			? "height 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms"
			: "height 50ms ease-in",
	};
}

/**
 * The violet flanking lines + centered "+" circle, faded in while `revealed`.
 * All inline (`<span>`) elements so the markup is valid inside the trigger's
 * `<button>`, and `pointer-events-none` so clicks fall through to the trigger —
 * the entire strip is the click target, not just the circle.
 */
export function TreeInsertionLine({ revealed }: { revealed: boolean }) {
	return (
		<span
			className={`pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 transition-opacity duration-150 ${
				revealed ? "opacity-100" : "opacity-0"
			}`}
		>
			<span className="h-px flex-1 bg-nova-violet/40" />
			<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-nova-violet/40 bg-nova-surface text-nova-violet">
				<Icon icon={tablerPlus} width="12" height="12" />
			</span>
			<span className="h-px flex-1 bg-nova-violet/40" />
		</span>
	);
}
