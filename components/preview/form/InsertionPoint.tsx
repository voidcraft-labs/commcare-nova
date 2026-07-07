/**
 * InsertionPoint — the intent-gated gap between fields for inserting new
 * fields. Reveal state comes from `useInsertionZone` (the shared insertion-
 * intent model): the zone registers its rect and the model decides — slow
 * deliberate hover opens near-instantly, traversal never opens, a flick that
 * stops on the gap opens after a settle beat, and an arming glow fades the
 * line in as evidence accumulates.
 *
 * The reveal is layout-neutral: the row is a constant 24px and the line +
 * "+" circle animate opacity/scale WITHIN it, so opening never shifts other
 * rows under the pointer (the bug family that made hover state go stale).
 *
 * Rendering stays two-phase for the virtualized canvas:
 *
 * 1. **Resting** (most rows, most of the time): the zone div + an invisible
 *    click-through detector button. No Menu.Trigger, no Tooltip.
 * 2. **Inflated** (once the zone arms, opens, or is clicked): the visible
 *    line + a detached `Menu.Trigger` connected to the shared
 *    `FieldTypePickerPopup` via `Menu.createHandle()` + a `Tooltip`. The
 *    single shared menu instance in VirtualFormList serves all points; each
 *    trigger sends its (`atIndex`, `parentUuid`) as payload.
 *
 * Clicking works in EVERY phase: the detector is always mounted, and a click
 * that lands before the trigger exists inflates first, then forwards — so
 * automation (or a decisive user) can click a gap that never visibly opened.
 */
"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	INSERTION_CIRCLE_CLS,
	insertionCircleStyle,
	insertionLineCls,
	insertionLineStyle,
} from "@/components/ui/insertionReveal";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Uuid } from "@/lib/doc/types";
import { useCanEdit, useEditMode } from "@/lib/session/hooks";
import {
	type InsertionZone,
	useInsertionZone,
} from "@/lib/ui/hooks/useInsertionZone";
import { useFieldPicker } from "./FieldPickerContext";
import { INSERTION_REST_HEIGHT_PX } from "./virtual/rowStyles";

interface InsertionPointProps {
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
	disabled?: boolean;
}

