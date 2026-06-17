/**
 * InsertionPoint — hover-reveal gap between fields for inserting new fields.
 *
 * Two-phase rendering for performance:
 *
 * 1. **Lazy shell** (initial mount): A minimal 24px div with a single `useState`
 *    hook. Inflates to the full UI on first mouse entry. For a 25-field form,
 *    this reduces 26 InsertionPoints from ~338 hooks to ~26 hooks at mount time.
 *
 * 2. **Full InsertionPoint** (after first hover): Hover detection logic with
 *    EMA-smoothed cursor speed gating, a detached `Menu.Trigger` connected to
 *    the shared `FieldTypePickerPopup` via `Menu.createHandle()`, and a
 *    `Tooltip` wrapper. No `Menu.Root` or popup content — the single shared
 *    instance in `FormRenderer` serves all InsertionPoints.
 *
 * The shared menu pattern uses Base UI's official detached trigger API:
 * each InsertionPoint sends its context (`atIndex`, `parentPath`) as payload
 * to the shared `Menu.Root` via the handle. The popup reads the payload to
 * determine where to insert the new field.
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
import type { Uuid } from "@/lib/doc/types";
import { useEditMode } from "@/lib/session/hooks";
import {
	insertionRevealTransition,
	useInsertionHover,
} from "@/lib/ui/hooks/useInsertionHover";
import { useFieldPicker } from "./FieldPickerContext";

interface InsertionPointProps {
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
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
	const mode = useEditMode();
	const [activated, setActivated] = useState(false);

	/* Insertion points are an edit-mode-only affordance — they don't exist
	 * in preview mode. `useEditMode()` is derived from the session store
	 * so a "no context" branch is never needed. */
	if (mode === "preview") return null;
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
	parentUuid,
	disabled,
	cursorSpeedRef,
	lastCursorRef,
}: InsertionPointProps) {
	const pickerCtx = useFieldPicker();
	const triggerRef = useRef<HTMLButtonElement>(null);

	const {
		revealed,
		reset,
		containerRef,
		onMouseEnter,
		onMouseMove,
		onMouseLeave,
	} = useInsertionHover<HTMLDivElement>({
		cursorSpeedRef,
		lastCursorRef,
		/* Keep the insertion line visible while the shared menu is open — the
		 * pointer may have moved into a portal-rendered submenu. subscribeClose
		 * collapses it once the menu eventually closes. */
		keepOpen: () => pickerCtx?.handle.isOpen ?? false,
	});

	/* The shared Menu.Root broadcasts close events (from whichever insertion
	 * point opened it) so we collapse the hover line when the user finishes
	 * selecting a field kind or clicks outside the popup. */
	useEffect(() => {
		if (!pickerCtx) return;
		return pickerCtx.subscribeClose(reset);
	}, [pickerCtx, reset]);

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

	/** Prevent click from bubbling to parent field wrappers. */
	const stopClick = useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
	}, []);

	if (disabled) return null;

	const isActive = revealed;

	return (
		<div
			ref={containerRef}
			className="relative"
			style={{
				height: isActive ? 32 : 24,
				transition: insertionRevealTransition(isActive),
			}}
			data-insertion-point
		>
			{/* Invisible hover detector covering the insertion point's own area.
			 * No negative margins — the detector stays within the gap so the user
			 * won't accidentally trigger it from an adjacent field.
			 * Semantic <button> with tabIndex={-1} so keyboard users skip it (they
			 * use the visible "+" button below). aria-hidden keeps it out of the
			 * a11y tree. Clicks forward to the Menu.Trigger via ref. */}
			<button
				type="button"
				tabIndex={-1}
				aria-hidden="true"
				className="absolute inset-0 z-raised cursor-pointer bg-transparent border-none p-0"
				onMouseEnter={onMouseEnter}
				onMouseMove={onMouseMove}
				onMouseLeave={onMouseLeave}
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
				 *  FieldTypePickerPopup knows where to insert the new field. */}
				<Tooltip content="Insert field">
					<Menu.Trigger
						ref={triggerRef}
						handle={pickerCtx?.handle}
						payload={{ atIndex, parentUuid }}
						className="mx-1 w-5 h-5 flex items-center justify-center rounded-full bg-nova-surface border border-nova-violet/40 text-nova-violet-bright hover:bg-nova-violet/10 transition-colors cursor-pointer shrink-0 outline-none"
						aria-label="Insert field"
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
