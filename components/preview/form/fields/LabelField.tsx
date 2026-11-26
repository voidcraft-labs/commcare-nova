"use client";
import { useMemo } from "react";
import { MediaDisplay } from "@/components/builder/media/MediaDisplay";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type {
	CommitOutcome,
	FieldPatchFor,
	LabelField as LabelFieldEntity,
	ProseTemplate,
} from "@/lib/domain";
import { PREVIEW_LABEL_RENDERING } from "@/lib/markdown";
import type { FieldState } from "@/lib/preview/engine/types";
import { labelPresentation } from "@/lib/preview/labelPresentation";
import { LabelContent } from "@/lib/references/LabelContent";
import { useEditMode, usePreviewPlatformRules } from "@/lib/session/hooks";
import { FIELD_STYLES } from "../fieldStyles";
import { LabelQrCode, LabelSpeechButton } from "../LabelExtras";
import { TextEditable } from "../TextEditable";
import { useLabelFormatText } from "../useLabelFormatText";

/**
 * Display-only label field renderer. Labels carry only `label` + optional
 * `relevant` in the domain schema: no hint, no data binding. The preview
 * engine still provides a resolved label (hashtag substitution) via
 * `FieldState`.
 */
export function LabelField({
	field,
	state,
}: {
	/** The label field entity. Prop name is `field` to match the domain.
	 *  consistent with other preview field components: the prop name is
	 *  cosmetic; the value is a domain `LabelField`. */
	field: LabelFieldEntity;
	state: FieldState;
}) {
	const mode = useEditMode();
	const isEditMode = mode === "edit";
	/* The running preview renders the label as the runtime it plays does
	 * (`lib/preview/platform.ts`, `labelMarkdown`). */
	const rules = usePreviewPlatformRules();
	const labelRendering = rules.labelMarkdown;
	const selectionBySetting = rules.labelTextSelection === "by-setting";
	const { updateField } = useBlueprintMutations();
	const labelFormatText = useLabelFormatText(field);
	const projectProse = useProseProjection();
	/* Inline save callback: null in preview mode so the TextEditable
	 * below falls back to read-only. In edit mode returns a stable
	 * `(field, value) => void` that coerces empty strings to undefined
	 * (an unset property) and commits through the doc store. The
	 * patch's `property` arg is a runtime key (the TextEditable's
	 * `fieldType` axis), so we cast back to the label kind's partial
	 * shape: every key TextEditable can save (`label`) is declared on
	 * `LabelField`, so the runtime contract holds. */
	const saveField = useMemo<
		((field: string, value: ProseTemplate) => CommitOutcome) | null
	>(() => {
		if (!isEditMode) return null;
		return (property, value) => {
			return updateField(field.uuid, "label", {
				[property]: value,
			} as FieldPatchFor<"label">);
		};
	}, [isEditMode, field.uuid, updateField]);

	/* The running preview shows what the runtime it plays draws for the
	 * label (`lib/preview/labelPresentation.ts`); edit mode edits the label. */
	const shown = isEditMode
		? undefined
		: labelPresentation(
				field,
				labelFormatText?.plain === true,
				rules,
				state,
				projectProse,
			);
	const shownText = shown?.text ?? {
		slot: "label" as const,
		template: field.label,
		resolved: state.resolvedLabel,
	};

	return (
		<div
			className={`py-1 ${selectionBySetting && !isEditMode ? (field.selectableText ? "select-text" : "select-none") : ""}`}
		>
			{/* Label media above the text: same `MediaDisplay` the input fields
			    use, so a display-only label shows its image/audio/video too. */}
			<MediaDisplay
				media={shown ? shown.media : field.label_media}
				interactive={!isEditMode}
			/>
			{shown?.qrCode !== undefined ? <LabelQrCode text={shown.qrCode} /> : null}
			<TextEditable
				value={field.label}
				onSave={saveField ? (v) => saveField("label", v) : undefined}
				fieldType="label"
				formatText={labelFormatText}
				proseSlot={{ entity: "field", uuid: field.uuid, slot: "label" }}
			>
				<LabelContent
					label={shownText.template}
					resolvedLabel={shownText.resolved}
					isEditMode={isEditMode}
					rendering={isEditMode ? PREVIEW_LABEL_RENDERING : labelRendering}
					plainLabel={labelFormatText?.plain === true}
					className={FIELD_STYLES.label}
					proseSlot={{
						entity: "field",
						uuid: field.uuid,
						slot: shownText.slot,
					}}
				/>
			</TextEditable>
			{shown?.speech !== undefined ? (
				<LabelSpeechButton text={shown.speech} questionLabel={undefined} />
			) : null}
		</div>
	);
}
