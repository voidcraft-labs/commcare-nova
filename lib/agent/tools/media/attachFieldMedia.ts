/**
 * SA tool: `attach_field_media` — set or clear the image/audio/video on
 * one or more field message slots (label / hint / help / validation
 * message) in a single call.
 *
 * Each visible-message slot on a field carries its own `<slot>_media`
 * bundle (`label_media` / `hint_media` / `help_media` /
 * `validate_msg_media`). Every attachment in the batch names a field and
 * a slot; the supplied `Media` bundle replaces that slot wholesale, and
 * an empty bundle (`{}`) clears every reference on it. One attachment is
 * a length-1 `attachments` array — there is no singular twin.
 *
 * Slot availability is per-kind, not universal: `label_media` is on every
 * visible field (and containers); `hint_media` / `help_media` are on
 * input kinds; `validate_msg_media` only on the kinds that support
 * validation. Each attachment gates its slot against the field's KIND via
 * `fieldKindDeclaresKey` — the schema key set, NOT `key in field`, because
 * an unset optional slot is absent as an own property even on a kind that
 * supports it — and an unsupported slot fails with an Elm-shape error.
 *
 * Each attachment emits the dedicated `setFieldMedia` mutation (via
 * `setFieldMediaMutations`), NOT an `updateField` patch. A clear must
 * cross the SSE wire as an explicit `null`: an `updateField` patch encodes
 * a clear as `{ <slot>_media: undefined }`, which `JSON.stringify` DROPS,
 * so the client's `applyMany` would never clear the slot and the stale
 * asset ref would persist (and auto-save back over the SA's correct
 * clear). `setFieldMedia` carries `media: Media | null` and the reducer
 * maps `null → undefined`, so both set and clear survive the wire.
 *
 * The batch is all-or-nothing (`commitMediaBatch`): every attachment must
 * resolve (field exists, slot supported) and every set slot must pass the
 * at-source asset verdict (exists / owned / ready / kind-matched / inside
 * the export ceiling) before the single gated commit; any failure returns
 * `{ error }` naming every offending attachment and nothing is written.
 * Two attachments addressing the same (field, slot) apply in order — the
 * later one wins.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { fieldKindDeclaresKey } from "@/lib/domain";
import {
	resolveFieldByIndex,
	setFieldMediaMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	brandMediaBundle,
	bundleExpectations,
	commitMediaBatch,
	FIELD_MEDIA_SLOTS,
	type FieldMediaSlot,
	joinBatchLines,
	mediaBundleInput,
	mediaKeyForSlot,
	type ResolvedMediaBatchItem,
} from "./shared";

const fieldMediaAttachmentSchema = z
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

export const attachFieldMediaInputSchema = z
	.object({
		attachments: z
			.array(fieldMediaAttachmentSchema)
			.min(1)
			.describe(
				"The field-slot attachments to apply, each naming a field, one of " +
					"its message slots, and the media bundle for it. Batch every " +
					"attachment you're making in one call — the fields can span " +
					"different forms and modules. The batch commits as a whole.",
			),
	})
	.strict();

export type AttachFieldMediaInput = z.infer<typeof attachFieldMediaInputSchema>;

export type AttachFieldMediaResult = MutationSuccess | { error: string };

export const attachFieldMediaTool = {
	description:
		"Set or clear image/audio/video on field message slots (label, hint, help, validation message) — fields may span forms. Asset ids come from list_media_assets; an empty media object clears. The slot must exist on the field's kind.",
	inputSchema: attachFieldMediaInputSchema,
	async execute(
		input: AttachFieldMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AttachFieldMediaResult>> {
		const { attachments } = input;
		try {
			// Resolve every attachment before writing anything, collecting
			// every failure — `commitMediaBatch` reports them as one
			// all-or-nothing error. `fieldUuid` rides along for the
			// distinct-field summary count.
			const resolved: (ResolvedMediaBatchItem & { fieldUuid: Uuid })[] = [];
			const failures: string[] = [];
			for (const [i, attachment] of attachments.entries()) {
				const { moduleIndex, formIndex, fieldId, slot, media } = attachment;
				const found = resolveFieldByIndex(doc, moduleIndex, formIndex, fieldId);
				if (!found) {
					failures.push(
						`attachments[${i}]: found no field "${fieldId}" in m${moduleIndex}-f${formIndex}. Run getForm or searchBlueprint to find the right field id.`,
					);
					continue;
				}

				const { field } = found;
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
					failures.push(
						`attachments[${i}]: field "${fieldId}" is a ${field.kind} field, which has no ${slot} message — so there's nothing to attach ${slot} media to. ${supportedSlotsHint(field.kind)}`,
					);
					continue;
				}

				// Empty bundle clears the slot; a populated bundle sets it. An
				// all-empty bundle becomes a `null` payload so the reducer drops
				// the slot (rather than storing an empty object). `null` survives
				// JSON over the SSE wire; `undefined` would not.
				const branded = brandMediaBundle(media);
				const setKinds = Object.entries(branded)
					.filter(([, v]) => v !== undefined)
					.map(([k]) => k);
				resolved.push({
					mutations: setFieldMediaMutations(
						field.uuid,
						slot,
						setKinds.length > 0 ? branded : null,
					),
					expectations: bundleExpectations(
						branded,
						`the ${slot} media on field "${fieldId}"`,
					),
					fieldUuid: field.uuid,
					line:
						setKinds.length > 0
							? `attached ${setKinds.join(", ")} ${slot} media on field "${fieldId}"`
							: `cleared ${slot} media on field "${fieldId}"`,
				});
			}

			const outcome = await commitMediaBatch({
				ctx,
				doc,
				stage: "media:field",
				resolved,
				failures,
				attemptPhrase: `attach media to ${attachments.length} field slot${attachments.length === 1 ? "" : "s"}`,
				itemNoun: "attachment",
				outcomeVerb: "attached",
			});
			if (!outcome.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: outcome.error },
				};
			}

			const fieldCount = new Set(resolved.map((r) => r.fieldUuid)).size;
			return {
				kind: "mutate" as const,
				mutations: outcome.mutations,
				newDoc: outcome.newDoc,
				result: {
					message: joinBatchLines(resolved.map((r) => r.line)),
					summary: { count: fieldCount },
				},
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
