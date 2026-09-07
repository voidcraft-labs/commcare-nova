"use client";
import { useCallback, useState } from "react";
import { RefLabelInput } from "@/components/builder/RefLabelInput";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import {
	EMPTY_PROSE_TEMPLATE,
	type Field,
	type ProseTemplate,
} from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	OptionalProseTemplateKeys,
} from "@/lib/domain/kinds";

/**
 * Adapts optional prose-template slots to RefLabelInput. Absent empty slots
 * are no-ops; clearing authored prose removes the key. Forward each actual
 * commit outcome so a refusal preserves the local editor draft and focus,
 * with one consumer-owned inline notice. The data-field-id restores focus
 * after undo/redo. Generic casts bridge OptionalProseTemplateKeys to F[K].
 */
export function TextEditor<
	F extends Field,
	K extends OptionalProseTemplateKeys<F>,
>(
	props: FieldEditorComponentProps<F, K> & {
		readonly onDismissEmpty?: () => void;
	},
) {
	const { value, onChange, label, autoFocus, keyName, onDismissEmpty } = props;
	const [rejection, setRejection] = useState<string | null>(null);
	const current =
		value && typeof value === "object" && "parts" in value
			? (value as ProseTemplate)
			: EMPTY_PROSE_TEMPLATE;

	const handleSave = useCallback(
		(next: ProseTemplate) => {
			// Forward the gated outcome: a refused commit keeps the draft in
			// the input and surfaces the finding inline.
			const outcome = onChange(next as F[K]);
			setRejection(outcome.ok ? null : outcome.messages.join(" "));
			return outcome;
		},
		[onChange],
	);

	const handleEmpty = useCallback(() => {
		// Skip the dispatch when the key is already absent: there is
		// nothing to clear. See the file header for the full rationale.
		if (value === undefined) {
			onDismissEmpty?.();
			return;
		}
		const outcome = onChange(undefined as F[K]);
		setRejection(outcome.ok ? null : outcome.messages.join(" "));
		return outcome;
	}, [onChange, value, onDismissEmpty]);

	return (
		<div>
			<RefLabelInput
				label={label}
				dataFieldId={keyName}
				value={current}
				autoFocus={autoFocus}
				onSave={handleSave}
				onEmpty={handleEmpty}
			/>
			<RejectionInline message={rejection} />
		</div>
	);
}
