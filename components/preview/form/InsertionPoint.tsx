"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import { type RefObject, useCallback, useRef, useState } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useEditContext } from "@/hooks/useEditContext";
import type { QuestionPath } from "@/lib/services/questionPath";
import { QuestionTypePickerPopup } from "./QuestionTypePicker";

/** Speed threshold in px/ms. Above this = cursor is traversing, don't open. */
const SPEED_THRESHOLD = 0.01;
/** How often (ms) to re-check speed while waiting for cursor to slow down. */
const POLL_INTERVAL = 16;
/** Per-tick decay factor applied to EMA when cursor is stationary. */
const POLL_DECAY = 0.15;
/** Time (ms) with no mousemove events before the cursor is considered stationary. ~2 frames at 60fps. */
const STALE_THRESHOLD = 32;

interface InsertionPointProps {
	atIndex: number;
	parentPath?: QuestionPath;
	disabled?: boolean;
	cursorSpeedRef?: RefObject<number>;
	lastCursorRef?: RefObject<{ x: number; y: number; t: number } | undefined>;
}

/**
 * Hover-reveal insertion gap between questions.
 *
 * Occupies a fixed resting height (the gap between questions) and reveals a
 * visible divider line with a centred "+" button on hover. The hover detector
 * covers only the insertion point's own area — no negative margins extending
 * into adjacent question space — so the user won't accidentally trigger it
 * while interacting with a nearby field.
 *
 * The button is a `Menu.Trigger` inside a `Menu.Root`, so Base UI fully manages
 * the menu lifecycle — floating tree, dismiss, focus return, and submenu
 * safe-polygon all work natively. Clicks anywhere in the gap open the menu
 * via controlled state (`setMenuOpen(true)`) with a one-interaction guard
 * against Base UI's outside-click immediately closing it.
 */
export function InsertionPoint({
	atIndex,
	parentPath,
	disabled,
	cursorSpeedRef,
	lastCursorRef,
}: InsertionPointProps) {
	const ctx = useEditContext();
	const [hovered, setHovered] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const pendingRef = useRef(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	/** Guards against Base UI's outside-click detection immediately closing
	 *  the menu when it was just opened programmatically from the detector. */
	const justOpenedRef = useRef(false);

	const clearPoll = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const show = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		setHovered(true);
	}, [clearPoll]);

	const handleMouseEnter = useCallback(() => {
		/* Don't re-trigger hover animation while the menu is showing. */
		if (menuOpen) return;
		const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD;
		if (!fast) {
			show();
		} else {
			/* Fast entry — poll until EMA decays below threshold. */
			pendingRef.current = true;
			clearPoll();
			pollRef.current = setInterval(() => {
				/* If cursor hasn't moved in 2 frames, it's stationary — decay EMA toward 0. */
				const lastT = lastCursorRef?.current?.t ?? 0;
				if (performance.now() - lastT > STALE_THRESHOLD) {
					if (cursorSpeedRef) cursorSpeedRef.current *= 1 - POLL_DECAY;
				}
				if ((cursorSpeedRef?.current ?? 0) <= SPEED_THRESHOLD) {
					show();
				}
			}, POLL_INTERVAL);
		}
	}, [menuOpen, cursorSpeedRef, lastCursorRef, show, clearPoll]);

	const handleMouseMove = useCallback(() => {
		if (!pendingRef.current) return;
		const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD;
		if (!fast) show();
	}, [cursorSpeedRef, show]);

	const handleMouseLeave = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		/* Keep the insertion line visible while the menu is open — the user
		 * may have moved their pointer into a portal-rendered submenu. */
		if (!menuOpen) setHovered(false);
	}, [menuOpen, clearPoll]);

	/** Open the menu programmatically when clicking anywhere in the gap.
	 *  Uses controlled state rather than dispatching synthetic events to the
	 *  trigger — a synthetic mousedown would open the menu, but the native
	 *  click that follows is treated as "outside" by Base UI's floating
	 *  dismiss (the detector isn't part of the menu tree), closing it
	 *  immediately. The `justOpenedRef` guard lets `handleOpenChange` ignore
	 *  that spurious close within the same pointer interaction. Cleared on
	 *  the next pointerdown so normal dismiss works for subsequent clicks. */
	const handleDetectorMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		justOpenedRef.current = true;
		setMenuOpen(true);
		document.addEventListener(
			"pointerdown",
			() => {
				justOpenedRef.current = false;
			},
			{ once: true },
		);
	}, []);

	/** Prevent click from bubbling to parent question wrappers. */
	const stopClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	/** Sync local visual state when the Base UI menu opens or closes.
	 *  Base UI's FloatingTreeStore handles dismissing competing floating
	 *  elements automatically (outside-click). Ignores the spurious close
	 *  that fires in the same frame as a programmatic open from the detector.
	 *  Resets hover state on close so the insertion line collapses. */
	const handleOpenChange = useCallback((nextOpen: boolean) => {
		if (!nextOpen && justOpenedRef.current) return;
		setMenuOpen(nextOpen);
		if (!nextOpen) setHovered(false);
	}, []);

	if (!ctx || ctx.mode === "test") return null;
	if (disabled) return null;

	const isActive = hovered || menuOpen;

	return (
		<div
			className="relative"
			style={{
				height: isActive ? 32 : 24,
				transition: isActive
					? "height 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms"
					: "height 50ms ease-in",
			}}
			data-insertion-point
		>
			{/* Invisible hover detector covering the insertion point's own area.
			 * No negative margins — the detector stays within the gap so the user
			 * won't accidentally trigger it from an adjacent question field.
			 * Semantic <button> with tabIndex={-1} so keyboard users skip it (they
			 * use the visible "+" button below). aria-hidden keeps it out of the
			 * a11y tree. Clicks open the menu via controlled state. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="absolute inset-0 z-raised cursor-pointer bg-transparent border-none p-0"
				onMouseEnter={handleMouseEnter}
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
				onMouseDown={handleDetectorMouseDown}
				onClick={stopClick}
			/>

			{/* Visible content — vertically centered in the expanded area */}
			<div
				className={`absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center transition-opacity duration-150 ${
					isActive ? "opacity-100" : "opacity-0 pointer-events-none"
				}`}
			>
				<div className="flex-1 h-px bg-nova-violet/40" />

				{/* Menu.Root owns the full menu lifecycle. The controlled `open` prop
				 * lets the invisible hover detector open the menu programmatically,
				 * while useImplicitActiveTrigger ensures the trigger element is
				 * claimed even when opened via the controlled prop. */}
				<Menu.Root open={menuOpen} onOpenChange={handleOpenChange}>
					<Tooltip content="Insert question">
						<Menu.Trigger
							ref={triggerRef}
							className="mx-1 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-violet/40 text-nova-violet hover:bg-nova-violet/10 transition-colors cursor-pointer shrink-0 outline-none"
							aria-label="Insert question"
							onClick={stopClick}
						>
							<Icon icon={tablerPlus} width="12" height="12" />
						</Menu.Trigger>
					</Tooltip>
					<QuestionTypePickerPopup atIndex={atIndex} parentPath={parentPath} />
				</Menu.Root>

				<div className="flex-1 h-px bg-nova-violet/40" />
			</div>
		</div>
	);
}
