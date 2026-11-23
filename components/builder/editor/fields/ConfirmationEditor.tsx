"use client";

import { useCallback, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";

import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { LabelField } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useCanEdit } from "@/lib/session/hooks";

export function ConfirmationEditor({
	field,
	label,
}: FieldEditorComponentProps<LabelField, "askForConfirmation">) {
	const checked = field.askForConfirmation === true;
	const canEdit = useCanEdit();
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const toggle = useCallback(
		(next: boolean) => {
			const outcome = updateField(field.uuid, "label", {
				askForConfirmation: next ? true : null,
			});
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
		},
		[updateField, field.uuid],
	);
	return (
		<div data-field-id="askForConfirmation" className="space-y-2">
			<ToggleRow
				label={label}
				description="Android shows a checkbox. Web Apps confirms this message when the worker submits the form."
				checked={checked}
				disabledReason={
					canEdit
						? undefined
						: "View only. Ask a Project admin for edit access."
				}
				onChange={toggle}
			/>
			<RejectionInline message={rejection} />
		</div>
	);
}
