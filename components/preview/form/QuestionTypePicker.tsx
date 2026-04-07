"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useCallback } from "react";
import {
	useAssembledForm,
	useBuilderEngine,
	useBuilderStore,
} from "@/hooks/useBuilder";
import { useEditContext } from "@/hooks/useEditContext";
import {
	INSERTION_CATEGORIES,
	INSERTION_TOP_LEVEL,
	questionTypeIcons,
	questionTypeLabels,
} from "@/lib/questionTypeIcons";
import type { Question } from "@/lib/schemas/blueprint";
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
 * Must be rendered as a child of a `Menu.Root` — the parent (`InsertionPoint`)
 * owns the root and trigger so that Base UI's `FloatingTreeStore` is initialised
 * correctly, allowing submenus to register as tree children and preventing
 * spurious dismiss events during submenu hover transitions.
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
	const assembledForm = useAssembledForm(moduleIndex, formIndex);
	const addQuestionAction = useBuilderStore((s) => s.addQuestion);
	if (!assembledForm)
		throw new Error("QuestionTypePickerPopup requires a valid form");

	/** Generate a unique ID, create the question, and navigate to it.
	 *  The menu closes automatically via Base UI's `closeOnClick` after
	 *  this handler returns — no manual close needed. */
	const handleSelect = useCallback(
		(type: Question["type"]) => {
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
		},
		[
			assembledForm,
			moduleIndex,
			formIndex,
			atIndex,
			parentPath,
			addQuestionAction,
			engine,
		],
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
