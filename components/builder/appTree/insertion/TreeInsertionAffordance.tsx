// components/builder/appTree/insertion/TreeInsertionAffordance.tsx
//
// The hover-reveal "+" affordance between app-tree rows — the tree analog of
// the form canvas's `InsertionPoint`, sharing its EXACT reveal gating (the
// insertion-intent model behind `lib/ui/hooks/useInsertionZone`): the strip
// opens when the model reads dwell-intent over it — a slow hover opens
// near-instantly, sweeping past never opens, a flick that stops on it opens
// after a settle beat. The Base UI Menu/Popover TRIGGER itself is the
// affordance — a full-width, click-anywhere strip that EXPANDS (14px → 32px,
// pushing the neighboring rows apart) while revealed — layout moving under
// the pointer is safe because zone containment is geometric (the binding
// re-measures rects through the reveal animation), never DOM hover state.
// The host composes three pieces:
//   - useTreeInsertionZone(open) — the gated `revealed` state + the zone ref
//     to attach to the trigger; AppTree mounts the surface-wide model via
//     InsertionIntentProvider.
//   - INSERTION_TRIGGER_CLS / insertionTriggerStyle — the trigger's chrome.
//   - TreeInsertionLine — the violet lines + the labeled "+ Form" /
//     "+ Module" pill rendered inside it. The label is the level indicator;
//     there is no tooltip (naming an affordance through a tooltip means
//     naming it while it's invisible).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type CSSProperties, useEffect } from "react";
import {
	INSERTION_CIRCLE_CLS,
	insertionCircleStyle,
	insertionExpandStyle,
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
 *  strip so the WHOLE line is clickable, not just the "+". */
export const INSERTION_TRIGGER_CLS =
	"relative block w-full cursor-pointer outline-none";

/** The trigger's animated geometry: a thin 14px gap at rest that expands to
 *  32px while revealed, giving the 20px "+" circle clearance and pushing the
 *  adjacent rows apart — the same slide-open the form canvas's
 *  InsertionPoint performs. */
export function insertionTriggerStyle(revealed: boolean): CSSProperties {
	return insertionExpandStyle(revealed, 14, 32);
}

/**
 * The violet flanking lines + centered "+ <label>" pill. While arming, the
 * lines glow in with accumulated evidence; on reveal they commit to full
 * opacity and the pill blooms in. The LABEL is what makes the two tree
 * levels legible — a bare "+" between a module's last form and the next
 * module is anonymous, and naming the action through a tooltip means naming
 * it through an invisible affordance. All inline (`<span>`) elements so the
 * markup is valid inside the trigger's `<button>`. The lines are
 * `pointer-events-none` (clicks fall through to the full-width trigger);
 * the pill re-enables pointer events because it overflows the strip's hit
 * box — a click on the overflowing sliver must not fall through to the
 * adjacent row.
 *
 * `insetCls` positions the lines: form strips indent to the form rows'
 * depth so the affordance reads as INSIDE the module; module strips span
 * the tree's full row width.
 */
export function TreeInsertionLine({
	revealed,
	progress = 0,
	label,
	insetCls = "inset-x-3",
}: {
	revealed: boolean;
	progress?: number;
	/** Names the action in the pill — "Form" | "Module". */
	label: string;
	insetCls?: string;
}) {
	return (
		<span
			className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 ${insetCls}`}
		>
			<span
				className={insertionLineCls("right")}
				style={insertionLineStyle(progress, revealed)}
			/>
			<span
				className={`${INSERTION_CIRCLE_CLS} h-5 shrink-0 gap-1 px-2 ${
					revealed ? "pointer-events-auto" : ""
				}`}
				style={insertionCircleStyle(revealed)}
			>
				<Icon icon={tablerPlus} width="12" height="12" />
				<span className="text-[11px] font-medium leading-none">{label}</span>
			</span>
			<span
				className={insertionLineCls("left")}
				style={insertionLineStyle(progress, revealed)}
			/>
		</span>
	);
}
