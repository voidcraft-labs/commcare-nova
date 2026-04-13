/**
 * InsertionPoint — hover-reveal gap between questions for inserting new fields.
 *
 * Two-phase rendering for performance:
 *
 * 1. **Lazy shell** (initial mount): A minimal 24px div with a single `useState`
 *    hook. Inflates to the full UI on first mouse entry. For a 25-question form,
 *    this reduces 26 InsertionPoints from ~338 hooks to ~26 hooks at mount time.
 *
 * 2. **Full InsertionPoint** (after first hover): Hover detection logic with
 *    EMA-smoothed cursor speed gating, a detached `Menu.Trigger` connected to
 *    the shared `QuestionTypePickerPopup` via `Menu.createHandle()`, and a
 *    `Tooltip` wrapper. No `Menu.Root` or popup content — the single shared
 *    instance in `FormRenderer` serves all InsertionPoints.
 *
 * The shared menu pattern uses Base UI's official detached trigger API:
 * each InsertionPoint sends its context (`atIndex`, `parentPath`) as payload
 * to the shared `Menu.Root` via the handle. The popup reads the payload to
 * determine where to insert the new question.
 */
"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerPlus from "@iconify-icons/tabler/plus";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useEditContext } from "@/hooks/useEditContext";
import type { QuestionPath } from "@/lib/services/questionPath";
import { useQuestionPicker } from "./QuestionPickerContext";

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
 * Lazy shell: a minimal 24px div that inflates the full InsertionPoint
 * on first mouse entry. Avoids mounting hover-detection hooks, Menu.Trigger,
 * and Tooltip for all 26+ insertion points until the user actually approaches.
 */
export function InsertionPoint(props: InsertionPointProps) {
	const ctx = useEditContext();
	const [activated, setActivated] = useState(false);

	if (!ctx || ctx.mode === "test") return null;
	if (props.disabled) return null;

	if (!activated) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: lazy shell — mouseenter inflates the full interactive InsertionPoint, no keyboard interaction needed
			<div
				style={{ height: 24 }}
				onMouseEnter={() => setActivated(true)}
				data-insertion-point
			/>
		);
	}

	return <FullInsertionPoint {...props} />;
}

// ── Full InsertionPoint (inflated on first hover) ────────────────────

/**
 * The fully-interactive InsertionPoint with hover detection, speed gating,
 * detached menu trigger, and tooltip. Mounts only after the lazy shell
 * receives its first mouseenter event.
 */
function FullInsertionPoint({
	atIndex,
	parentPath,
	disabled,
	cursorSpeedRef,
	lastCursorRef,
}: InsertionPointProps) {
	const pickerCtx = useQuestionPicker();
	const [hovered, setHovered] = useState(true); // start hovered since we inflated on mouseenter
	const triggerRef = useRef<HTMLButtonElement>(null);
	const pendingRef = useRef(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	/* Subscribe to menu close events from the shared Menu.Root so we can
	 * collapse the hover line when the user finishes selecting a question type
	 * or clicks outside the popup. */
	useEffect(() => {
		if (!pickerCtx) return;
		return pickerCtx.subscribeClose(() => {
			setHovered(false);
		});
	}, [pickerCtx]);

	const clearPoll = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	/* Clean up the speed-gating poll interval on unmount. Without this,
	 * starting a drag while the EMA polling loop is active (fast cursor
	 * sweep + drag start) leaks the setInterval against an unmounted
	 * component — FullInsertionPoint unmounts when `disabled` becomes true. */
	useEffect(() => {
		return () => clearPoll();
	}, [clearPoll]);

	const show = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		setHovered(true);
	}, [clearPoll]);

	const handleMouseEnter = useCallback(() => {
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
	}, [cursorSpeedRef, lastCursorRef, show, clearPoll]);

	const handleMouseMove = useCallback(() => {
		if (!pendingRef.current) return;
		const fast = (cursorSpeedRef?.current ?? 0) > SPEED_THRESHOLD;
		if (!fast) show();
	}, [cursorSpeedRef, show]);

	const handleMouseLeave = useCallback(() => {
		clearPoll();
		pendingRef.current = false;
		/* Keep the insertion line visible while the shared menu is open — the
		 * user may have moved their pointer into a portal-rendered submenu. The
		 * subscribeClose listener handles cleanup when the menu eventually closes. */
		if (!pickerCtx?.handle.isOpen) setHovered(false);
	}, [pickerCtx, clearPoll]);

	/** Click anywhere in the gap → forward to the actual Menu.Trigger button.
	 *  Since the trigger is a detached Menu.Trigger with the shared handle,
	 *  Base UI handles open state, positioning, and FloatingTreeStore registration
	 *  correctly. No `justOpenedRef` guard needed — the click originates from
	 *  the trigger element itself, so Base UI recognizes it as an inside-tree
	 *  interaction and won't immediately dismiss. */
	const handleDetectorMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		triggerRef.current?.click();
	}, []);

	/** Prevent click from bubbling to parent question wrappers. */
	const stopClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	if (disabled) return null;

	const isActive = hovered;

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
			 * a11y tree. Clicks forward to the Menu.Trigger via ref. */}
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

				{/* Detached trigger connected to the shared Menu.Root in FormRenderer.
				 *  The payload carries this InsertionPoint's location so the shared
				 *  QuestionTypePickerPopup knows where to insert the new question. */}
				<Tooltip content="Insert question">
					<Menu.Trigger
						ref={triggerRef}
						handle={pickerCtx?.handle}
						payload={{ atIndex, parentPath }}
						className="mx-1 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-violet/40 text-nova-violet hover:bg-nova-violet/10 transition-colors cursor-pointer shrink-0 outline-none"
						aria-label="Insert question"
						onClick={stopClick}
					>
						<Icon icon={tablerPlus} width="12" height="12" />
					</Menu.Trigger>
				</Tooltip>

				<div className="flex-1 h-px bg-nova-violet/40" />
			</div>
		</div>
	);
}
