"use client";
import { useMemo } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { LabelField as LabelFieldEntity } from "@/lib/domain";
import type { FieldState } from "@/lib/preview/engine/types";
import { LabelContent } from "@/lib/references/LabelContent";
import { useEditMode } from "@/lib/session/hooks";
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
	const mode = useEditMode();
	const isEditMode = mode === "edit";
	const { updateField } = useBlueprintMutations();
	/* Inline save callback — null in live/test mode so the TextEditable
	 * below falls back to read-only. In edit mode returns a stable
	 * `(field, value) => void` that coerces empty strings to undefined
	 * (an unset property) and commits through the doc store. The
	 * patch's `property` arg is a runtime key (the TextEditable's
	 * `fieldType` axis), so we cast back to the label kind's partial
	 * shape — every key TextEditable can save (`label`) is declared on
	 * `LabelField`, so the runtime contract holds. */
	const saveField = useMemo<
		((field: string, value: string) => void) | null
	>(() => {
		if (!isEditMode) return null;
		return (property, value) => {
			updateField(field.uuid, "label", {
				[property]: value === "" ? undefined : value,
			} as Partial<Omit<LabelFieldEntity, "uuid" | "kind">>);
		};
	}, [isEditMode, field.uuid, updateField]);

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
