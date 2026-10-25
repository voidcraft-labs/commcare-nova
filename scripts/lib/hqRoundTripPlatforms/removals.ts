/**
 * The mutation that removes each media carrier step 2 takes out (part 09 §5,
 * step 2's table): every one an existing kind, so the reducer every editor's
 * commit uses makes the target and the synthetic writer replays it.
 *
 * References of one carrier make one mutation: a label's image and audio
 * removed together are one `setFieldMedia`, two rows of one image-map column
 * one `updateColumn`. A file is never deleted; only the reference goes.
 */

import { columnContentSnapshot } from "@/lib/doc/caseListColumnMutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Media } from "@/lib/domain";
import type { AssetRef, MediaSlotKind } from "@/lib/domain/mediaRefs";
import { ownRecordValue } from "@/lib/domain/records";

/** The carrier a reference sits on: two references of one key make one mutation. */
export function carrierKey(ref: AssetRef): string {
	const at = ref.location;
	switch (at.kind) {
		case "app_logo":
			return "logo";
		case "module_icon":
		case "module_audio_label":
			return `module:${at.moduleUuid}`;
		case "case_list_icon":
		case "case_list_audio_label":
			return `case-list:${at.moduleUuid}`;
		case "form_icon":
		case "form_audio_label":
			return `form:${at.formUuid}`;
		case "field_media_bundle":
			return `field:${at.fieldUuid}:${at.bundleKey}`;
		case "option_media":
			return `option:${at.fieldUuid}:${at.optionUuid}`;
		case "image_map_mapping":
			return `column:${at.moduleUuid}:${at.columnUuid}`;
	}
}

/** A media bundle without the removed kinds: undefined where nothing is left. */
function bundleWithout(
	media: Media | undefined,
	kinds: ReadonlySet<MediaSlotKind>,
): Media | undefined {
	const kept: Media = {};
	for (const kind of ["image", "audio", "video"] as const) {
		const value = media?.[kind];
		if (value !== undefined && !kinds.has(kind)) kept[kind] = value;
	}
	return Object.keys(kept).length === 0 ? undefined : kept;
}

function missingCarrier(ref: AssetRef): never {
	throw new Error(
		`The ${ref.location.kind} carrier of media asset ${ref.assetId} is not in the document the removal reads. This is a defect of the cutover; nothing was written.`,
	);
}

/** The one mutation that removes every reference of one carrier. */
function carrierRemoval(
	doc: BlueprintDoc,
	refs: readonly AssetRef[],
): Mutation {
	const first = refs[0] as AssetRef;
	const at = first.location;
	const kinds = new Set(refs.map((ref) => ref.location.kind));
	switch (at.kind) {
		case "app_logo":
			return { kind: "setAppLogo", logo: null };
		case "module_icon":
		case "module_audio_label": {
			const module = ownRecordValue(doc.modules, at.moduleUuid);
			if (module === undefined) return missingCarrier(first);
			return {
				kind: "setModuleMedia",
				uuid: at.moduleUuid,
				icon: kinds.has("module_icon") ? null : (module.icon ?? null),
				audioLabel: kinds.has("module_audio_label")
					? null
					: (module.audioLabel ?? null),
			};
		}
		case "case_list_icon":
		case "case_list_audio_label":
			return {
				kind: "setCaseListMeta",
				uuid: at.moduleUuid,
				patch: {
					...(kinds.has("case_list_icon") && { icon: null }),
					...(kinds.has("case_list_audio_label") && { audioLabel: null }),
				},
			};
		case "form_icon":
		case "form_audio_label": {
			const form = ownRecordValue(doc.forms, at.formUuid);
			if (form === undefined) return missingCarrier(first);
			return {
				kind: "setFormMedia",
				uuid: at.formUuid,
				icon: kinds.has("form_icon") ? null : (form.icon ?? null),
				audioLabel: kinds.has("form_audio_label")
					? null
					: (form.audioLabel ?? null),
			};
		}
		case "field_media_bundle": {
			const field = ownRecordValue(doc.fields, at.fieldUuid) as
				| Readonly<Record<string, unknown>>
				| undefined;
			if (field === undefined) return missingCarrier(first);
			const media = bundleWithout(
				field[at.bundleKey] as Media | undefined,
				new Set(refs.map((ref) => ref.slotKind)),
			);
			return {
				kind: "setFieldMedia",
				fieldUuid: at.fieldUuid,
				slot: at.bundleKey === "label_media" ? "label" : "help",
				media: media ?? null,
			};
		}
		case "option_media": {
			const field = ownRecordValue(doc.fields, at.fieldUuid);
			const option =
				field !== undefined &&
				(field.kind === "single_select" || field.kind === "multi_select") &&
				field.optionsSource.kind === "inline"
					? field.optionsSource.options.find(
							(candidate) => candidate.uuid === at.optionUuid,
						)
					: undefined;
			if (option === undefined) return missingCarrier(first);
			const { media: current, ...rest } = option;
			const media = bundleWithout(
				current,
				new Set(refs.map((ref) => ref.slotKind)),
			);
			return {
				kind: "updateOption",
				fieldUuid: at.fieldUuid,
				uuid: at.optionUuid,
				option: { ...rest, ...(media !== undefined && { media }) },
			};
		}
		case "image_map_mapping": {
			const module = ownRecordValue(doc.modules, at.moduleUuid);
			const column = module?.caseListConfig?.columns.find(
				(candidate) => candidate.uuid === at.columnUuid,
			);
			if (column === undefined || column.kind !== "image-map")
				return missingCarrier(first);
			const removed = new Set(
				refs.map((ref) =>
					ref.location.kind === "image_map_mapping"
						? ref.location.rowIndex
						: -1,
				),
			);
			const content = columnContentSnapshot(column);
			return {
				kind: "updateColumn",
				moduleUuid: at.moduleUuid,
				uuid: at.columnUuid,
				column: {
					...content,
					mapping: column.mapping.filter((_, index) => !removed.has(index)),
				} as typeof content,
			};
		}
	}
}

/**
 * The mutations that remove `refs` from `doc`, one per carrier, in the order
 * each carrier's first reference walks.
 */
export function removalsFor(
	doc: BlueprintDoc,
	refs: readonly AssetRef[],
): Mutation[] {
	const byCarrier = new Map<string, AssetRef[]>();
	for (const ref of refs) {
		const key = carrierKey(ref);
		byCarrier.set(key, [...(byCarrier.get(key) ?? []), ref]);
	}
	return [...byCarrier.values()].map((group) => carrierRemoval(doc, group));
}

/** The mutation that removes one reference's carrier slot. */
export function removalFor(doc: BlueprintDoc, ref: AssetRef): Mutation {
	return carrierRemoval(doc, [ref]);
}
