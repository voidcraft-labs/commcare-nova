"use client";

import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useField } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { languageDisplayLabel } from "@/lib/domain/languageRegistry";
import { MEDIA_KINDS, mediaInLanguage } from "@/lib/domain/multimedia";
import { useCanEdit } from "@/lib/session/hooks";
import { MediaSlot } from "./MediaSlot";

export function FieldLanguageMedia({
	fieldUuid,
	slot,
	optionUuid,
	ariaLabel,
	slotKey,
}: {
	fieldUuid: Uuid;
	slot: "label" | "help";
	optionUuid?: Uuid;
	ariaLabel: string;
	slotKey: string;
}) {
	const canEdit = useCanEdit();
	const field = useField(fieldUuid);
	const lens = useBuilderLanguage();
	const { commitMany } = useBlueprintMutations();
	const key = slot === "help" ? "help_media" : "label_media";
	const media =
		optionUuid &&
		field &&
		"optionsSource" in field &&
		field.optionsSource.kind === "inline"
			? field.optionsSource.options.find((option) => option.uuid === optionUuid)
					?.media
			: field && key === "label_media" && "label_media" in field
				? field.label_media
				: field && key === "help_media" && "help_media" in field
					? field.help_media
					: undefined;
	const shown = mediaInLanguage(media, lens.language, lens.defaultLanguage);
	const edit = (files: typeof shown) =>
		commitMany([
			{
				kind: "setFieldMedia",
				fieldUuid,
				slot,
				...(optionUuid && { optionUuid }),
				language: lens.language,
				media: files ?? null,
			},
		]);
	const own = media?.mediaByLanguage?.[lens.language];
	const inherited =
		!lens.isSource &&
		MEDIA_KINDS.filter((kind) => shown?.[kind] && own?.[kind] === undefined);
	const fromDefault = MEDIA_KINDS.filter(
		(kind) => shown?.[kind] && own?.[kind] === null,
	);
	const defaultLanguage = media?.formDefaultLanguage ?? lens.defaultLanguage;
	return (
		<div>
			<MediaSlot
				value={shown}
				onChange={edit}
				kinds={MEDIA_KINDS}
				removalLabel={
					lens.isSource
						? undefined
						: (kind) =>
								own?.[kind] === undefined ? null : `Use shared ${kind}`
				}
				slotKey={`${slotKey}:${lens.language}`}
				ariaLabel={ariaLabel}
			/>
			{inherited && inherited.length > 0 && (
				<p className="text-xs text-nova-text-muted">
					Shared {inherited.join(", ")} from{" "}
					{languageDisplayLabel(lens.sourceLanguage) ?? lens.sourceLanguage}
				</p>
			)}
			{fromDefault.length > 0 && (
				<p className="text-xs text-nova-text-muted">
					{fromDefault.join(", ")} from{" "}
					{languageDisplayLabel(defaultLanguage) ?? defaultLanguage}
				</p>
			)}
			{canEdit && !lens.isSource && own && Object.keys(own).length > 0 && (
				<Button type="button" variant="ghost" onClick={() => edit(undefined)}>
					Use shared files
				</Button>
			)}
		</div>
	);
}
