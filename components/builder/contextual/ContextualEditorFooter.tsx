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
import { useCallback } from "react";
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
import { getQuestionMoveTargets } from "@/lib/services/questionNavigation";
import { flattenQuestionRefs } from "@/lib/services/questionPath";
import { POPOVER_ELEVATED } from "@/lib/styles";
import type { FocusableFieldKey, QuestionEditorProps } from "./shared";
import { useFocusHint } from "./shared";

/** Field keys owned by the Footer — only "id" for undo/redo focus hints. */
const FOOTER_FIELDS = new Set<FocusableFieldKey>(["id"]);

/** Platform-aware modifier glyph for shortcut hints. */
const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";

/* ── Shared menu item styles ─────────────────────────────────────────── */

/** Base classes shared by every menu item (normal, disabled, submenu trigger). */
const MENU_ITEM_BASE =
	"flex w-full items-center gap-2.5 px-3 py-2 text-sm outline-none select-none transition-colors";

/** Interactive item: violet highlight on hover/keyboard focus. */
const MENU_ITEM_CLS = `${MENU_ITEM_BASE} text-nova-text cursor-pointer data-[highlighted]:bg-white/[0.06]`;

/** Disabled item: muted and non-interactive. */
const MENU_ITEM_DISABLED_CLS = `${MENU_ITEM_BASE} opacity-40 cursor-not-allowed`;

/** Positioner — carries the glass surface because Base UI's positioner sets
 *  `will-change: transform` which creates a compositing layer. `backdrop-filter`
 *  on a descendant would only sample that empty layer, not the page behind it.
 *  Placing the glass here means the blur samples correctly. */
const POSITIONER_CLS =
	"outline-none z-popover-top rounded-xl bg-[rgba(10,10,26,0.4)] backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)] outline-[rgba(255,255,255,0.06)] outline-1 shadow-[inset_0_0_0_1px_rgba(200,200,255,0.18),0_24px_48px_rgba(0,0,0,0.5)]";

/** Popup — animation only, no surface (positioner owns the glass). */
const POPUP_CLS =
	"overflow-hidden rounded-xl origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0";

export function ContextualEditorFooter({ question }: QuestionEditorProps) {
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
	const focusHint = useFocusHint(FOOTER_FIELDS);

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
	const conversionTargets = getConvertibleTypes(question.type);
	const canConvert = conversionTargets.length > 0;
	const typeIcon = questionTypeIcons[question.type];
	const typeLabel = questionTypeLabels[question.type] ?? question.type;

	return (
		<div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.06]">
			{/* Left: joined type icon + ID input — the icon acts as a
			 *  leading adornment inside the input's visual boundary. */}
			<div className="relative flex items-center min-w-0" data-field-id="id">
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
							className={POSITIONER_CLS}
							sideOffset={4}
							align="end"
						>
							<Menu.Popup className={POPUP_CLS} style={{ minWidth: 200 }}>
								{/* Move Up */}
								<MenuItem
									icon={tablerArrowUp}
									label="Move Up"
									shortcut="↑"
									disabled={isFirst}
									onClick={handleMoveUp}
								/>

								{/* Move Down */}
								<MenuItem
									icon={tablerArrowDown}
									label="Move Down"
									shortcut="↓"
									disabled={isLast}
									onClick={handleMoveDown}
								/>

								<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />

								{/* Convert Type — submenu with QuestionTypeGrid */}
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
												className="outline-none z-popover-top"
												sideOffset={4}
											>
												<Menu.Popup className="origin-[var(--transform-origin)] transition-[transform,scale,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
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
