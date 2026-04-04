"use client";
import { useCallback } from "react";
import {
	useFloating,
	offset,
	flip,
	shift,
	autoUpdate,
	FloatingPortal,
} from "@floating-ui/react";
import { useEditContext } from "@/hooks/useEditContext";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import { useDismissRef } from "@/hooks/useDismissRef";
import { useContentPopoverDismiss } from "@/hooks/useContentPopover";
import type { Question } from "@/lib/schemas/blueprint";
import { QuestionTypeGrid } from "@/components/builder/QuestionTypeGrid";

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
	const ctx = useEditContext()!;
	const { builder, moduleIndex, formIndex } = ctx;
	const mb = builder.mb!;
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
		// Generate unique ID
		const form = mb.getForm(moduleIndex, formIndex);
		const existingIds = new Set<string>();
		const collectIds = (qs: any[]) => {
			for (const q of qs) {
				existingIds.add(q.id);
				if (q.children) collectIds(q.children);
			}
		};
		if (form?.questions) collectIds(form.questions);

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
		mb.addQuestion(
			moduleIndex,
			formIndex,
			{ id: newId, type, label: "New Question", options: defaultOptions },
			{ atIndex, parentPath },
		);
		builder.notifyBlueprintChanged();
		const newPath = qpath(newId, parentPath);
		builder.markNewQuestion(newPath);
		builder.select({
			type: "question",
			moduleIndex,
			formIndex,
			questionPath: newPath,
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
