"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import { useCallback } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { CASE_FORM_TYPES, type FormType } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

const formTypeOptions: { value: FormType; label: string }[] = [
	{ value: "registration", label: "Registration" },
	{ value: "followup", label: "Followup" },
	{ value: "close", label: "Close" },
	{ value: "survey", label: "Survey" },
];

interface FormDetailProps {
	/** Module uuid to look up module-level context (case type). */
	moduleUuid: Uuid;
	/** Form uuid to look up the form entity. */
	formUuid: Uuid;
}

/**
 * Read-only close condition info within FormSettingsPanel.
 * Renders only when the form is a close form — shows conditional vs unconditional.
 */
export function FormDetail({ formUuid }: FormDetailProps) {
	const form = useForm(formUuid);
	if (form?.type !== "close") return null;

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
				Close Behavior
			</span>
			<p className="text-sm text-nova-rose">
				{form.closeCondition?.field
					? `Conditional: when ${form.closeCondition.field} ${form.closeCondition.operator === "selected" ? "has selected" : "is"} "${form.closeCondition.answer}"`
					: "Always closes case on submit"}
			</p>
		</div>
	);
}

// ── Form Type Button (for FormScreen header) ──────────────────────────

interface FormTypeButtonProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
	/** When false, renders as a static icon (no dropdown). */
	editable?: boolean;
}

/**
 * Form type icon in the form header. Interactive (menu to change type)
 * when editable, static icon otherwise. Uses Base UI Menu for proper
 * keyboard navigation and ARIA roles.
 */
export function FormTypeButton({
	moduleUuid,
	formUuid,
	editable = false,
}: FormTypeButtonProps) {
	const form = useForm(formUuid);
	const mod = useModule(moduleUuid);
	const { updateForm } = useBlueprintMutations();

	const handleSelect = useCallback(
		(type: string) => {
			if (!editable) return;
			updateForm(asUuid(formUuid), {
				type: type as FormType,
			});
		},
		[editable, updateForm, formUuid],
	);

	const icon = formTypeIcons[form?.type ?? "survey"];
	const hasCaseType = editable && !!mod?.caseType;
	const activeType = form?.type ?? "survey";
	const last = formTypeOptions.length - 1;

	return (
		<>
			{editable ? (
				<Menu.Root>
					<Menu.Trigger
						className="-ml-1.5 p-1.5 rounded-md shrink-0 text-nova-text-muted transition-colors cursor-pointer hover:text-nova-text hover:bg-white/5"
						aria-label="Change form type"
					>
						<Icon icon={icon} width="18" height="18" />
					</Menu.Trigger>

					<Menu.Portal>
						<Menu.Positioner
							side="bottom"
							align="start"
							sideOffset={4}
							className={MENU_POSITIONER_CLS}
						>
							<Menu.Popup className={MENU_POPUP_CLS}>
								{formTypeOptions.map((opt, i) => {
									const needsCase =
										CASE_FORM_TYPES.has(opt.value) && !hasCaseType;
									const isActive = opt.value === activeType;
									/* First/last items inherit the container's border radius so
									 * their hover/active backgrounds tile flush. */
									const corners =
										i === 0 && i === last
											? "rounded-xl"
											: i === 0
												? "rounded-t-xl"
												: i === last
													? "rounded-b-xl"
													: "";

									const item = (
										<Menu.Item
											key={opt.value}
											disabled={needsCase}
											onClick={() => handleSelect(opt.value)}
											className={`${corners} ${
												needsCase
													? MENU_ITEM_DISABLED_CLS
													: isActive
														? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
														: MENU_ITEM_CLS
											}`}
										>
											<span
												className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-nova-violet" : "bg-transparent"}`}
											/>
											<Icon
												icon={formTypeIcons[opt.value]}
												width="16"
												height="16"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left">{opt.label}</span>
										</Menu.Item>
									);

									return needsCase ? (
										<Tooltip
											key={opt.value}
											content="Requires a case type on this module"
											placement="right"
										>
											{item}
										</Tooltip>
									) : (
										item
									);
								})}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			) : (
				<span className="-ml-1.5 p-1.5 text-nova-text-muted shrink-0">
					<Icon icon={icon} width="18" height="18" />
				</span>
			)}
		</>
	);
}
