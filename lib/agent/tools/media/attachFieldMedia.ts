/**
 * SA tool: `attach_field_media` — set or clear the image/audio/video on
 * one of a field's message slots (label / hint / help / validation
 * message).
 *
 * Each visible-message slot on a field carries its own `<slot>_media`
 * bundle (`label_media` / `hint_media` / `help_media` /
 * `validate_msg_media`). The slot the SA names maps to that key; the
 * supplied `Media` bundle replaces it wholesale. Passing an empty bundle
 * (`{}`) clears every reference on the slot.
 *
 * Slot availability is per-kind, not universal: `label_media` is on every
 * visible field (and containers); `hint_media` / `help_media` are on
 * input kinds; `validate_msg_media` only on the kinds that support
 * validation. The tool narrows with `"<key>" in field` (the same
 * narrowing `lib/domain/mediaRefs.ts` uses) and refuses a slot the field
 * doesn't carry with an Elm-shape error — a raw `updateField` would
 * silently no-op an unsupported slot, leaving the SA believing the
 * attachment landed.
 *
 * Asset existence is not checked here — the SA validation loop's media
 * rules surface a bad reference (deleted / pending / foreign-owned /
 * kind-mismatched) with this carrier's location. The tool persists the
 * reference and lets the loop adjudicate.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`. Three exit branches: field not found →
 * `{ error }`; slot unsupported on the field's kind → `{ error }`;
 * success → a human-readable summary.
 */

import { z } from "zod";
import type { BlueprintDoc, Field, FieldPatchFor } from "@/lib/domain";
import { fieldKindDeclaresKey } from "@/lib/domain";
import {
	resolveFieldByIndex,
	updateFieldMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import {
	brandMediaBundle,
	FIELD_MEDIA_SLOTS,
	type FieldMediaSlot,
	mediaBundleInput,
	mediaKeyForSlot,
} from "./shared";

export const attachFieldMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z
			.string()
			.describe("Field id whose message slot to attach media to"),
		slot: z
			.enum(FIELD_MEDIA_SLOTS)
			.describe(
				"Which message slot the media attaches to: `label` (every field), " +
					"`hint` / `help` (input fields), `validate_msg` (fields that support " +
					"validation). The media shows alongside that message's text.",
			),
		media: mediaBundleInput(
			"The image/audio/video to attach. Supply any subset of `image`, " +
				"`audio`, `video` as asset ids (discover them with list_media_assets). " +
				"Pass an empty object `{}` to clear every reference on this slot.",
		),
	})
	.strict();

export type AttachFieldMediaInput = z.infer<typeof attachFieldMediaInputSchema>;

/** Human-readable success string or an error record. */
export type AttachFieldMediaResult = string | { error: string };

export const attachFieldMediaTool = {
	description:
		"Set or clear the image/audio/video on one of a field's message slots (label, hint, help, or validation message). Supply asset ids from list_media_assets; pass an empty media object to clear the slot. The slot must exist on the field's kind (e.g. only input fields have hint/help; only validation-capable kinds have validate_msg).",
	inputSchema: attachFieldMediaInputSchema,
	async execute(
		input: AttachFieldMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AttachFieldMediaResult>> {
		const { moduleIndex, formIndex, fieldId, slot, media } = input;
		try {
			const resolved = resolveFieldByIndex(
				doc,
				moduleIndex,
				formIndex,
				fieldId,
			);
			if (!resolved) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Tried to attach ${slot} media to field "${fieldId}" in m${moduleIndex}-f${formIndex}, but no field with that id is there. Run getForm or searchBlueprint to find the right field id.`,
					},
				};
			}

			const { field } = resolved;
			const mediaKey = mediaKeyForSlot(slot);
			// Slot availability is per-KIND, asked of the schema — not of
			// this field instance. An unset optional `<slot>_media` is absent
			// as an own property even on a kind that supports it, so
			// `key in field` would falsely reject a field that simply has no
			// media yet. `fieldKindDeclaresKey` reads the kind's schema key
			// set, the same source of truth the reducer's
			// `pickFieldKeysForKind` filter uses — so a slot the kind doesn't
			// carry is rejected here rather than silently dropped downstream.
			if (!fieldKindDeclaresKey(field.kind, mediaKey)) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" is a ${field.kind} field, which has no ${slot} message — so there's nothing to attach ${slot} media to. ${supportedSlotsHint(field.kind)}`,
					},
				};
			}

			// Empty bundle clears the slot; a populated bundle replaces it.
			// An all-empty bundle resolves to `undefined` so the carrier
			// drops the reference (rather than storing an empty object).
			const branded = brandMediaBundle(media);
			const hasAny =
				branded.image !== undefined ||
				branded.audio !== undefined ||
				branded.video !== undefined;
			// The patch key is the kind-specific `<slot>_media`. The cast
			// through `FieldPatchFor` aligns the single-key patch with the
			// per-kind partial shape; `field.kind` is the concrete target
			// kind the reducer discriminates against.
			const patch = {
				[mediaKey]: hasAny ? branded : undefined,
			} as FieldPatchFor<typeof field.kind>;
			const mutations = updateFieldMutations(
				doc,
				field.uuid,
				field.kind,
				patch,
			);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`media:field:${moduleIndex}-${formIndex}`,
			);

			const verb = hasAny ? "Attached" : "Cleared";
			const slots = hasAny
				? Object.entries(branded)
						.filter(([, v]) => v !== undefined)
						.map(([k]) => k)
						.join(", ")
				: "all";
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `${verb} ${slots} ${slot} media on field "${fieldId}".`,
			};
		} catch (err) {
			return {
				kind: "mutate" as const,
				mutations: [],
				newDoc: doc,
				result: { error: err instanceof Error ? err.message : String(err) },
			};
		}
	},
};

/**
 * Build the "try one of these instead" hint listing the message slots the
 * field's KIND declares — derived from the kind's schema key set so the
 * hint can't drift from the schema (and so an unset optional slot still
 * counts as supported). An empty set (e.g. a hidden field, which carries
 * no message media) reads honestly as "carries no message media".
 */
function supportedSlotsHint(kind: Field["kind"]): string {
	const present = FIELD_MEDIA_SLOTS.filter((s: FieldMediaSlot) =>
		fieldKindDeclaresKey(kind, mediaKeyForSlot(s)),
	);
	if (present.length === 0) {
		return "This field kind carries no message media — there's no slot to attach to.";
	}
	return `This field's media slots are: ${present.join(", ")}.`;
}
