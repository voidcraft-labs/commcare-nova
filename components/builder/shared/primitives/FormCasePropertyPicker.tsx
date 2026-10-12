"use client";

import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import { effectiveDataType } from "@/lib/domain";
import {
	acceptsType,
	type SlotConstraint,
	type Term,
} from "@/lib/domain/predicate";
import { propertyDisplayLabel } from "@/lib/domain/propertyDisplay";
import {
	type ExpressionChangeAdmission,
	usePredicateEditContext,
} from "../editorContext";

type FormRecordProperty = Extract<Term, { kind: "form-case" }>;

export function FormCasePropertyPicker({
	value,
	onChange,
	constraint,
	invalid,
	admit,
}: {
	value: FormRecordProperty;
	onChange: (value: FormRecordProperty) => void;
	constraint: SlotConstraint;
	invalid: boolean;
	admit: (value: FormRecordProperty) => ExpressionChangeAdmission;
}) {
	const context = usePredicateEditContext();
	const project = useProseProjection();
	const choices = context.caseTypes
		.filter((type) => context.formCaseTypes?.has(type.name))
		.flatMap((type) =>
			type.properties
				.filter((property) =>
					acceptsType(constraint, effectiveDataType(property)),
				)
				.map((property) => ({
					value: {
						kind: "form-case" as const,
						caseType: type.name,
						property: property.name,
					},
					label: `${type.name}: ${propertyDisplayLabel(property, project)}`,
				})),
		);
	const selected = choices.find(
		(choice) =>
			choice.value.caseType === value.caseType &&
			choice.value.property === value.property,
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Selected form record information"
				aria-invalid={invalid || !selected || undefined}
				render={
					<Button type="button" variant="field" className="w-full text-left" />
				}
			>
				{selected?.label ?? "Information that is no longer available"}
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				{choices.map((choice) => {
					const verdict = admit(choice.value);
					return (
						<DropdownMenuItem
							key={`${choice.value.caseType}/${choice.value.property}`}
							disabled={!verdict.admitted}
							onClick={() => onChange(choice.value)}
						>
							<span>
								{choice.label}
								{!verdict.admitted && (
									<span className="block text-xs text-nova-text-muted">
										{verdict.reason}
									</span>
								)}
							</span>
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
