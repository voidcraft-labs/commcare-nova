"use client";

import { useFileLanguageLens } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useStoredField } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { languageDisplayLabel } from "@/lib/domain/languageRegistry";
import {
	MEDIA_KINDS,
	type MediaAssetId,
	type MediaValues,
	mediaInLanguage,
} from "@/lib/domain/multimedia";
import { useCanEdit } from "@/lib/session/hooks";
import { MediaSlot, SingleAssetSlot } from "./MediaSlot";

/** A bundle with one role's file set or cleared, or undefined where no role
 *  is left. */
function withInlineVideo(
	files: MediaValues | undefined,
	video: MediaAssetId | undefined,
): MediaValues | undefined {
	const { videoInline: _previous, ...rest } = files ?? {};
	const next: MediaValues = video ? { ...rest, videoInline: video } : rest;
	return Object.keys(next).length ? next : undefined;
}

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
	// The stored field: the lens projection has already chosen one file per
	// role, and this editor shows which of them the language holds itself.
	const field = useStoredField(fieldUuid);
	const lens = useFileLanguageLens();
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
	const roles = [
		...MEDIA_KINDS,
		...(slot === "label" && !optionUuid ? (["videoInline"] as const) : []),
	];
	const roleName = (role: (typeof roles)[number]) =>
		role === "videoInline" ? "inline video" : role;
	const inherited =
		!lens.isSource &&
		roles
			.filter((role) => shown?.[role] && own?.[role] === undefined)
			.map(roleName);
	const fromDefault = roles
		.filter((role) => shown?.[role] && own?.[role] === null)
		.map(roleName);
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
			{/* A question's label alone plays an inline video: Android plays it
			    inside the question in the place of its image, and Web Apps
			    shows none (`label-inline-video`). */}
			{slot === "label" && !optionUuid && (
				<div className="mt-1.5">
					<span className="text-xs text-nova-text-muted">Inline video</span>
					<SingleAssetSlot
						kind="video"
						value={shown?.videoInline}
						onChange={(video) => edit(withInlineVideo(shown, video))}
						removalLabel={
							lens.isSource || own?.videoInline === undefined
								? undefined
								: "Use shared inline video"
						}
						slotKey={`${slotKey}:inline-video:${lens.language}`}
						ariaLabel={`${ariaLabel} inline video`}
					/>
					{shown?.videoInline && (
						<p className="text-xs text-nova-text-muted">
							Android plays it inside the question, in the place of its image.
							Web Apps doesn't show it.
						</p>
					)}
				</div>
			)}
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
