/**
 * SA tool: `attach_option_media` — set or clear the image/audio/video on
 * one option of a single-/multi-select field.
 *
 * Each select option carries its own optional `media` bundle (image +
 * audio + video) so a visual-pick UI can show a picture or play audio
 * beside each choice. The tool locates the field, finds the option by its
 * `value` (the stored choice key, not the display label), and replaces
 * that option's `media` bundle. Passing an empty bundle (`{}`) clears it.
 *
 * Only `single_select` / `multi_select` fields carry options; any other
 * kind is rejected with an Elm-shape error. A `value` that isn't among
 * the field's options is likewise rejected, naming the values that exist.
 *
 * Every set runs the at-source asset verdict before the gated commit
 * (`attachGuardedMutate` — exists / owned / ready / kind-matched /
 * inside the export ceiling), so a committed reference can't dangle; a
 * clear (empty bundle) carries no expectations and skips the asset
 * read.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { BlueprintDoc, FieldPatchFor, SelectOption } from "@/lib/domain";
import {
	resolveFieldByIndex,
	updateFieldMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { MutatingToolResult } from "../common";
import {
	attachGuardedMutate,
	brandMediaBundle,
	bundleExpectations,
	mediaBundleInput,
} from "./shared";

export const attachOptionMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index"),
		fieldId: z
			.string()
			.describe("Field id of the single_select / multi_select field"),
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

export type AttachOptionMediaInput = z.infer<
	typeof attachOptionMediaInputSchema
>;

/** Human-readable success string or an error record. */
export type AttachOptionMediaResult = string | { error: string };

export const attachOptionMediaTool = {
	description:
		"Set or clear the image/audio/video on one option of a single_select / multi_select field. Locate the option by its value; supply asset ids from list_media_assets, or an empty media object to clear it.",
	inputSchema: attachOptionMediaInputSchema,
	async execute(
		input: AttachOptionMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<AttachOptionMediaResult>> {
		const { moduleIndex, formIndex, fieldId, optionValue, media } = input;
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
						error: `Tried to attach media to option "${optionValue}" on field "${fieldId}" in m${moduleIndex}-f${formIndex}, but no field with that id is there. Run getForm or searchBlueprint to find the right field id.`,
					},
				};
			}

			const { field } = resolved;
			if (field.kind !== "single_select" && field.kind !== "multi_select") {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" is a ${field.kind} field, which has no options to attach media to. Option media is only for single_select and multi_select fields.`,
					},
				};
			}

			const index = field.options.findIndex((o) => o.value === optionValue);
			if (index < 0) {
				const values = field.options.map((o) => `"${o.value}"`).join(", ");
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Field "${fieldId}" has no option with value "${optionValue}". Its option values are: ${values}.`,
					},
				};
			}

			// Empty bundle clears the option's media; a populated bundle
			// sets it. An all-empty bundle resolves to `undefined` so the
			// option drops its `media` key rather than storing an empty
			// object.
			const branded = brandMediaBundle(media);
			const hasAny =
				branded.image !== undefined ||
				branded.audio !== undefined ||
				branded.video !== undefined;

			// Rebuild the options array with the one option's media swapped.
			// `options` is wholesale-replaced on the field patch — the
			// reducer has no per-option op, so the tool computes the new
			// array and hands it over intact.
			const nextOptions: SelectOption[] = field.options.map((o, i) =>
				i === index ? withMedia(o, hasAny ? branded : undefined) : o,
			);
			const patch = { options: nextOptions } as FieldPatchFor<
				typeof field.kind
			>;
			const mutations = updateFieldMutations(
				doc,
				field.uuid,
				field.kind,
				patch,
			);
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				`media:option:${moduleIndex}-${formIndex}`,
				bundleExpectations(
					branded,
					`option "${optionValue}" of field "${fieldId}"`,
				),
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
				result: `${verb} ${slots} media on option "${optionValue}" of field "${fieldId}".`,
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
