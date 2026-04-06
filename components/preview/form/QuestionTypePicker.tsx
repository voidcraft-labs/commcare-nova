"use client";
import {
	autoUpdate,
	FloatingPortal,
	flip,
	offset,
	shift,
	useFloating,
} from "@floating-ui/react";
import { useCallback } from "react";
import { QuestionTypeGrid } from "@/components/builder/QuestionTypeGrid";
import {
	useAssembledForm,
	useBuilderEngine,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { useContentPopoverDismiss } from "@/hooks/useContentPopover";
import { useDismissRef } from "@/hooks/useDismissRef";
import { useEditContext } from "@/hooks/useEditContext";
import type { Question } from "@/lib/schemas/blueprint";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";

interface QuestionTypePickerProps {
	anchorEl: HTMLElement;
	atIndex: number;
	parentPath?: QuestionPath;
	onClose: () => void;
}

export function QuestionTypePicker({
	anchorEl,
	atIndex,
	parentPath,
	onClose,
}: QuestionTypePickerProps) {
	const ctx = useEditContext();
	if (!ctx) throw new Error("QuestionTypePicker requires EditContext");
	const { moduleIndex, formIndex } = ctx;
	const engine = useBuilderEngine();
	const assembledForm = useAssembledForm(moduleIndex, formIndex);
	const addQuestionAction = useBuilderStore((s) => s.addQuestion);
	if (!assembledForm)
		throw new Error("QuestionTypePicker requires a valid form");
	const dismissRef = useDismissRef(onClose);
	useContentPopoverDismiss(onClose);

	const { refs, floatingStyles } = useFloating({
		placement: "bottom",
		middleware: [offset(8), flip(), shift({ padding: 8 })],
		elements: { reference: anchorEl },
		whileElementsMounted: autoUpdate,
	});

	const composedRef = useCallback(
		(el: HTMLDivElement | null) => {
			refs.setFloating(el);
			if (!el) return;
			const cleanup = dismissRef(el);
			return () => {
				cleanup?.();
				refs.setFloating(null as unknown as HTMLDivElement);
			};
		},
		[refs, dismissRef],
	);

	const handleSelect = (type: Question["type"]) => {
		/* Generate unique ID by scanning existing question IDs in the form. */
		const existingIds = new Set<string>();
		const collectIds = (qs: Question[]) => {
			for (const q of qs) {
				existingIds.add(q.id);
				if (q.children) collectIds(q.children);
			}
		};
		if (assembledForm.questions) collectIds(assembledForm.questions);

		let newId = `new_${type}`;
		if (existingIds.has(newId)) {
			let counter = 2;
			while (existingIds.has(`new_${type}_${counter}`)) counter++;
			newId = `new_${type}_${counter}`;
		}

		const isSelect = type === "single_select" || type === "multi_select";
		const defaultOptions = isSelect
			? [
					{ value: "option_1", label: "Option 1" },
					{ value: "option_2", label: "Option 2" },
				]
			: undefined;
		const newUuid = addQuestionAction(
			moduleIndex,
			formIndex,
			{ id: newId, type, label: "New Question", options: defaultOptions },
			{ atIndex, parentPath },
		);
		const newPath = qpath(newId, parentPath);
		engine.markNewQuestion(newUuid);
		engine.navigateTo({
			type: "question",
			moduleIndex,
			formIndex,
			questionPath: newPath,
			questionUuid: newUuid,
		});
		onClose();
	};

	return (
		<FloatingPortal>
			<div
				ref={composedRef}
				role="dialog"
				aria-label="Choose question type"
				style={floatingStyles}
				className="z-popover-top"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (e.key === "Escape") onClose();
				}}
			>
				<QuestionTypeGrid onSelect={handleSelect} />
			</div>
		</FloatingPortal>
	);
}
