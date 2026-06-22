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
import { type BlueprintDoc, FORM_ICON_SLUGS } from "@/lib/domain";
import { resolveFormUuid, setFormMediaMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import type { MutatingToolResult } from "../common";
import {
	attachGuardedMutate,
	brandAssetSlot,
	nullableAssetSlot,
	nullableIconSlot,
	resolveIconInput,
	slotExpectation,
} from "./shared";

export const setFormMediaInputSchema = z
	.object({
		moduleIndex: z.number().describe("0-based module index"),
		formIndex: z.number().describe("0-based form index within the module"),
		icon: nullableIconSlot(
			FORM_ICON_SLUGS,
			"The image on the form's menu tile. Pass a built-in icon slug (one of " +
				"the listed action icons, e.g. register, follow_up, refer) for a " +
				"ready-made icon with no upload, OR the asset id of an uploaded image " +
				"from list_media_assets, OR null to clear it.",
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
		"Set or clear a form's menu media — the per-form tile icon (image) and the audio label (audio prompt). Both slots are set together. For the icon, pass a built-in icon slug (e.g. register) or an uploaded image's asset id from list_media_assets; for the audio label, an audio asset id; or null to clear either. Forms carry image + audio only, no video.",
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

			const carrierName =
				doc.forms[formUuid]?.name ?? `m${moduleIndex}-f${formIndex}`;
			// The icon may be a built-in slug or an uploaded asset id; resolve it
			// to the stored ref + the verdict expectation it imposes (built-ins
			// impose none — they have no library row to check).
			const resolvedIcon = resolveIconInput(
				icon,
				`the icon on form "${carrierName}"`,
			);
			// Emit the dedicated `setFormMedia` mutation: a clear must ride
			// the SSE wire as an explicit `null` (the reducer maps it to
			// `undefined`). An `updateForm` patch would encode a clear as
			// `{ icon: undefined }`, which `JSON.stringify` drops, leaving the
			// stale ref on the client.
			const mutations = setFormMediaMutations(
				formUuid,
				resolvedIcon.icon,
				brandAssetSlot(audioLabel),
			);
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				`media:form:${moduleIndex}-${formIndex}`,
				[
					...resolvedIcon.expectations,
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
