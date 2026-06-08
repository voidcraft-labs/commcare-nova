/**
 * SA tool: `set_module_media` — set or clear a module's menu media: the
 * home-screen tile `icon` (image) and the `audioLabel` (audio prompt for
 * audio-prompt mode).
 *
 * Menu carriers take image + audio only (no video — see
 * `lib/domain/multimedia.ts::mediaSchema`'s docstring). Both slots are set
 * in one call: a module's menu media is a single small carrier, so one
 * tool covering both slots saves a round trip with no payload-size cost.
 * Each slot is required-and-nullable — the SA always states intent: an
 * asset id sets the slot, `null` clears it. To touch only one slot, the SA
 * reads the other's current value (via getModule) and passes it back.
 *
 * Asset existence is not checked here — the SA validation loop's media
 * rules surface a bad reference with this module's location. The tool
 * persists the reference and lets the loop adjudicate.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { setModuleMediaMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import { brandAssetSlot, nullableAssetSlot } from "./shared";

export const setModuleMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		icon: nullableAssetSlot(
			"Asset id of the image shown on the module's home-screen tile, or " +
				"null to clear it. Discover image asset ids with list_media_assets.",
		),
		audioLabel: nullableAssetSlot(
			"Asset id of the audio prompt played for the module's menu label, or " +
				"null to clear it. Discover audio asset ids with list_media_assets.",
		),
	})
	.strict();

export type SetModuleMediaInput = z.infer<typeof setModuleMediaInputSchema>;

/** Human-readable success string or an error record. */
export type SetModuleMediaResult = string | { error: string };

export const setModuleMediaTool = {
	description:
		"Set or clear a module's menu media — the home-screen tile icon (image) and the audio label (audio prompt). Both slots are set together; pass an asset id from list_media_assets to set a slot, or null to clear it. Modules carry image + audio only, no video.",
	inputSchema: setModuleMediaInputSchema,
	async execute(
		input: SetModuleMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetModuleMediaResult>> {
		const { moduleIndex, icon, audioLabel } = input;
		try {
			const moduleUuid = doc.moduleOrder[moduleIndex];
			if (!moduleUuid)
				return moduleNotFoundResult<string>(
					doc,
					moduleIndex,
					"set module media",
				);
			const mod = doc.modules[moduleUuid];
			if (!mod)
				return moduleNotFoundResult<string>(
					doc,
					moduleIndex,
					"set module media",
				);

			// Emit the dedicated `setModuleMedia` mutation: a clear must ride
			// the SSE wire as an explicit `null` (the reducer maps it to
			// `undefined`). An `updateModule` patch would encode a clear as
			// `{ icon: undefined }`, which `JSON.stringify` drops, leaving the
			// stale ref on the client.
			const mutations = setModuleMediaMutations(
				mod.uuid,
				brandAssetSlot(icon),
				brandAssetSlot(audioLabel),
			);
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(
				mutations,
				newDoc,
				`media:module:${moduleIndex}`,
			);

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Set media on module "${mod.name}": icon ${describeSlot(icon)}, audio label ${describeSlot(audioLabel)}.`,
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
