"use client";
import { useCallback } from "react";
import { Icon } from "@iconify/react/offline";
import ciArrowUpMd from "@iconify-icons/ci/arrow-up-md";
import ciArrowDownMd from "@iconify-icons/ci/arrow-down-md";
import ciCopy from "@iconify-icons/ci/copy";
import ciTrashFull from "@iconify-icons/ci/trash-full";
import ciChevronDown from "@iconify-icons/ci/chevron-down";
import type { IconifyIcon } from "@iconify/react/offline";
import { flattenQuestionPaths } from "@/lib/services/questionNavigation";
import type { QuestionPath } from "@/lib/services/questionPath";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import { getConvertibleTypes } from "@/lib/questionTypeConversions";
import { QuestionTypeGrid } from "@/components/builder/QuestionTypeGrid";
import {
	useFloatingDropdown,
	DropdownPortal,
} from "@/hooks/useFloatingDropdown";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { QuestionEditorProps } from "./shared";

export function ContextualEditorFooter({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected!;
	const mb = builder.mb!;

	const form =
		selected.formIndex !== undefined
			? mb.getForm(selected.moduleIndex, selected.formIndex)
			: null;
	const paths = form ? flattenQuestionPaths(form.questions) : [];
	const curIdx = paths.indexOf(selected.questionPath as QuestionPath);
	const isFirst = curIdx <= 0;
	const isLast = curIdx < 0 || curIdx >= paths.length - 1;

	const saveQuestion = useSaveQuestion(builder);
	const conversionTargets = getConvertibleTypes(question.type);
	const canConvert = conversionTargets.length > 0;

	/* Opens upward since the footer sits at the bottom of the panel */
	const typePicker = useFloatingDropdown<HTMLButtonElement>({
		placement: "top-start",
		offset: 4,
	});

	const handleMoveUp = useCallback(() => {
		if (isFirst || selected.formIndex === undefined || !selected.questionPath)
			return;
		mb.moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ beforePath: paths[curIdx - 1] },
		);
		builder.notifyBlueprintChanged();
	}, [mb, selected, paths, curIdx, isFirst, builder]);

	const handleMoveDown = useCallback(() => {
		if (isLast || selected.formIndex === undefined || !selected.questionPath)
			return;
		mb.moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ afterPath: paths[curIdx + 1] },
		);
		builder.notifyBlueprintChanged();
	}, [mb, selected, paths, curIdx, isLast, builder]);

	const handleDuplicate = useCallback(() => {
		if (selected.formIndex === undefined || !selected.questionPath) return;
		const newPath = mb.duplicateQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		builder.notifyBlueprintChanged();
		builder.select({
			type: "question",
			moduleIndex: selected.moduleIndex,
			formIndex: selected.formIndex,
			questionPath: newPath,
		});
	}, [mb, selected, builder]);

	const handleDelete = useCallback(() => {
		if (selected.formIndex === undefined || !selected.questionPath) return;
		const nextPath = paths[curIdx + 1] ?? paths[curIdx - 1];
		mb.removeQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		builder.notifyBlueprintChanged();
		if (nextPath) {
			builder.select({
				type: "question",
				moduleIndex: selected.moduleIndex,
				formIndex: selected.formIndex!,
				questionPath: nextPath,
			});
		} else {
			builder.select();
		}
	}, [mb, selected, builder, paths, curIdx]);

	const typeIcon = questionTypeIcons[question.type];
	const typeLabel = questionTypeLabels[question.type] ?? question.type;

	return (
		<div className="flex items-center justify-between px-2 py-1.5 border-t border-white/[0.06]">
			<div className="flex items-center gap-0.5">
				<FooterButton
					icon={ciArrowUpMd}
					title="Move Up"
					onClick={handleMoveUp}
					disabled={isFirst}
				/>
				<FooterButton
					icon={ciArrowDownMd}
					title="Move Down"
					onClick={handleMoveDown}
					disabled={isLast}
				/>
			</div>

			<button
				type="button"
				ref={typePicker.triggerRef}
				onClick={typePicker.toggle}
				disabled={!canConvert}
				title={
					canConvert
						? "Change type"
						: "Can't change type — remove and add a new question instead"
				}
				aria-haspopup="true"
				aria-expanded={typePicker.open}
				className={`flex items-center gap-1.5 px-2 h-7 rounded-md text-xs transition-colors
          ${
						canConvert
							? "text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] cursor-pointer"
							: "text-nova-text-muted/30 cursor-not-allowed"
					}`}
			>
				{typeIcon && (
					<Icon icon={typeIcon} width="14" height="14" className="shrink-0" />
				)}
				<span>{typeLabel}</span>
				{canConvert && (
					<Icon
						icon={ciChevronDown}
						width="12"
						height="12"
						className="shrink-0 opacity-50"
					/>
				)}
			</button>
			{canConvert && (
				<DropdownPortal
					dropdown={typePicker}
					className="z-popover-top"
					onClick={(e) => e.stopPropagation()}
				>
					<QuestionTypeGrid
						types={conversionTargets}
						variant="elevated"
						onSelect={(type) => {
							saveQuestion("type", type);
							typePicker.close();
						}}
					/>
				</DropdownPortal>
			)}

			<div className="flex items-center gap-0.5">
				<FooterButton
					icon={ciCopy}
					title="Duplicate"
					onClick={handleDuplicate}
				/>
				<FooterButton
					icon={ciTrashFull}
					title="Delete"
					onClick={handleDelete}
					destructive
				/>
			</div>
		</div>
	);
}

function FooterButton({
	icon,
	title,
	onClick,
	disabled,
	destructive,
}: {
	icon: IconifyIcon;
	title: string;
	onClick: () => void;
	disabled?: boolean;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={title}
			className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer
        ${
					disabled
						? "text-nova-text-muted/30 cursor-not-allowed"
						: destructive
							? "text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10"
							: "text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06]"
				}`}
		>
			<Icon icon={icon} width="16" height="16" />
		</button>
	);
}
