"use client";
import { Menu } from "@base-ui/react/menu";
import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerArrowsExchange from "@iconify-icons/tabler/arrows-exchange";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useEffect, useState } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { QuestionTypeList } from "@/components/builder/QuestionTypeList";
import { tablerCopyPlus } from "@/components/icons/tablerExtras";
import { Tooltip } from "@/components/ui/Tooltip";
import {
	useAssembledForm,
	useBuilderEngine,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { useCommitField } from "@/hooks/useCommitField";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import { getConvertibleTypes } from "@/lib/questionTypeConversions";
import { questionTypeIcons, questionTypeLabels } from "@/lib/questionTypeIcons";
import {
	type CrossLevelMoveTarget,
	getCrossLevelMoveTargets,
	getQuestionMoveTargets,
} from "@/lib/services/questionNavigation";
import {
	flattenQuestionRefs,
	qpath,
	qpathId,
} from "@/lib/services/questionPath";
import {
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import type { FocusableFieldKey, QuestionEditorProps } from "./shared";
import { useFocusHint } from "./shared";

/** Field keys owned by the Header — only "id" for undo/redo focus hints. */
const HEADER_FIELDS = new Set<FocusableFieldKey>(["id"]);

/** Platform-aware modifier glyph for shortcut hints. */
const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

/* Menu style constants (MENU_ITEM_CLS, MENU_ITEM_DISABLED_CLS,
 * MENU_POSITIONER_CLS, MENU_POPUP_CLS) imported from lib/styles.ts. */

/** Track whether the Shift key is currently held. Resets on window blur
 *  so a tab-switch doesn't leave a phantom pressed state. */
function useShiftKey(): boolean {
	const [shift, setShift] = useState(false);
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(true);
		};
		const up = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(false);
		};
		const blur = () => setShift(false);
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", blur);
		};
	}, []);
	return shift;
}

