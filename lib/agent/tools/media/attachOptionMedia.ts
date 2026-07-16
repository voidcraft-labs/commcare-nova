/**
 * SA tool: `attach_option_media` — set or clear the image/audio/video on
 * one or more options of single-/multi-select fields in a single call.
 *
 * Each select option carries its own optional `media` bundle (image +
 * audio + video) so a visual-pick UI can show a picture or play audio
 * beside each choice. Every attachment in the batch locates a field,
 * finds the option by its `value` (the stored choice key, not the display
 * label), and replaces that option's `media` bundle; an empty bundle
 * (`{}`) clears it. A whole picture-choice field — or several fields —
 * authors in one call; one attachment is a length-1 `attachments` array.
 *
 * Only `single_select` / `multi_select` fields carry options; any other
 * kind fails with an Elm-shape error. A `value` that isn't among the
 * field's options likewise fails, naming the values that exist.
 *
 * The batch is all-or-nothing (`commitMediaBatch`): every attachment must
 * resolve and every set slot must pass the at-source asset verdict
 * (exists / owned / ready / kind-matched / inside the export ceiling)
 * before the single gated commit; any failure returns `{ error }` naming
 * every offending attachment and nothing is written. Two attachments
 * addressing the same option apply in order — the later one wins.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import { asUuid, type BlueprintDoc, type SelectOption } from "@/lib/domain";
import { FIELD_REF_HINT, resolveFieldTarget } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import type { MutationSuccess } from "../shared/toolCallSummary";
import {
	brandMediaBundle,
	bundleExpectations,
	commitMediaBatch,
	joinBatchLines,
	mediaBundleInput,
	type ResolvedMediaBatchItem,
} from "./shared";

const optionMediaAttachmentSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z
			.string()
			.describe(`The single_select / multi_select field — ${FIELD_REF_HINT}`),
		optionValue: z
			.string()
			.describe(
				"The `value` of the option to attach media to (the stored choice key, not the display label).",
			),
		media: mediaBundleInput(
			"The image/audio/video to attach to this option. Supply any subset " +
				"of `image`, `audio`, `video` as asset ids (discover them with " +
				"list_media_assets). Pass an empty object `{}` to clear the option's media.",
		),
	})
	.strict();

export const attachOptionMediaInputSchema = z
	.object({
		attachments: z
			.array(optionMediaAttachmentSchema)
			.min(1)
			.describe(
				"The option attachments to apply, each naming a select field, one " +
					"of its option values, and the media bundle for it. Batch every " +
					"attachment you're making in one call — a whole picture-choice " +
					"field's options, across fields and forms as needed. The batch " +
					"commits as a whole.",
			),
	})
	.strict();

export type AttachOptionMediaInput = z.infer<
	typeof attachOptionMediaInputSchema
>;

export type AttachOptionMediaResult = MutationSuccess | { error: string };

export const attachOptionMediaTool = {
	description:
		"Set or clear image/audio/video on select-field options — attachments may span fields and forms. An empty media object clears.",
	inputSchema: attachOptionMediaInputSchema,
	async execute(
		input: AttachOptionMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AttachOptionMediaResult>> {
		const { attachments } = input;
		try {
			// Resolve every attachment before writing anything, collecting
			// every failure — `commitMediaBatch` reports them as one
			// all-or-nothing error.
			const resolved: ResolvedMediaBatchItem[] = [];
			const failures: string[] = [];
			for (const [i, attachment] of attachments.entries()) {
				const { moduleIndex, formIndex, fieldId, optionValue, media } =
					attachment;
				const found = resolveFieldTarget(doc, moduleIndex, formIndex, fieldId);
				if (!found.ok) {
					failures.push(
						`attachments[${i}]: ${found.error}. Run getForm or searchBlueprint to find the right field.`,
					);
					continue;
				}

				const { field } = found;
				if (field.kind !== "single_select" && field.kind !== "multi_select") {
					failures.push(
						`attachments[${i}]: field "${field.id}" is a ${field.kind} field, which has no options to attach media to. Option media is only for single_select and multi_select fields.`,
					);
					continue;
				}

				const index = field.options.findIndex((o) => o.value === optionValue);
				if (index < 0) {
					const values = field.options.map((o) => `"${o.value}"`).join(", ");
					failures.push(
						`attachments[${i}]: field "${field.id}" has no option with value "${optionValue}". Its option values are: ${values}.`,
					);
					continue;
				}

				// Empty bundle clears the option's media; a populated bundle
				// sets it. An all-empty bundle resolves to `undefined` so the
				// option drops its `media` key rather than storing an empty
				// object.
				const branded = brandMediaBundle(media);
				const setKinds = Object.entries(branded)
					.filter(([, v]) => v !== undefined)
					.map(([k]) => k);

				// Swap the one option's media via a granular `updateOption` keyed by
				// the option's uuid, so a concurrent edit to a DIFFERENT option of the
				// same field merges. The reducer preserves the option's current
				// `order`; the uuid falls back to the deterministic backfill key when
				// a not-yet-hydrated doc lacks one (matching what backfill mints).
				const targetOption = field.options[index];
				const optionUuid =
					targetOption.uuid ?? asUuid(`${field.uuid}-opt-${index}`);
				const updated = withMedia(
					{ ...targetOption, uuid: optionUuid },
					setKinds.length > 0 ? branded : undefined,
				);
				resolved.push({
					mutations: [
						{
							kind: "updateOption",
							fieldUuid: field.uuid,
							uuid: optionUuid,
							option: updated,
						},
					],
					expectations: bundleExpectations(
						branded,
						`option "${optionValue}" of field "${field.id}"`,
					),
					line:
						setKinds.length > 0
							? `attached ${setKinds.join(", ")} media on option "${optionValue}" of field "${field.id}"`
							: `cleared media on option "${optionValue}" of field "${field.id}"`,
				});
			}

			const outcome = await commitMediaBatch({
				ctx,
				doc,
				stage: "media:option",
				resolved,
				failures,
				attemptPhrase: `attach media to ${attachments.length} option${attachments.length === 1 ? "" : "s"}`,
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

			return {
				kind: "mutate" as const,
				mutations: outcome.mutations,
				newDoc: outcome.newDoc,
				result: {
					message: joinBatchLines(resolved.map((r) => r.line)),
					summary: { count: attachments.length },
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};

/**
 * Return a copy of the option with its `media` set to the supplied bundle
 * (or with the `media` key dropped when `media` is `undefined`). Keeps the
 * value/label intact and only the media reference changes.
 */
function withMedia(
	option: SelectOption,
	media: SelectOption["media"] | undefined,
): SelectOption {
	const { media: _prev, ...rest } = option;
	return media === undefined ? rest : { ...rest, media };
}
