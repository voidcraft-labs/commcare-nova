"use client";

import { useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { BlurCommitTextInput } from "@/components/builder/shared/primitives/BlurCommitTextInput";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { formRootName, formRootNameSchema } from "@/lib/domain/formAnswerRoot";
import { useCanEdit } from "@/lib/session/hooks";
import type { FormSettingsSectionProps } from "./types";

export function AnswerRootSection({
	formUuid,
}: Pick<FormSettingsSectionProps, "formUuid">) {
	const entry = useForm(formUuid);
	const sourceUuid = entry?.shadowOf?.form;
	const source = useForm(sourceUuid);
	const form = sourceUuid === undefined ? entry : source;
	const { inline } = useBlueprintMutations();
	const canEdit = useCanEdit() && sourceUuid === undefined;
	const [message, setMessage] = useState<string | null>(null);
	if (!form) return null;
	return (
		<details className="space-y-1 text-xs" open={canEdit ? undefined : true}>
			<summary className="cursor-pointer font-medium text-nova-text-secondary">
				Submitted answer addresses
			</summary>
			<p className="py-1 text-nova-text-muted">
				Every answer in this form starts under this name. A reporting system may
				use it to find your answers.
			</p>
			{!canEdit ? (
				<p className="font-mono">{formRootName(form)}</p>
			) : (
				<BlurCommitTextInput
					ariaLabel="Submitted answer root"
					monospace
					value={formRootName(form)}
					onCommit={(next) => {
						const name = formRootNameSchema.safeParse(next);
						if (!name.success) {
							setMessage(name.error.issues[0].message);
							return;
						}
						const outcome = inline.updateForm(formUuid, {
							dataRootName: name.data === "data" ? null : name.data,
						});
						setMessage(outcome.ok ? null : outcome.messages.join(" "));
					}}
				/>
			)}
			<RejectionInline message={message} />
		</details>
	);
}
