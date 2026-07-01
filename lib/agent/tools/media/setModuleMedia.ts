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
import { type BlueprintDoc, MODULE_ICON_SLUGS } from "@/lib/domain";
import {
	resolveModuleUuid,
	setModuleMediaMutations,
} from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import { moduleNotFoundResult } from "../shared/moduleNotFoundResult";
import {
	attachGuardedMutate,
	brandAssetSlot,
	nullableAssetSlot,
	nullableIconSlot,
	resolveIconInput,
	slotExpectation,
} from "./shared";

export const setModuleMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		icon: nullableIconSlot(
			MODULE_ICON_SLUGS,
			"The image on the module's home-screen tile. Pass a built-in icon slug " +
				"(one of the listed topic icons, e.g. household, patient, lab) for a " +
				"ready-made icon with no upload, OR the asset id of an uploaded image " +
				"from list_media_assets, OR null to clear it.",
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
		"Set or clear a module's menu media — the home-screen tile icon (image) and the audio label (audio prompt). Both slots are set together. For the icon, pass a built-in icon slug (e.g. household) or an uploaded image's asset id from list_media_assets; for the audio label, an audio asset id; or null to clear either. Modules carry image + audio only, no video.",
	inputSchema: setModuleMediaInputSchema,
	async execute(
		input: SetModuleMediaInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetModuleMediaResult>> {
		const { moduleIndex, icon, audioLabel } = input;
		try {
			const moduleUuid = resolveModuleUuid(doc, moduleIndex);
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

			// The icon may be a built-in slug or an uploaded asset id; resolve it
			// to the stored ref + the verdict expectation it imposes (built-ins
			// impose none — they have no library row to check).
			const resolvedIcon = resolveIconInput(
				icon,
				`the icon on module "${mod.name}"`,
			);
			// Emit the dedicated `setModuleMedia` mutation: a clear must ride
			// the SSE wire as an explicit `null` (the reducer maps it to
			// `undefined`). An `updateModule` patch would encode a clear as
			// `{ icon: undefined }`, which `JSON.stringify` drops, leaving the
			// stale ref on the client.
			const mutations = setModuleMediaMutations(
				mod.uuid,
				resolvedIcon.icon,
				brandAssetSlot(audioLabel),
			);
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				`media:module:${moduleIndex}`,
				[
					...resolvedIcon.expectations,
					...slotExpectation(
						audioLabel,
						"audio",
						`the audio label on module "${mod.name}"`,
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

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result: `Set media on module "${mod.name}": icon ${describeSlot(icon)}, audio label ${describeSlot(audioLabel)}.`,
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};

/** Render a slot's intent for the summary: cleared vs the set asset id. */
function describeSlot(value: string | null): string {
	return value === null ? "cleared" : `set to ${value}`;
}
