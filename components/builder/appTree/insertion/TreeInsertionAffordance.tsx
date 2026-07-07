// components/builder/appTree/insertion/TreeInsertionAffordance.tsx
//
// The hover-reveal "+" affordance between app-tree rows — the tree analog of
// the form canvas's `InsertionPoint`, sharing its EXACT reveal gating (the
// insertion-intent model behind `lib/ui/hooks/useInsertionZone`): the strip
// opens when the model reads dwell-intent over it — a slow hover opens
// near-instantly, sweeping past never opens, a flick that stops on it opens
// after a settle beat. The Base UI Menu/Popover TRIGGER itself is the
// affordance — a full-width, click-anywhere strip at a CONSTANT height (the
// reveal animates opacity/scale within it, never layout, so opening can't
// shift sibling rows under the pointer). The 20px "+" circle overflows the
// 14px strip by a few pixels on each side, Notion-style; it re-enables
// pointer events on itself so clicks on the overflowing sliver still land on
// the trigger (they'd otherwise fall through to the adjacent row). The host
// composes three pieces:
//   - useTreeInsertionZone(open) — the gated `revealed` state + the zone ref
//     to attach to the trigger; AppTree mounts the surface-wide model via
//     InsertionIntentProvider.
//   - INSERTION_TRIGGER_CLS / INSERTION_TRIGGER_STYLE — the trigger's chrome.
//   - TreeInsertionLine — the violet lines + "+" circle rendered inside it.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type CSSProperties, useEffect } from "react";
import {
	INSERTION_CIRCLE_CLS,
	insertionCircleStateCls,
	insertionLineCls,
	insertionLineStyle,
} from "@/components/ui/insertionReveal";
import {
	type InsertionZone,
	useInsertionZone,
} from "@/lib/ui/hooks/useInsertionZone";

interface TreeInsertionZone {
	/** Whether the strip shows its line + "+". */
	readonly revealed: boolean;
	/** Arming evidence 0..1 — drives the pre-open glow. */
	readonly progress: number;
	/** Attach to the Base UI `Menu.Trigger` / `Popover.Trigger`. */
	readonly ref: InsertionZone["ref"];
}

/**
 * Intent-gated reveal for a tree insertion affordance. `open` is the host
 * popup's open state: while open the zone is HELD (the pointer may be inside
 * the portalled popup), and release hands control back to the model — the
 * tree equivalent of the form InsertionPoint pinning on the picker's
 * `activeTarget`.
 */
export function useTreeInsertionZone(open: boolean): TreeInsertionZone {
	const zone = useInsertionZone();
	// Hold while the popup is open (the pointer may be inside the portal); the
	// effect cleanup also releases on unmount so a hold can't outlive its zone.
	const { setHold } = zone;
	useEffect(() => {
		if (!open) return;
		setHold(true);
		return () => setHold(false);
	}, [open, setHold]);
	return {
		revealed: open || zone.status === "open",
		progress: zone.progress,
		ref: zone.ref,
	};
}

/** The insertion trigger's static className: a full-width, pointer-cursor
 *  strip so the WHOLE line is clickable, not just the "+". Constant height —
 *  the reveal never changes layout. */
export const INSERTION_TRIGGER_CLS =
	"relative block w-full cursor-pointer outline-none";

/** The trigger's fixed geometry (a style for call-site symmetry with the
 *  form canvas; no animation — the reveal lives in TreeInsertionLine). */
export const INSERTION_TRIGGER_STYLE: CSSProperties = { height: 14 };

/**
 * The violet flanking lines + centered "+" circle. While arming, the lines
 * glow in with accumulated evidence; on reveal they commit to full opacity
 * and the circle pops in. All inline (`<span>`) elements so the markup is
 * valid inside the trigger's `<button>`. The lines are `pointer-events-none`
 * (clicks fall through to the full-width trigger); the circle re-enables
 * pointer events because it overflows the strip's hit box.
 */
export function TreeInsertionLine({
	revealed,
	progress = 0,
}: {
	revealed: boolean;
	progress?: number;
}) {
	return (
		<span className="pointer-events-none absolute inset-x-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
			<span
				className={insertionLineCls("right")}
				style={insertionLineStyle(progress, revealed)}
			/>
			<span
				className={`${INSERTION_CIRCLE_CLS} ${insertionCircleStateCls(revealed)} h-5 w-5 shrink-0 ${
					revealed ? "pointer-events-auto" : ""
				}`}
			>
				<Icon icon={tablerPlus} width="12" height="12" />
			</span>
			<span
				className={insertionLineCls("left")}
				style={insertionLineStyle(progress, revealed)}
			/>
		</span>
	);
}
