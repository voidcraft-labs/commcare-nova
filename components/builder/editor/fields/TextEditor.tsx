"use client";
import { useCallback } from "react";
import { EditableText } from "@/components/builder/EditableText";
import type { Field } from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	OptionalStringKeys,
} from "@/lib/domain/kinds";

/**
 * TextEditor — declarative editor for plain-string field keys.
 *
 * Adapts the shared EditableText commit/blur UX to the
 * FieldEditorComponent contract:
 *   - Non-empty commits dispatch the trimmed string.
 *   - Empty commits route through `onEmpty` so the key is cleared
 *     via `onChange(undefined)`. The reducer treats `undefined` as a
 *     removal patch; persisting `""` would leave stale empty strings
 *     on the field.
 *
 * The `K extends OptionalStringKeys<F>` constraint pins `K` to keys
 * whose declared type is exactly `string | undefined`. That makes
 * `string` and `undefined` each a value-level subtype of `F[K]`, so
 * the two casts below are tautological — TypeScript simply can't
 * prove that on its own because `F[K]` is an indexed access through
 * a generic. The constraint is the authoritative guarantee; the
 * casts are the syntactic shape TS requires to pass a narrower
 * value into a generic-keyed setter.
 *
 * `keyName` is threaded to `data-field-id` on the underlying input so
 * undo/redo focus hints — which encode the focused field key — land
 * back on this editor when the property is restored.
 */
export function TextEditor<F extends Field, K extends OptionalStringKeys<F>>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { value, onChange, label, autoFocus, keyName } = props;
	const current = typeof value === "string" ? value : "";

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