export function InsertionPoint({
	atIndex,
	parentUuid,
	disabled,
}: InsertionPointProps) {
	const mode = useEditMode();
	const canEdit = useCanEdit();
	const zone = useInsertionZone();
	const pickerCtx = useFieldPicker();
	/* Sticky after first interaction — keeps the Menu.Trigger + Tooltip mounted
	 * so repeated hovers don't re-inflate. */
	const [engaged, setEngaged] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	/* Set when a click arrives before the trigger exists (automation, or a
	 * decisive click on a gap that hasn't revealed) — the click handler
	 * forwards to the trigger mounted by the mousedown's state flip. */
	const pendingOpenRef = useRef(false);

	/* Pin the line while the shared menu is open FOR THIS GAP. The context's
	 * `activeTarget` is reported from inside the menu popup's mount, so this
	 * effect follows the menu's true open state through EVERY path — click,
	 * pointerdown-and-release-into-menu, keyboard open, Escape/outside-click
	 * close, re-anchor to another gap (the model's single-slot hold transfers
	 * atomically), and select. The cleanup also releases when this row
	 * unmounts (virtualizer scroll-out), so a hold can never leak. */
	const target = pickerCtx?.activeTarget;
	const heldByMenu =
		target != null &&
		target.parentUuid === parentUuid &&
		target.atIndex === atIndex;
	const { setHold } = zone;
	useEffect(() => {
		if (!heldByMenu) return;
		setHold(true);
		return () => setHold(false);
	}, [heldByMenu, setHold]);

	/* Insertion points are an edit-mode-only affordance — they don't exist
	 * in preview mode. `useEditMode()` is derived from the session store
	 * so a "no context" branch is never needed. */
	if (mode === "preview") return null;
	/* A view-only Project member can't add fields — drop the "+" entirely.
	 * `InsertionPointRow`'s `minHeight` keeps the 24px gap, so the canvas
	 * spacing is unchanged. */
	if (!canEdit) return null;
	if (disabled) return null;

	const inflated = engaged || heldByMenu || zone.status !== "idle";

	return (
		<div
			ref={zone.ref}
			className="relative"
			style={{ height: INSERTION_REST_HEIGHT_PX }}
			data-insertion-point
		>
			{/* Invisible click detector covering the gap — always mounted so a
			 * click works in every phase. Semantic <button> with tabIndex={-1} so
			 * keyboard users skip it (they use the visible "+" below); aria-hidden
			 * keeps it out of the a11y tree. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="absolute inset-0 z-raised cursor-pointer bg-transparent border-none p-0"
				onMouseEnter={() => {
					if (!engaged) setEngaged(true);
				}}
				onMouseDown={(e) => {
					if (e.button !== 0) return;
					e.preventDefault();
					e.stopPropagation();
					// A fresh gesture always clears a stale pending-open — a prior
					// mousedown whose mouseup landed off the gap never fired the
					// click that consumes it, and a leftover flag would forward a
					// SECOND click below, toggling the menu open→shut.
					pendingOpenRef.current = false;
					if (triggerRef.current) {
						triggerRef.current.click();
					} else {
						// Inflate now (state commits before the click event of this
						// gesture); the click handler forwards.
						pendingOpenRef.current = true;
						setEngaged(true);
					}
				}}
				onClick={(e) => {
					e.stopPropagation();
					if (pendingOpenRef.current) {
						pendingOpenRef.current = false;
						triggerRef.current?.click();
					}
				}}
			/>

			{inflated && (
				<InsertionPointContent
					zone={zone}
					pickerCtx={pickerCtx}
					atIndex={atIndex}
					parentUuid={parentUuid}
					triggerRef={triggerRef}
				/>
			)}
		</div>
	);
}

// ── Inflated content (line + shared-menu trigger) ────────────────────

function InsertionPointContent({
	zone,
	pickerCtx,
	atIndex,
	parentUuid,
	triggerRef,
}: {
	zone: InsertionZone;
	pickerCtx: ReturnType<typeof useFieldPicker>;
	atIndex: number;
	parentUuid: Uuid;
	triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
	const open = zone.status === "open";
	const stopClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	/* Same z tier as the detector but later in the DOM, so the layer paints
	 * above it; `pointer-events-none` keeps the gap's clicks on the detector,
	 * and only the "+" circle re-enables them when open — that's what makes
	 * its hover tint and tooltip live (a detector ABOVE the trigger would eat
	 * both). */
	return (
		<div className="absolute inset-x-0 top-1/2 -translate-y-1/2 z-raised flex items-center pointer-events-none">
			<div
				className={insertionLineCls("right")}
				style={insertionLineStyle(zone.progress, open)}
			/>

			{/* Detached trigger connected to the shared Menu.Root in
			 *  VirtualFormList. The payload carries this InsertionPoint's location
			 *  so the shared FieldTypePickerPopup knows where to insert. */}
			<Tooltip content="Insert field">
				<Menu.Trigger
					ref={triggerRef}
					handle={pickerCtx?.handle}
					payload={{ atIndex, parentUuid }}
					className={`${INSERTION_CIRCLE_CLS} mx-1 w-5 h-5 hover:bg-nova-violet/10 cursor-pointer shrink-0 outline-none ${
						open ? "pointer-events-auto" : "pointer-events-none"
					}`}
					style={insertionCircleStyle(open, "background-color 150ms ease")}
					aria-label="Insert field"
					onClick={stopClick}
				>
					<Icon icon={tablerPlus} width="12" height="12" />
				</Menu.Trigger>
			</Tooltip>

			<div
				className={insertionLineCls("left")}
				style={insertionLineStyle(zone.progress, open)}
			/>
		</div>
	);
}
