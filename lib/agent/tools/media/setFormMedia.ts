/**
 * SA tool: `set_form_media` — set or clear a form's menu media: the
 * per-form tile `icon` (image) and the `audioLabel` (audio prompt).
 *
 * Mirrors `set_module_media` one level down. Forms, like modules, are
 * menu carriers: image + audio only, no video. Both slots are set in one
 * call; each is required-and-nullable so the SA states intent explicitly
 * (asset id sets, `null` clears). To touch only one slot, read the other
 * (via getForm) and pass it back.
 *
 * Every set runs the at-source asset verdict before the gated commit
 * (`attachGuardedMutate` — exists / owned / ready / kind-matched /
 * inside the export ceiling), so a committed reference can't dangle.
 * Re-passing the other slot's current value re-verifies it too — a
 * legacy bad ref passed back surfaces here with a fix (clear it) rather
 * than riding along silently. `null` slots carry no expectations.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { resolveFormUuid, setFormMediaMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { MutatingToolResult } from "../common";
import {
	attachGuardedMutate,
	brandAssetSlot,
	nullableAssetSlot,
	slotExpectation,
} from "./shared";

export const setFormMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index within the module"),
		icon: nullableAssetSlot(
			"Asset id of the image shown on the form's menu tile, or null to clear " +
				"it. Discover image asset ids with list_media_assets.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the form's menu label, or null " +
				"to clear it. Discover audio asset ids with list_media_assets.",
		),
	})
	.strict();

export type SetFormMediaInput = z.infer<typeof setFormMediaInputSchema>;

/** Human-readable success string or an error record. */
export type SetFormMediaResult = string | { error: string };

export const setFormMediaTool = {
	description:
		"Set or clear a form's menu media — the per-form tile icon (image) and the audio label (audio prompt). Both slots are set together; pass an asset id from list_media_assets to set a slot, or null to clear it. Forms carry image + audio only, no video.",
	inputSchema: setFormMediaInputSchema,
	async execute(
		input: SetFormMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetFormMediaResult>> {
		const { moduleIndex, formIndex, icon, audioLabel } = input;
		try {
			const formUuid = resolveFormUuid(doc, moduleIndex, formIndex);
			if (!formUuid) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error: `Tried to set media on the form at m${moduleIndex}-f${formIndex}, but no form is there. Run getModule to see the module's forms and their indices.`,
					},
				};
			}

			// Emit the dedicated `setFormMedia` mutation: a clear must ride
			// the SSE wire as an explicit `null` (the reducer maps it to
			// `undefined`). An `updateForm` patch would encode a clear as
			// `{ icon: undefined }`, which `JSON.stringify` drops, leaving the
			// stale ref on the client.
			const mutations = setFormMediaMutations(
				formUuid,
				brandAssetSlot(icon),
				brandAssetSlot(audioLabel),
			);
			const carrierName =
				doc.forms[formUuid]?.name ?? `m${moduleIndex}-f${formIndex}`;
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				`media:form:${moduleIndex}-${formIndex}`,
				[
					...slotExpectation(
						icon,
						"image",
						`the icon on form "${carrierName}"`,
					),
					...slotExpectation(
						audioLabel,
						"audio",
						`the audio label on form "${carrierName}"`,
					),
				],
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

			const formName =
				newDoc.forms[formUuid]?.name ?? `m${moduleIndex}-f${formIndex}`;
			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Set media on form "${formName}": icon ${describeSlot(icon)}, audio label ${describeSlot(audioLabel)}.`,
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

/** Render a slot's intent for the summary: cleared vs the set asset id. */
function describeSlot(value: string | null): string {
	return value === null ? "cleared" : `set to ${value}`;
}
