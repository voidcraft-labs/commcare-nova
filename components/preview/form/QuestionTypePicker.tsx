"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useCallback } from "react";
import { useBuilderEngine } from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	INSERTION_CATEGORIES,
	INSERTION_TOP_LEVEL,
	questionTypeIcons,
	questionTypeLabels,
} from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";
import { assembleForm } from "@/lib/services/normalizedState";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";

interface QuestionTypePickerPopupProps {
	/** Insertion index within the parent's children array. */
	atIndex: number;
	/** Parent path for nested questions (inside groups/repeats). */
	parentPath?: QuestionPath;
}

/**
 * Popup content for the question insertion menu.
 *
 * Renders the portal, positioner, popup shell, and categorised menu items.
 * Rendered as a child of the shared `Menu.Root` in `FormRenderer` — each
 * `InsertionPoint` sends its context (`atIndex`, `parentPath`) as payload
 * via detached `Menu.Trigger`s connected through `Menu.createHandle()`.
 * Base UI's `FloatingTreeStore` is initialised by the root `Menu.Root`,
 * allowing submenus to register as tree children and preventing spurious
 * dismiss events during submenu hover transitions.
 *
 * Menu close is handled automatically by `Menu.Item`'s `closeOnClick` default —
 * no explicit close callback is needed.
 */
export function QuestionTypePickerPopup({
	atIndex,
	parentPath,
}: QuestionTypePickerPopupProps) {
	const ctx = useEditContext();
	if (!ctx) throw new Error("QuestionTypePickerPopup requires EditContext");
	const { moduleIndex, formIndex } = ctx;
	const engine = useBuilderEngine();
	const { addQuestion: addQuestionAction } = useBlueprintMutations();

	/** Generate a unique ID, create the question, and navigate to it.
	 *  Reads the assembled form imperatively at insert time — avoids 28
	 *  reactive subscriptions to entity maps that would fire on every
	 *  unrelated question edit (~56ms wasted per commit). */
	const handleSelect = useCallback(
		(type: Question["type"]) => {
			/* Assemble the current form from store state at call time. */
			const s = engine.store.getState();
			const moduleId = s.moduleOrder[moduleIndex];
			if (!moduleId) return;
			const formId = s.formOrder[moduleId]?.[formIndex];
			if (!formId) return;
			const form = s.forms[formId];
			if (!form) return;
			const assembled = assembleForm(
				form,
				formId,
				s.questions,
				s.questionOrder,
			);

			const existingIds = new Set<string>();
			const collectIds = (qs: Question[]) => {
				for (const q of qs) {
					existingIds.add(q.id);
					if (q.children) collectIds(q.children);
				}
			};
			if (assembled.questions) collectIds(assembled.questions);

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
		},
		[moduleIndex, formIndex, atIndex, parentPath, addQuestionAction, engine],
	);

	return (
		<Menu.Portal>
			<Menu.Positioner
				className={MENU_POSITIONER_CLS}
				sideOffset={8}
				collisionPadding={8}
			>
				<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 192 }}>
					{/* ── Category submenus ── */}
					{INSERTION_CATEGORIES.map((cat) => (
						<Menu.SubmenuRoot key={cat.label}>
							<Menu.SubmenuTrigger className={MENU_ITEM_CLS}>
								<Icon
									icon={cat.icon}
									width="16"
									height="16"
									className="text-nova-text-muted shrink-0"
								/>
								<span className="flex-1 text-left">{cat.label}</span>
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
										{cat.types.map((type) => (
											<TypeMenuItem
												key={type}
												type={type}
												onSelect={handleSelect}
											/>
										))}
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
					))}

					<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />

					{/* ── Top-level items (no submenu) ── */}
					{INSERTION_TOP_LEVEL.map((type) => (
						<TypeMenuItem key={type} type={type} onSelect={handleSelect} />
					))}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

/* ── Reusable menu item for a single question type ─────────────────────── */

function TypeMenuItem({
	type,
	onSelect,
}: {
	type: Question["type"];
	onSelect: (type: Question["type"]) => void;
}) {
	const icon = questionTypeIcons[type];
	const label = questionTypeLabels[type] ?? type;
	return (
		<Menu.Item className={MENU_ITEM_CLS} onClick={() => onSelect(type)}>
			{icon && (
				<Icon
					icon={icon}
					width="16"
					height="16"
					className="text-nova-text-muted shrink-0"
				/>
			)}
			<span>{label}</span>
		</Menu.Item>
	);
}
