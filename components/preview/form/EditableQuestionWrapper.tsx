"use client";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useBuilderEngine, useIsQuestionSelected } from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import type { QuestionPath } from "@/lib/services/questionPath";

interface EditableQuestionWrapperProps {
	questionPath: QuestionPath;
	/** Stable crypto UUID — used for selection identity (survives renames). */
	questionUuid: string;
	children: ReactNode;
	style?: React.CSSProperties;
	isDragging?: boolean;
}

export function EditableQuestionWrapper({
	questionPath,
	questionUuid,
	children,
	style,
	isDragging,
}: EditableQuestionWrapperProps) {
	const ctx = useEditContext();
	const engine = useBuilderEngine();
	const [hovered, setHovered] = useState(false);
	const [holdReady, setHoldReady] = useState(false);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wasDraggingRef = useRef(false);

	const moduleIndex = ctx?.moduleIndex;
	const formIndex = ctx?.formIndex;

	/* Selection via targeted boolean selector — only this wrapper and the
	 * previously-selected wrapper re-render on selection change. All other
	 * wrappers return the same `false` and skip rendering entirely. */
	const isSelected = useIsQuestionSelected(
		moduleIndex ?? 0,
		formIndex ?? 0,
		questionUuid,
	);

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
			if (moduleIndex === undefined || formIndex === undefined) return;
			engine.navigateTo(
				{
					type: "question",
					moduleIndex,
					formIndex,
					questionPath,
					questionUuid,
				},
				"smooth",
				hasToolbar,
			);
			/* Scroll the structure sidebar tree row into view only if it's
			 * off-screen — don't disrupt the tree position when the row is visible. */
			const treeRow = document.querySelector(
				`[data-tree-question="${questionPath}"]`,
			) as HTMLElement | null;
			if (treeRow) {
				const parent = treeRow.closest(
					'[class*="overflow-auto"]',
				) as HTMLElement | null;
				if (parent) {
					const parentRect = parent.getBoundingClientRect();
					const rowRect = treeRow.getBoundingClientRect();
					const isVisible =
						rowRect.top >= parentRect.top &&
						rowRect.bottom <= parentRect.bottom;
					if (!isVisible) {
						treeRow.style.scrollMarginTop = "20px";
						treeRow.scrollIntoView({ behavior: "smooth", block: "start" });
					}
				}
			}
		},
		[engine, moduleIndex, formIndex, questionPath, questionUuid],
	);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			if (moduleIndex === undefined || formIndex === undefined) return;
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
			 * navigateTo calls with two scrollTo targets, the second missing the
			 * collapsing panel compensation from the first. */
			const closestWrapper = target.closest("[data-question-wrapper]");
			if (closestWrapper && closestWrapper !== e.currentTarget) return;
			/* Let clicks on text-editable zones pass through — select the question
			 * but don't stop propagation so TextEditable's handler also fires.
			 * Pass hasToolbar so the scroll leaves clearance for the floating
			 * TipTap label toolbar that will render above the question.
			 *
			 * If the question is already selected, navigateTo won't trigger a
			 * re-render (selection unchanged), so fulfillPendingScroll never
			 * fires. Call scrollToQuestion directly to ensure the toolbar gets
			 * clearance when activating a text editor on the current question. */
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
		[moduleIndex, formIndex, selectQuestion, isSelected, questionUuid, engine],
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
