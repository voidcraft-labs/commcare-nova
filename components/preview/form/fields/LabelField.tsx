"use client";
import { useEditContext } from "@/hooks/useEditContext";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import type { LabelField as LabelFieldEntity } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { LabelContent } from "@/lib/references/LabelContent";
import { FIELD_STYLES } from "../fieldStyles";
import { TextEditable } from "../TextEditable";

/**
 * Display-only label field renderer. Labels carry only `label` + optional
 * `relevant` in the domain schema — no hint, no data binding. The preview
 * engine still provides a resolved label (hashtag substitution) via
 * `FieldState`.
 */
export function LabelField({
	field,
	state,
}: {
	/** The label field entity. Prop name is `field` to match the domain.
	 *  consistent with other preview field components — the prop name is
	 *  cosmetic; the value is a domain `LabelField`. */
	field: LabelFieldEntity;
	state: FieldState;
}) {
	const ctx = useEditContext();
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(field.uuid);

	return (
		<div className="py-1">
			<TextEditable
				value={field.label ?? ""}
				onSave={saveField ? (v) => saveField("label", v) : undefined}
				fieldType="label"
			>
				<LabelContent
					label={field.label ?? ""}
					resolvedLabel={state.resolvedLabel}
					isEditMode={isEditMode}
					className={FIELD_STYLES.label}
				/>
			</TextEditable>
		</div>
	);
}
