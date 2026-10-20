// components/builder/shared/primitives/ChoiceValuePicker.tsx
//
// Picks one written choice of a select question by its label and stores it as
// a `choice` (the option's UUID), so a later edit of the choice's value keeps
// the comparison connected. The saved value shows beside each label, because
// two choices can share a label but never a value.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import { useRef } from "react";
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useField } from "@/lib/doc/hooks/useEntity";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { SelectOption, Uuid } from "@/lib/domain";
import type { Choice } from "@/lib/domain/expression";
import { choiceOf } from "../choiceValueModel";
import type { ExpressionChangeAdmission } from "../editorContext";

interface ChoiceValuePickerProps {
	/** The select question whose choices are offered. */
	readonly field: Uuid;
	readonly value: Choice | undefined;
	readonly onChange: (next: Choice) => void;
	readonly invalid: boolean;
	/** The owner's verdict for one choice, judged as the owner would commit it. */
	readonly admit?: (next: Choice) => ExpressionChangeAdmission;
}

export function ChoiceValuePicker({
	field,
	value,
	onChange,
	invalid,
	admit,
}: ChoiceValuePickerProps) {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const question = useField(field);
	const projectProse = useProseProjection();
	const options: readonly SelectOption[] =
		question !== undefined &&
		"optionsSource" in question &&
		question.optionsSource.kind === "inline"
			? question.optionsSource.options
			: [];
	const labelOf = (uuid: Uuid) => {
		const option = options.find((candidate) => candidate.uuid === uuid);
		if (option === undefined) return undefined;
		const label = projectProse(option.label).trim();
		return label.length > 0 ? label : option.value;
	};
	const labels = value?.options.map(labelOf) ?? [];
	const missing = labels.some((label) => label === undefined);
	const currentLabel =
		value === undefined
			? undefined
			: missing
				? "A choice that is no longer available"
				: labels.join(", ");
	const triggerClass = [
		"group h-auto min-h-11 w-full justify-between rounded-lg border bg-nova-deep/50 px-3 py-2 text-sm text-nova-text whitespace-normal dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50",
		invalid || missing
			? "border-nova-rose/40"
			: "border-white/[0.06] not-disabled:hover:border-nova-violet/30",
	].join(" ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={triggerRef}
				aria-label={`Choice: ${currentLabel ?? "Pick a choice"}`}
				aria-invalid={invalid || missing || undefined}
				render={
					<Button type="button" variant="outline" className={triggerClass} />
				}
			>
				<span className="min-w-0 flex-1 break-words text-left text-nova-violet-bright">
					{currentLabel ?? "Pick a choice"}
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)" }}
				>
					<DropdownMenuPopup className="min-w-0">
						{options.length === 0 ? (
							<div
								className="px-3 py-2.5 text-[13px] leading-5 text-nova-text-secondary"
								role="presentation"
							>
								This question has no written choices to pick from. You can
								choose another value source.
							</div>
						) : null}
						{options.map((option) => {
							const next = choiceOf(field, option.uuid);
							const admission = admit?.(next) ?? { admitted: true as const };
							const active =
								value?.options.length === 1 && value.options[0] === option.uuid;
							return (
								<DropdownMenuItem
									key={option.uuid}
									disabled={!admission.admitted}
									onClick={() => onChange(next)}
									className={
										active ? "bg-nova-violet/10 text-nova-violet-bright" : ""
									}
								>
									<span className="min-w-0 flex-1 break-words text-left">
										<span className="block">{labelOf(option.uuid)}</span>
										<span className="block text-xs text-nova-text-muted">
											{admission.admitted
												? `Saved as ${option.value}`
												: admission.reason}
										</span>
									</span>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}
