"use client";

import { useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { HiddenField } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useCanEdit } from "@/lib/session/hooks";

/**
 * The namespace a receiving service identifies a hidden value by. Blank means
 * the value travels in the form's own namespace. A viewer reads the setting
 * with the section open, since there is nothing to change.
 */
export function HiddenAnswerNamespaceEditor({
	field,
	label,
}: FieldEditorComponentProps<HiddenField, "answerNamespace">) {
	const canEdit = useCanEdit();
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	return (
		<details
			data-field-id="answerNamespace"
			className="space-y-1 text-xs"
			open={canEdit ? undefined : true}
		>
			<summary className="cursor-pointer font-medium text-nova-text-secondary">
				{label}
			</summary>
			<p className="text-nova-text-muted">
				A service can identify this value by a namespace. Leave it blank to use
				the form’s namespace.
			</p>
			{canEdit ? (
				<BlurCommitTextInput
					ariaLabel="Receiving namespace"
					monospace
					value={field.answerNamespace ?? ""}
					onCommit={(value) => {
						const outcome = updateField(field.uuid, "hidden", {
							answerNamespace: value === "" ? null : value,
						});
						setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
					}}
				/>
			) : (
				<p>{field.answerNamespace ?? "Uses the form’s namespace"}</p>
			)}
			<RejectionInline message={rejection} />
		</details>
	);
}
