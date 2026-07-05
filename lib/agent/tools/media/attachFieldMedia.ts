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
 * validation. The tool gates the slot against the field's KIND via
 * `fieldKindDeclaresKey` — the schema key set, NOT `key in field`, because
 * an unset optional slot is absent as an own property even on a kind that
 * supports it — and refuses an unsupported slot with an Elm-shape error.
 *
 * The tool emits the dedicated `setFieldMedia` mutation (via
 * `setFieldMediaMutations`), NOT an `updateField` patch. A clear must
 * cross the SSE wire as an explicit `null`: an `updateField` patch encodes
 * a clear as `{ <slot>_media: undefined }`, which `JSON.stringify` DROPS,
 * so the client's `applyMany` would never clear the slot and the stale
 * asset ref would persist (and auto-save back over the SA's correct
 * clear). `setFieldMedia` carries `media: Media | null` and the reducer
 * maps `null → undefined`, so both set and clear survive the wire.
 *
 * Every set runs the at-source asset verdict before the gated commit
 * (`attachGuardedMutate` — exists / owned / ready / kind-matched /
 * inside the export ceiling), so a committed reference can't dangle; a
 * clear (empty bundle) carries no expectations and skips the asset
 * read.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`. Four exit branches: field not found →
 * `{ error }`; slot unsupported on the field's kind → `{ error }`; a
 * failed asset verdict → `{ error }`; success → a human-readable
 * summary.
 */

import { z } from "zod";
import type { BlueprintDoc, Field } from "@/lib/domain";
import { fieldKindDeclaresKey } from "@/lib/domain";
import {
	resolveFieldByIndex,
	setFieldMediaMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import {
	attachGuardedMutate,
	brandMediaBundle,
	bundleExpectations,
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

			// Empty bundle clears the slot; a populated bundle sets it. An
			// all-empty bundle becomes a `null` payload so the reducer drops
			// the slot (rather than storing an empty object). `null` survives
			// JSON over the SSE wire; `undefined` would not.
			const branded = brandMediaBundle(media);
			const hasAny =
				branded.image !== undefined ||
				branded.audio !== undefined ||
				branded.video !== undefined;
			const mutations = setFieldMediaMutations(
				field.uuid,
				slot,
				hasAny ? branded : null,
			);
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				`media:field:${moduleIndex}-${formIndex}`,
				bundleExpectations(branded, `the ${slot} media on field "${fieldId}"`),
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			const newDoc = commit.newDoc;

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
			return toToolErrorResult(err, doc);
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
