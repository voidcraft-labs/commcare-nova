"use client";
import { useCallback } from "react";
import { Icon } from "@iconify/react/offline";
import type { BlueprintForm } from "@/lib/schemas/blueprint";
import type { MutableBlueprint } from "@/lib/services/mutableBlueprint";
import { formTypeIcons } from "@/lib/questionTypeIcons";
import {
	useFloatingDropdown,
	DropdownPortal,
} from "@/hooks/useFloatingDropdown";
import {
	DropdownMenu,
	type DropdownMenuItem,
} from "@/components/ui/DropdownMenu";

const formTypeOptions: { value: string; label: string }[] = [
	{ value: "registration", label: "Registration" },
	{ value: "followup", label: "Followup" },
	{ value: "survey", label: "Survey" },
];

interface FormDetailProps {
	/** The form to display close case info for. */
	form: BlueprintForm;
}

/**
 * Read-only close case info panel within FormSettingsPanel.
 * Renders only when the form has a close_case configuration.
 */
export function FormDetail({ form }: FormDetailProps) {
	if (!form.close_case) return null;

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
				Close Case
			</span>
			<p className="text-sm text-nova-rose">
				{form.close_case.question
					? `When ${form.close_case.question} = "${form.close_case.answer}"`
					: "Always (unconditional)"}
			</p>
		</div>
	);
}

// ── Form Type Button (for FormScreen header) ──────────────────────────

interface FormTypeButtonProps {
	form: BlueprintForm;
	/** When provided, the icon becomes a clickable button that opens a type picker. */
	moduleIndex?: number;
	formIndex?: number;
	mb?: MutableBlueprint;
	notifyBlueprintChanged?: () => void;
}

/**
 * Form type icon in the form header. Interactive (dropdown to change type) when
 * mutation props are provided, static icon otherwise.
 */
export function FormTypeButton({
	form,
	moduleIndex,
	formIndex,
	mb,
	notifyBlueprintChanged,
}: FormTypeButtonProps) {
	const editable =
		mb != null &&
		moduleIndex != null &&
		formIndex != null &&
		notifyBlueprintChanged != null;
	const dd = useFloatingDropdown<HTMLButtonElement>({
		placement: "bottom-start",
		offset: 4,
		contentPopover: true,
	});

	const handleSelect = useCallback(
		(type: string) => {
			if (!editable) return;
			mb.updateForm(moduleIndex, formIndex, {
				type: type as "registration" | "followup" | "survey",
			});
			notifyBlueprintChanged();
			dd.close();
		},
		[editable, mb, moduleIndex, formIndex, notifyBlueprintChanged, dd],
	);

	const icon = formTypeIcons[form.type] ?? formTypeIcons.survey;

	return (
		<>
			{editable ? (
				<button
					type="button"
					ref={dd.triggerRef}
					onClick={dd.toggle}
					className="-ml-1.5 p-1.5 rounded-md shrink-0 text-nova-text-muted transition-colors cursor-pointer hover:text-nova-text hover:bg-white/5"
					aria-label="Change form type"
				>
					<Icon icon={icon} width="18" height="18" />
				</button>
			) : (
				<span className="-ml-1.5 p-1.5 shrink-0 text-nova-text-muted">
					<Icon icon={icon} width="18" height="18" />
				</span>
			)}

			{editable && (
				<DropdownPortal dropdown={dd}>
					<FormTypeDropdown currentType={form.type} onSelect={handleSelect} />
				</DropdownPortal>
			)}
		</>
	);
}

/** Form type dropdown using the shared DropdownMenu for consistent POPOVER_GLASS styling. */
function FormTypeDropdown({
	currentType,
	onSelect,
}: {
	currentType: string;
	onSelect: (type: string) => void;
}) {
	const items: DropdownMenuItem[] = formTypeOptions.map((opt) => ({
		key: opt.value,
		label: opt.label,
		icon: formTypeIcons[opt.value] ?? formTypeIcons.survey,
		onClick: () => onSelect(opt.value),
	}));

	return <DropdownMenu items={items} activeKey={currentType} />;
}
