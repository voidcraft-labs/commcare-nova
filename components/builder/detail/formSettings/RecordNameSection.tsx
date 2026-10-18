"use client";

import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFormRecordName } from "@/lib/doc/hooks/useFormRecordName";
import {
	useFormExpressionLintContext,
	useParseFormExpression,
} from "@/lib/doc/hooks/useXPathSlots";
import { LabeledXPathField } from "./LabeledXPathField";
import type { FormSettingsSectionProps } from "./types";

export function RecordNameSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const name = useFormRecordName(formUuid);
	const parse = useParseFormExpression(
		name?.prepared.slot,
		undefined,
		name?.prepared.form,
	);
	const { inline } = useBlueprintMutations();
	const getLintContext = useFormExpressionLintContext(
		name?.prepared.slot,
		undefined,
		name?.prepared.form,
	);
	if (form?.type !== "registration" || !name) return null;
	if (!name.ok)
		return (
			<p className="text-xs text-nova-rose">
				The record name has a reference that needs attention.
			</p>
		);
	return (
		<section className="space-y-1">
			<LabeledXPathField
				label="Record name"
				required
				value={name.text}
				getLintContext={getLintContext}
				onSave={(text) =>
					inline.setFormRecordName(formUuid, parse(text), name.prepared)
				}
			/>
			<p className="text-xs text-nova-text-muted">
				Shown in lists and when a worker opens this record.
			</p>
		</section>
	);
}
