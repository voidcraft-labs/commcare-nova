"use client";

import { useId, useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Field, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { HiddenField } from "@/lib/domain";
import {
	HIDDEN_ANSWER_TYPE_LABELS,
	HIDDEN_ANSWER_TYPES,
	type HiddenAnswerType,
} from "@/lib/domain/fields/hidden";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

export function HiddenAnswerTypeEditor({
	field,
	label,
}: FieldEditorComponentProps<HiddenField, "answerType">) {
	const id = useId();
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	return (
		<Field data-field-id="answerType">
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select<HiddenAnswerType | "automatic">
				value={field.answerType ?? "automatic"}
				onValueChange={(type) => {
					if (type === null) return;
					const result = updateField(field.uuid, "hidden", {
						answerType: type === "automatic" ? null : type,
					});
					setRejection(result.ok ? null : (result.messages[0] ?? null));
				}}
			>
				<SelectTrigger id={id}>
					<SelectValue>
						{field.answerType
							? HIDDEN_ANSWER_TYPE_LABELS[field.answerType]
							: "Automatic"}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="automatic">Automatic</SelectItem>
					{HIDDEN_ANSWER_TYPES.map((type) => (
						<SelectItem key={type} value={type}>
							{HIDDEN_ANSWER_TYPE_LABELS[type]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<RejectionInline message={rejection} />
		</Field>
	);
}
