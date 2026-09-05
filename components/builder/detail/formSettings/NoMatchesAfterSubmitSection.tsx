"use client";
import { useId, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useOrderedForms } from "@/lib/doc/hooks/useModuleIds";
import {
	caseSelectionCardinality,
	formEntersFromMenu,
	isNoMatchesForm,
} from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { noMatchesAfterSubmitModel } from "./noMatchesAfterSubmit";
import type { FormSettingsSectionProps } from "./types";

export function NoMatchesAfterSubmitSection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const module = useModule(moduleUuid);
	const forms = useOrderedForms(moduleUuid);
	const canEdit = useCanEdit();
	const { inline } = useBlueprintMutations();
	const id = useId();
	const [refusal, setRefusal] = useState<string>();
	if (!form || !module || !isNoMatchesForm(form)) return null;
	const model = noMatchesAfterSubmitModel({
		appHome: form.postSubmit === "app_home",
		multiple: caseSelectionCardinality(module) === "multiple",
		hasMenuForms: forms.some(formEntersFromMenu),
	});
	return (
		<Field className="gap-2">
			<FieldLabel htmlFor={id}>After submit, go to</FieldLabel>
			<Select
				value={model.value}
				items={model.options}
				disabled={!canEdit}
				onValueChange={(value) => {
					if (value !== "app_home" && value !== "return") return;
					if (!model.options.some((option) => option.value === value)) return;
					const outcome = inline.updateForm(formUuid, {
						postSubmit: value === "app_home" ? "app_home" : null,
					});
					setRefusal(outcome.ok ? undefined : outcome.messages.join(" "));
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{model.options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<FieldDescription>{model.explanation}</FieldDescription>
			{refusal && (
				<p role="alert" className="text-sm text-nova-red">
					{refusal}
				</p>
			)}
		</Field>
	);
}