export function ContextualEditorHeader({ question }: QuestionEditorProps) {
	const engine = useBuilderEngine();
	const selected = useBuilderStore((s) => s.selected);
	const moveQuestion = useBuilderStore((s) => s.moveQuestion);
	const duplicateQuestion = useBuilderStore((s) => s.duplicateQuestion);
	const removeQuestion = useBuilderStore((s) => s.removeQuestion);
	const renameQuestionAction = useBuilderStore((s) => s.renameQuestion);
	const assembledForm = useAssembledForm(
		selected?.moduleIndex ?? 0,
		selected?.formIndex ?? 0,
	);

	const saveQuestion = useSaveQuestion();
	const focusHint = useFocusHint(HEADER_FIELDS);
	const shiftHeld = useShiftKey();

	/* ── ID rename ── */

	const handleRename = useCallback(
		(newId: string) => {
			if (
				!selected ||
				selected.formIndex === undefined ||
				!selected.questionPath ||
				!newId
			)
				return;
			const { newPath } = renameQuestionAction(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				newId,
			);
			engine.select({ ...selected, questionPath: newPath });
			engine.clearNewQuestion();
		},
		[selected, renameQuestionAction, engine],
	);

	const idField = useCommitField({
		value: question.id,
		onSave: handleRename,
	});

	/** Callback ref for the ID input — merges the commit hook ref with
	 *  autoFocus behavior for undo/redo focus restoration and new questions. */
	const setIdInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			idField.ref(el);
			const shouldAutoFocus =
				focusHint === "id" ||
				(!!selected?.questionUuid &&
					engine.isNewQuestion(selected.questionUuid));
			if (el && shouldAutoFocus) {
				el.focus({ preventScroll: true });
				el.select();
			}
		},
		[idField.ref, focusHint, selected?.questionUuid, engine],
	);

	/* ── Action handlers ── */

	const handleMoveUp = useCallback(() => {
		if (
			!selected ||
			selected.formIndex === undefined ||
			!selected.questionPath ||
			!assembledForm
		)
			return;
		const { beforePath } = getQuestionMoveTargets(
			assembledForm.questions,
			selected.questionPath,
		);
		if (!beforePath) return;
		moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ beforePath },
		);
	}, [selected, assembledForm, moveQuestion]);

	const handleMoveDown = useCallback(() => {
		if (
			!selected ||
			selected.formIndex === undefined ||
			!selected.questionPath ||
			!assembledForm
		)
			return;
		const { afterPath } = getQuestionMoveTargets(
			assembledForm.questions,
			selected.questionPath,
		);
		if (!afterPath) return;
		moveQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			{ afterPath },
		);
	}, [selected, assembledForm, moveQuestion]);

	/** Execute a cross-level move and update selection to the new path. */
	const executeCrossLevel = useCallback(
		(target: CrossLevelMoveTarget) => {
			if (
				!selected ||
				selected.formIndex === undefined ||
				!selected.questionPath
			)
				return;
			const { direction: _, ...opts } = target;
			moveQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				opts,
			);
			const newPath = qpath(
				qpathId(selected.questionPath),
				target.targetParentPath,
			);
			engine.navigateTo({ ...selected, questionPath: newPath });
		},
		[selected, moveQuestion, engine],
	);

	const handleDuplicate = useCallback(() => {
		if (!selected || selected.formIndex === undefined || !selected.questionPath)
			return;
		const { newPath, newUuid } = duplicateQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		engine.navigateTo({
			type: "question",
			moduleIndex: selected.moduleIndex,
			formIndex: selected.formIndex,
			questionPath: newPath,
			questionUuid: newUuid,
		});
	}, [selected, duplicateQuestion, engine]);

	const handleDelete = useCallback(() => {
		if (
			!selected ||
			selected.formIndex === undefined ||
			!selected.questionPath ||
			!assembledForm
		)
			return;
		const refs = flattenQuestionRefs(assembledForm.questions);
		const curIdx = refs.findIndex((r) => r.uuid === selected.questionUuid);
		const next = refs[curIdx + 1] ?? refs[curIdx - 1];
		removeQuestion(
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
		);
		if (next) {
			engine.navigateTo({
				type: "question",
				moduleIndex: selected.moduleIndex,
				formIndex: selected.formIndex,
				questionPath: next.path,
				questionUuid: next.uuid,
			});
		} else {
			engine.select();
		}
	}, [selected, assembledForm, removeQuestion, engine]);

	if (!selected || !assembledForm) return null;

	/* Compute adjacency inline so isFirst/isLast always reflect the current
	 * state. Re-derives when the assembled form reference changes (i.e.,
	 * after a mutation updates normalized entities). */
	const { beforePath, afterPath } = selected.questionPath
		? getQuestionMoveTargets(assembledForm.questions, selected.questionPath)
		: { beforePath: undefined, afterPath: undefined };
	const isFirst = beforePath === undefined;
	const isLast = afterPath === undefined;

	/* Cross-level (indent/outdent) targets — shown when Shift is held. */
	const { up: crossUp, down: crossDown } = selected.questionPath
		? getCrossLevelMoveTargets(assembledForm.questions, selected.questionPath)
		: { up: undefined, down: undefined };

	const conversionTargets = getConvertibleTypes(question.type);
	const canConvert = conversionTargets.length > 0;
	const typeIcon = questionTypeIcons[question.type];
	const typeLabel = questionTypeLabels[question.type] ?? question.type;

	return (
		<div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.06]">
			{/* Left: joined type icon + ID input — the icon acts as a
			 *  leading adornment inside the input's visual boundary. */}
			<div
				className="relative flex flex-col gap-1.5 min-w-0"
				data-field-id="id"
			>
				{/* Micro-label — same vocabulary as SectionLabel but inline-compact. */}
				<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/60 pl-0.5 select-none">
					Question ID
				</span>
				<div className="relative flex items-center">
					<div
						className={`flex items-center rounded-md border outline-none transition-colors ${
							idField.focused
								? "bg-nova-surface border-nova-violet/50 shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
								: "bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
						}`}
					>
						{/* Icon adornment — violet-tinted badge flush with the input */}
						<Tooltip content={typeLabel} placement="bottom">
							<span className="flex items-center justify-center w-9 h-9 shrink-0 text-nova-violet-bright border-r border-white/[0.06] rounded-l-md bg-nova-violet/10">
								{typeIcon && <Icon icon={typeIcon} width="16" height="16" />}
							</span>
						</Tooltip>
						<input
							ref={setIdInputRef}
							value={idField.draft}
							onChange={(e) => idField.setDraft(e.target.value)}
							onFocus={idField.handleFocus}
							onBlur={idField.handleBlur}
							onKeyDown={idField.handleKeyDown}
							className="w-full text-sm font-mono px-2 py-1.5 bg-transparent text-nova-text font-medium outline-none cursor-text"
							autoComplete="off"
							data-1p-ignore
						/>
					</div>
					<SavedCheck
						visible={idField.saved && !idField.focused}
						size={12}
						className="absolute right-1.5 shrink-0"
					/>
				</div>
			</div>

			{/* Right: delete button + overflow dots menu (Base UI) */}
			<div className="flex items-center gap-0.5 shrink-0">
				<Tooltip content="Delete" placement="bottom">
					<button
						type="button"
						onClick={handleDelete}
						aria-label="Delete"
						className="w-9 h-9 flex items-center justify-center rounded-md transition-colors text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10 cursor-pointer"
					>
						<Icon icon={tablerTrash} width="18" height="18" />
					</button>
				</Tooltip>

				<Menu.Root>
					<Menu.Trigger
						aria-label="More actions"
						className="w-9 h-9 flex items-center justify-center rounded-md transition-colors text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] cursor-pointer outline-none data-[popup-open]:bg-white/[0.06]"
					>
						<Icon icon={tablerDotsVertical} width="18" height="18" />
					</Menu.Trigger>

					<Menu.Portal>
						<Menu.Positioner
							className={MENU_POSITIONER_CLS}
							sideOffset={4}
							align="end"
						>
							<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 200 }}>
								{/* Move Up / cross-level up (Shift swaps) */}
								<MenuItem
									icon={tablerArrowUp}
									label={
										shiftHeld
											? crossUp?.direction === "into"
												? "Move Into Group"
												: "Move Out of Group"
											: "Move Up"
									}
									shortcut={shiftHeld ? "⇧↑" : "↑"}
									disabled={shiftHeld ? !crossUp : isFirst}
									onClick={
										shiftHeld
											? () => crossUp && executeCrossLevel(crossUp)
											: handleMoveUp
									}
								/>

								{/* Move Down / cross-level down (Shift swaps) */}
								<MenuItem
									icon={tablerArrowDown}
									label={
										shiftHeld
											? crossDown?.direction === "into"
												? "Move Into Group"
												: "Move Out of Group"
											: "Move Down"
									}
									shortcut={shiftHeld ? "⇧↓" : "↓"}
									disabled={shiftHeld ? !crossDown : isLast}
									onClick={
										shiftHeld
											? () => crossDown && executeCrossLevel(crossDown)
											: handleMoveDown
									}
								/>

								<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />

								{/* Convert Type — submenu with conversion targets */}
								{canConvert ? (
									<Menu.SubmenuRoot>
										<Menu.SubmenuTrigger className={MENU_ITEM_CLS}>
											<Icon
												icon={tablerArrowsExchange}
												width="16"
												height="16"
												className="text-nova-text-muted shrink-0"
											/>
											<span className="flex-1 text-left">Convert Type</span>
											<Icon
												icon={tablerChevronRight}
												width="14"
												height="14"
												className="text-nova-text-muted/50 shrink-0 -mr-0.5"
											/>
										</Menu.SubmenuTrigger>
										<Menu.Portal>
											<Menu.Positioner
												className={MENU_SUBMENU_POSITIONER_CLS}
												sideOffset={4}
											>
												<Menu.Popup className={MENU_POPUP_CLS}>
													<QuestionTypeList
														types={conversionTargets}
														activeType={question.type}
														onSelect={(type) => saveQuestion("type", type)}
													/>
												</Menu.Popup>
											</Menu.Positioner>
										</Menu.Portal>
									</Menu.SubmenuRoot>
								) : (
									<Tooltip content="Can't convert — remove and add a new question instead">
										<MenuItem
											icon={tablerArrowsExchange}
											label="Convert Type"
											disabled
											onClick={() => {}}
										/>
									</Tooltip>
								)}

								{/* Duplicate */}
								<MenuItem
									icon={tablerCopyPlus}
									label="Duplicate"
									shortcut={`${MOD}D`}
									onClick={handleDuplicate}
								/>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			</div>
		</div>
	);
}

// ── Reusable menu item ──────────────────────────────────────────────────

/** Single menu item with icon, label, and optional keyboard shortcut hint. */
function MenuItem({
	icon,
	label,
	shortcut,
	disabled,
	onClick,
}: {
	icon: IconifyIcon;
	label: string;
	shortcut?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Menu.Item
			disabled={disabled}
			onClick={disabled ? undefined : onClick}
			className={disabled ? MENU_ITEM_DISABLED_CLS : MENU_ITEM_CLS}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="text-nova-text-muted shrink-0"
			/>
			<span className="flex-1 text-left">{label}</span>
			{shortcut && (
				<kbd className="text-[10px] text-nova-text-muted/50 font-mono ml-4 shrink-0">
					{shortcut}
				</kbd>
			)}
		</Menu.Item>
	);
}
