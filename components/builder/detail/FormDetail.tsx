"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import { useCallback, useState } from "react";
import {
	DropdownMenu,
	type DropdownMenuItem,
} from "@/components/ui/DropdownMenu";
import { useBuilderStore, useForm, useModule } from "@/hooks/useBuilder";
import { formTypeIcons } from "@/lib/questionTypeIcons";
import { POPOVER_POPUP_CLS, POPOVER_POSITIONER_GLASS_CLS } from "@/lib/styles";

/** Form types that require a case type on the parent module to be selectable. */
const CASE_DEPENDENT_TYPES = new Set(["registration", "followup"]);

const formTypeOptions: { value: string; label: string }[] = [
	{ value: "registration", label: "Registration" },
	{ value: "followup", label: "Followup" },
	{ value: "survey", label: "Survey" },
];

interface FormDetailProps {
	/** Module index to look up the form entity. */
	moduleIndex: number;
	/** Form index to look up the form entity. */
	formIndex: number;
}

/**
 * Read-only close case info panel within FormSettingsPanel.
 * Renders only when the form has a close_case configuration.
 */
export function FormDetail({ moduleIndex, formIndex }: FormDetailProps) {
	const form = useForm(moduleIndex, formIndex);
	if (!form?.closeCase) return null;

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
				Close Case
			</span>
			<p className="text-sm text-nova-rose">
				{form.closeCase.question
					? `When ${form.closeCase.question} = "${form.closeCase.answer}"`
					: "Always (unconditional)"}
			</p>
		</div>
	);
}

// ── Form Type Button (for FormScreen header) ──────────────────────────

interface FormTypeButtonProps {
	moduleIndex: number;
	formIndex: number;
	/** When false, renders as a static icon (no dropdown). */
	editable?: boolean;
}

/**
 * Form type icon in the form header. Interactive (dropdown to change type)
 * when editable, static icon otherwise. Uses the Zustand store for mutations.
 */
export function FormTypeButton({
	moduleIndex,
	formIndex,
	editable = false,
}: FormTypeButtonProps) {
	const form = useForm(moduleIndex, formIndex);
	const mod = useModule(moduleIndex);
	const updateForm = useBuilderStore((s) => s.updateForm);
	const [open, setOpen] = useState(false);

	const handleSelect = useCallback(
		(type: string) => {
			if (!editable) return;
			updateForm(moduleIndex, formIndex, {
				type: type as "registration" | "followup" | "survey",
			});
			setOpen(false);
		},
		[editable, updateForm, moduleIndex, formIndex],
	);

	const icon = formTypeIcons[form?.type ?? "survey"] ?? formTypeIcons.survey;
	const hasCaseType = editable && !!mod?.caseType;

	return (
		<>
			{editable ? (
				<Popover.Root open={open} onOpenChange={setOpen}>
					<Popover.Trigger
						className="-ml-1.5 p-1.5 rounded-md shrink-0 text-nova-text-muted transition-colors cursor-pointer hover:text-nova-text hover:bg-white/5"
						aria-label="Change form type"
					>
						<Icon icon={icon} width="18" height="18" />
					</Popover.Trigger>

					<Popover.Portal>
						<Popover.Positioner
							side="bottom"
							align="start"
							sideOffset={4}
							className={POPOVER_POSITIONER_GLASS_CLS}
						>
							<Popover.Popup className={POPOVER_POPUP_CLS}>
								<DropdownMenu
									activeKey={form?.type ?? "survey"}
									items={formTypeOptions.map(
										(opt): DropdownMenuItem => ({
											key: opt.value,
											label: opt.label,
											icon: formTypeIcons[opt.value] ?? formTypeIcons.survey,
											onClick: () => handleSelect(opt.value),
											disabled:
												CASE_DEPENDENT_TYPES.has(opt.value) && !hasCaseType,
										}),
									)}
								/>
							</Popover.Popup>
						</Popover.Positioner>
					</Popover.Portal>
				</Popover.Root>
			) : (
				<span className="-ml-1.5 p-1.5 text-nova-text-muted shrink-0">
					<Icon icon={icon} width="18" height="18" />
				</span>
			)}
		</>
	);
}
