"use client";
import { type ReactNode, useCallback, useRef, useState } from "react";
import {
	useBuilderEngine,
	useBuilderStore,
	useIsQuestionSelected,
} from "@/hooks/useBuilder";
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
	const cursorMode = useBuilderStore((s) => s.cursorMode);
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

	/** Select this question in the builder and scroll its tree row into view. */
	const selectQuestion = useCallback(() => {
		if (moduleIndex === undefined || formIndex === undefined) return;
		engine.navigateTo({
			type: "question",
			moduleIndex,
			formIndex,
			questionPath,
			questionUuid,
		});
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
					rowRect.top >= parentRect.top && rowRect.bottom <= parentRect.bottom;
				if (!isVisible) {
					treeRow.style.scrollMarginTop = "20px";
					treeRow.scrollIntoView({ behavior: "smooth", block: "start" });
				}
			}
		}
	}, [engine, moduleIndex, formIndex, questionPath, questionUuid]);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			if (moduleIndex === undefined || formIndex === undefined) return;
			// Ignore clicks from portal-rendered elements (e.g. QuestionTypePicker FloatingPortal).
			// React synthetic events still bubble through the React tree from portals,
			// but the DOM target is outside this wrapper's subtree.
			const target = e.target as HTMLElement;
			if (!e.currentTarget.contains(target)) return;
			// Don't intercept clicks inside the inline settings panel, nested wrappers, or insertion points
			if (target.closest("[data-no-drag]")) return;
			if (target.closest("[data-insertion-point]")) return;
			const closestWrapper = target.closest("[data-question-wrapper]");
			if (closestWrapper && closestWrapper !== e.currentTarget) return;
			e.stopPropagation();
			selectQuestion();
		},
		[moduleIndex, formIndex, selectQuestion],
	);

	/** Keyboard activation — Enter or Space selects this question, matching
	 *  the click behavior for keyboard-only users (role="button" contract). */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
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

	/* Text mode: no outlines, no click capture. Children are fully interactive
	 * so TextEditable instances receive clicks directly. text-mode-cursors
	 * overlays non-text surfaces to suppress interactivity. */
	if (cursorMode === "text") {
		return (
			<div className="text-mode-cursors" style={style}>
				{children}
			</div>
		);
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
