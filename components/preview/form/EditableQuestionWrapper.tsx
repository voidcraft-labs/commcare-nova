"use client";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import { asUuid } from "@/lib/doc/types";
import { useIsQuestionSelected, useSelect } from "@/lib/routing/hooks";

interface EditableQuestionWrapperProps {
	/** Stable crypto UUID — the sole identity prop (survives renames). */
	questionUuid: string;
	children: ReactNode;
	style?: React.CSSProperties;
	isDragging?: boolean;
}

/**
 * Wrapper that makes a question selectable by click in edit mode.
 *
 * Selection is driven by the URL (`sel=` query param). `useIsQuestionSelected`
 * reads the URL's `sel` and returns `true` for exactly one wrapper at a time.
 * On click, `useSelect()` replaces the `sel=` param via `router.replace` —
 * no Zustand write, no re-render cascade.
 *
 * Scroll behavior is delegated to `BuilderEngine.setPendingScroll` so the
 * selected question's panel (mounted by SortableQuestion) can honor it
 * via `fulfillPendingScroll` once the panel paints.
 */
export function EditableQuestionWrapper({
	questionUuid,
	children,
	style,
	isDragging,
}: EditableQuestionWrapperProps) {
	const ctx = useEditContext();
	const engine = useBuilderEngine();
	const select = useSelect();
	const [hovered, setHovered] = useState(false);
	const [holdReady, setHoldReady] = useState(false);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wasDraggingRef = useRef(false);

	/* Selection via URL-driven boolean selector — only this wrapper and the
	 * previously-selected wrapper re-render on selection change. All other
	 * wrappers return the same `false` and skip rendering entirely. */
	const isSelected = useIsQuestionSelected(questionUuid);

	const clearHoldTimer = useCallback(() => {
		if (holdTimerRef.current) {
			clearTimeout(holdTimerRef.current);
			holdTimerRef.current = null;
		}
	}, []);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
			clearHoldTimer();
			holdTimerRef.current = setTimeout(() => {
				holdTimerRef.current = null;
				setHoldReady(true);
			}, 300);
		},
		[clearHoldTimer],
	);

	const handlePointerUp = useCallback(() => {
		clearHoldTimer();
		setHoldReady(false);
	}, [clearHoldTimer]);

	const handlePointerLeave = useCallback(() => {
		clearHoldTimer();
		if (!isDragging) setHoldReady(false);
	}, [clearHoldTimer, isDragging]);

	// Reset hold only on drag end transition (isDragging: true → false)
	if (isDragging) wasDraggingRef.current = true;
	if (!isDragging && wasDraggingRef.current) {
		wasDraggingRef.current = false;
		if (holdReady) setHoldReady(false);
	}

	/** Select this question in the builder and scroll its tree row into view.
	 *  `hasToolbar` signals that a text-editable zone was clicked — the scroll
	 *  target needs extra clearance for the floating TipTap label toolbar. */
	const selectQuestion = useCallback(
		(hasToolbar = false) => {
			engine.setPendingScroll(questionUuid, "smooth", hasToolbar);
			select(asUuid(questionUuid));
		},
		[engine, questionUuid, select],
	);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			// Ignore clicks from portal-rendered elements (e.g. insertion menu portal).
			// React synthetic events still bubble through the React tree from portals,
			// but the DOM target is outside this wrapper's subtree.
			const target = e.target as HTMLElement;
			if (!e.currentTarget.contains(target)) return;
			// Don't intercept clicks inside the inline settings panel, nested wrappers, or insertion points
			if (target.closest("[data-no-drag]")) return;
			/* Nested wrapper guard — if the click landed inside a child question's
			 * wrapper, bail so only that child handles selection. Must run before
			 * the text-editable check: without this, clicking a nested question's
			 * label (a [data-text-editable] zone) would match here and select the
			 * GROUP, then the child's handler would re-select the child — two
			 * select calls with two scrollTo targets, the second missing the
			 * collapsing panel compensation from the first. */
			const closestWrapper = target.closest("[data-question-wrapper]");
			if (closestWrapper && closestWrapper !== e.currentTarget) return;
			/* Let clicks on text-editable zones pass through — select the question
			 * but don't stop propagation so TextEditable's handler also fires.
			 * Pass hasToolbar so the scroll leaves clearance for the floating
			 * TipTap label toolbar that will render above the question.
			 *
			 * If the question is already selected, the URL `sel=` won't change,
			 * so fulfillPendingScroll never fires. Call scrollToQuestion directly
			 * to ensure the toolbar gets clearance when activating a text editor
			 * on the current question. */
			if (target.closest("[data-text-editable]")) {
				if (isSelected) {
					engine.scrollToQuestion(questionUuid, undefined, "smooth", true);
				} else {
					selectQuestion(true);
				}
				return;
			}
			if (target.closest("[data-insertion-point]")) return;
			e.stopPropagation();
			selectQuestion();
		},
		[selectQuestion, isSelected, questionUuid, engine],
	);

	/** Keyboard activation — Enter or Space selects this question, matching
	 *  the click behavior for keyboard-only users (role="button" contract).
	 *  Skip when the event originates from an active text editor (TipTap
	 *  contenteditable) — otherwise the bubbling keydown swallows spaces
	 *  and prevents typing. */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				const target = e.target as HTMLElement;
				if (target.closest("[contenteditable]")) return;
				e.preventDefault();
				e.stopPropagation();
				selectQuestion();
			}
		},
		[selectQuestion],
	);

	if (!ctx || ctx.mode === "test") {
		return <div style={style}>{children}</div>;
	}

	const mergedStyle = holdReady
		? { ...style, cursor: "grabbing" as const }
		: style;

	/* Use div[role=button] instead of <button> because children contain
	 * interactive elements (InsertionPoint buttons, TextEditable buttons,
	 * form inputs). HTML forbids nesting interactive content inside <button>,
	 * and browsers/SSR parsers will mangle the tree. */
	return (
		// biome-ignore lint/a11y/useSemanticElements: can't use <button> — children contain nested interactive elements (buttons, inputs, fieldsets) which is forbidden in HTML
		<div
			role="button"
			tabIndex={0}
			data-question-wrapper
			aria-label="Select question"
			/* Selected: flatten the bottom corners so the inline settings panel
			 * attaches flush, and collapse outline-offset so the violet outline
			 * sits at the element edge rather than floating 3px above the panel. */
			className={`group/qw relative w-full text-left rounded-lg transition-all duration-150 cursor-pointer ${
				isSelected
					? "rounded-b-none outline-2 outline-nova-violet outline-offset-0 bg-nova-violet/[0.03]"
					: hovered
						? "outline-1 outline-nova-violet/30 outline-offset-3"
						: "outline-1 outline-nova-violet/10 outline-offset-3"
			}`}
			style={mergedStyle}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			onPointerLeave={handlePointerLeave}
			onClickCapture={handleClick}
			onKeyDown={handleKeyDown}
		>
			<div className="pointer-events-none" tabIndex={-1}>
				{children}
			</div>
		</div>
	);
}
