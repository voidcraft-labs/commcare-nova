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
 * Renders an invisible hover zone that expands into a visible divider line with
 * a centred "+" button. The button is a `Menu.Trigger` inside a `Menu.Root`,
 * so Base UI fully manages the menu lifecycle — floating tree, dismiss, focus
 * return, and submenu safe-polygon all work natively.
 *
 * The invisible hover detector covers a wider area than the button to make
 * the insertion point discoverable. Clicks anywhere in the detector zone are
 * forwarded to the `Menu.Trigger` via a dispatched `mousedown` event, preserving
 * the "click anywhere in the gap" UX while keeping the trigger as the canonical
 * interaction source for Base UI's floating context.
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

	/** Forward mousedown from the invisible hover detector to the `Menu.Trigger`.
	 *  Base UI's `useClick` on the trigger listens for `mousedown` events, so a
	 *  dispatched native `mousedown` triggers the standard open/toggle path —
	 *  including `FloatingTreeStore` registration and `activeTriggerElement` sync
	 *  via `useImplicitActiveTrigger`. This preserves the "click anywhere in the
	 *  gap" UX without bypassing Base UI's menu lifecycle. */
	const handleDetectorMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		triggerRef.current?.dispatchEvent(
			new MouseEvent("mousedown", {
				bubbles: true,
				cancelable: true,
				button: 0,
			}),
		);
	}, []);

	/** Prevent click from bubbling to parent question wrappers. */
	const stopClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	/** Sync local visual state when the Base UI menu opens or closes.
	 *  Base UI's FloatingTreeStore handles dismissing competing floating
	 *  elements automatically (outside-click). Resets hover state on close
	 *  so the insertion line collapses back to zero-height. */
	const handleOpenChange = useCallback((nextOpen: boolean) => {
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
				height: isActive ? 24 : 0,
				marginBottom: isActive ? 16 : 0,
				transition: isActive
					? "height 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms, margin 200ms cubic-bezier(0.6, 0, 0.1, 1) 50ms"
					: "height 50ms ease-in, margin 50ms ease-in",
			}}
			data-insertion-point
		>
			{/* Invisible hover detector extending into adjacent gaps. Semantic <button>
			 * with tabIndex={-1} so keyboard users skip it (they use the visible "+"
			 * button below). aria-hidden keeps it out of the a11y tree entirely.
			 * Clicks are forwarded to the Menu.Trigger via dispatched mousedown. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="absolute inset-x-0 -top-2 -bottom-2 z-raised cursor-pointer bg-transparent border-none p-0"
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
