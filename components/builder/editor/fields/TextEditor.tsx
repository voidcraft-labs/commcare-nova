"use client";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";

/**
 * TextEditor — declarative editor for plain-string field keys.
 *
 * Adapts the shared EditableText commit/blur UX to the generic
 * FieldEditorComponent contract:
 *   - Non-empty commits dispatch the trimmed string.
 *   - Empty commits route through `onEmpty` so the field is cleared
 *     via `onChange(undefined)`. The reducer treats `undefined` as a
 *     removal patch; passing `""` would persist an empty string.
 *
 * `keyName` drives `data-field-id` on the underlying input so undo/redo
 * focus hints (which encode the focused field key) land back on this
 * editor when the property is restored.
 */
export function TextEditor<F extends Field, K extends keyof F & string>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { value, onChange, label, autoFocus, keyName } = props;
	const current = typeof value === "string" ? value : "";

	// `as F[K]` narrows a string (or undefined) back into the key's
	// declared type. The registry contract guarantees the component is
	// only mounted on string-typed keys — the cast is the canonical way
	// to re-express that invariant at the call site.
	const handleSave = useCallback(
		(next: string) => {
			onChange(next as F[K]);
		},
		[onChange],
	);

	const handleEmpty = useCallback(() => {
		onChange(undefined as F[K]);
	}, [onChange]);

	return (
		<EditableText
			label={label}
			dataFieldId={keyName}
			value={current}
			autoFocus={autoFocus}
			onSave={handleSave}
			onEmpty={handleEmpty}
		/>
	);
}
