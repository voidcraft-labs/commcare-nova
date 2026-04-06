"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerArrowsExchange from "@iconify-icons/tabler/arrows-exchange";
import tablerTrash from "@iconify-icons/tabler/trash";
import { type AriaAttributes, forwardRef, useCallback } from "react";
import { QuestionTypeGrid } from "@/components/builder/QuestionTypeGrid";
import { tablerCopyPlus } from "@/components/icons/tablerExtras";
import {
	DropdownPortal,
	useFloatingDropdown,
} from "@/hooks/useFloatingDropdown";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import { getConvertibleTypes } from "@/lib/questionTypeConversions";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import { getQuestionMoveTargets } from "@/lib/services/questionNavigation";
import { flattenQuestionRefs } from "@/lib/services/questionPath";
import type { QuestionEditorProps } from "./shared";

export function ContextualEditorFooter({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected;
	const mb = builder.mb;

	const saveQuestion = useSaveQuestion(builder);

	/* Opens downward since the control bar sits at the top of the panel. */
	const typePicker = useFloatingDropdown<HTMLButtonElement>({
		placement: "bottom-end",
		offset: 4,
	});

	/* Handlers resolve move targets fresh at call time — NOT from a useMemo.
	 * mb.moveQuestion mutates the blueprint in-place, so mb keeps the same
	 * object reference after a move. A useMemo keyed on [selected, mb] would
	 * never invalidate, leaving isFirst/isLast stale until the next unrelated
	 * re-render. Reading from the blueprint at call time is always correct. */
	const handleMoveUp = useCallback(() => {
		if (
			!selected ||
			!mb ||
			selected.formIndex === undefined ||
			!selected.questionPath
		)
			return;
		const form = mb.getForm(selected.moduleIndex, selected.formIndex);
		if (!form) return;
		const { beforePath } = getQuestionMoveTargets(
			form.questions,
			selected.questionPath,
		);
		if (!beforePath) return;
		mb.moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ beforePath },
		);
		builder.notifyBlueprintChanged();
	}, [mb, selected, builder]);

	const handleMoveDown = useCallback(() => {
		if (
			!selected ||
			!mb ||
			selected.formIndex === undefined ||
			!selected.questionPath
		)
			return;
		const form = mb.getForm(selected.moduleIndex, selected.formIndex);
		if (!form) return;
		const { afterPath } = getQuestionMoveTargets(
			form.questions,
			selected.questionPath,
		);
		if (!afterPath) return;
		mb.moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ afterPath },
		);
		builder.notifyBlueprintChanged();
	}, [mb, selected, builder]);

	const handleDuplicate = useCallback(() => {
		if (
			!selected ||
			!mb ||
			selected.formIndex === undefined ||
			!selected.questionPath
		)
			return;
		const { newPath, newUuid } = mb.duplicateQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		builder.notifyBlueprintChanged();
		builder.navigateTo({
			type: "question",
			moduleIndex: selected.moduleIndex,
			formIndex: selected.formIndex,
			questionPath: newPath,
			questionUuid: newUuid,
		});
	}, [mb, selected, builder]);

	const handleDelete = useCallback(() => {
		if (
			!selected ||
			!mb ||
			selected.formIndex === undefined ||
			!selected.questionPath
		)
			return;
		const form = mb.getForm(selected.moduleIndex, selected.formIndex);
		/* Use flattenQuestionRefs to navigate to the nearest visible question
		 * after deletion — visible questions are the natural navigation targets
		 * since hidden fields have no rendered surface to select. */
		const refs = form ? flattenQuestionRefs(form.questions) : [];
		const curIdx = refs.findIndex((r) => r.uuid === selected.questionUuid);
		const next = refs[curIdx + 1] ?? refs[curIdx - 1];
		mb.removeQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		builder.notifyBlueprintChanged();
		if (next) {
			builder.navigateTo({
				type: "question",
				moduleIndex: selected.moduleIndex,
				formIndex: selected.formIndex,
				questionPath: next.path,
				questionUuid: next.uuid,
			});
		} else {
			builder.select();
		}
	}, [mb, selected, builder]);

	if (!selected || !mb) return null;

	/* Compute adjacency inline so isFirst/isLast always reflect the current
	 * blueprint. Doing this in a useMemo would produce stale values because
	 * mb is mutated in-place — its reference never changes after a move. */
	const form =
		selected.formIndex !== undefined
			? mb.getForm(selected.moduleIndex, selected.formIndex)
			: null;
	const { beforePath, afterPath } =
		form && selected.questionPath
			? getQuestionMoveTargets(form.questions, selected.questionPath)
			: { beforePath: undefined, afterPath: undefined };
	const isFirst = beforePath === undefined;
	const isLast = afterPath === undefined;
	const conversionTargets = getConvertibleTypes(question.type);
	const canConvert = conversionTargets.length > 0;
	const typeIcon = questionTypeIcons[question.type];
	const typeLabel = questionTypeLabels[question.type] ?? question.type;

	return (
		<>
			<div className="flex items-center justify-between px-2 min-h-[52px] border-b border-white/[0.06]">
				<div className="flex items-center gap-0.5">
					<ControlButton
						icon={tablerArrowUp}
						title="Move Up"
						onClick={handleMoveUp}
						disabled={isFirst}
					/>
					<ControlButton
						icon={tablerArrowDown}
						title="Move Down"
						onClick={handleMoveDown}
						disabled={isLast}
					/>
				</div>

				{/* Type label — always visible, never interactive. Keeps the user
				    oriented to what kind of field they're editing. */}
				<div className="flex items-center gap-1.5 text-xs text-nova-text-muted pointer-events-none select-none">
					{typeIcon && (
						<Icon icon={typeIcon} width="18" height="18" className="shrink-0" />
					)}
					<span>{typeLabel}</span>
				</div>

				<div className="flex items-center gap-0.5">
					<ControlButton
						ref={typePicker.triggerRef}
						icon={tablerArrowsExchange}
						title={
							canConvert
								? "Convert type"
								: "Can't convert — remove and add a new question instead"
						}
						onClick={typePicker.toggle}
						disabled={!canConvert}
						aria-haspopup="true"
						aria-expanded={typePicker.open}
					/>
					<ControlButton
						icon={tablerCopyPlus}
						title="Duplicate"
						onClick={handleDuplicate}
					/>
					<ControlButton
						icon={tablerTrash}
						title="Delete"
						onClick={handleDelete}
						destructive
					/>
				</div>
			</div>

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
		</>
	);
}

/** Icon button for the control bar. 44×44px touch target with 20px icon. */
const ControlButton = forwardRef<
	HTMLButtonElement,
	{
		icon: IconifyIcon;
		title: string;
		onClick: () => void;
		disabled?: boolean;
		destructive?: boolean;
		"aria-haspopup"?: AriaAttributes["aria-haspopup"];
		"aria-expanded"?: AriaAttributes["aria-expanded"];
	}
>(function ControlButton(
	{ icon, title, onClick, disabled, destructive, ...ariaProps },
	ref,
) {
	return (
		<button
			ref={ref}
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={title}
			{...ariaProps}
			className={`w-11 h-11 flex items-center justify-center rounded-md transition-colors
        ${
					disabled
						? "text-nova-text-muted/30 cursor-not-allowed"
						: destructive
							? "text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10 cursor-pointer"
							: "text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] cursor-pointer"
				}`}
		>
			<Icon icon={icon} width="20" height="20" />
		</button>
	);
});
