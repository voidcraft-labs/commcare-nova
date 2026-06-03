/**
 * SA tool: `set_app_logo` — set or clear the app's logo image.
 *
 * The blueprint root carries a single `logo` image, shown on the
 * web-apps login and home screens (no audio, no per-language variants —
 * see `lib/domain/blueprint.ts`). This is the ONLY writer for `doc.logo`:
 * no app-level setter tool exists otherwise.
 *
 * Required-and-nullable: an asset id sets the logo, `null` clears it. The
 * `setAppLogo` mutation maps `null → undefined` so a cleared logo drops
 * off the doc rather than persisting as a literal `null`.
 *
 * Asset existence is not checked here — the SA validation loop's media
 * rules surface a bad reference at the `app_logo` location. The tool
 * persists the reference and lets the loop adjudicate.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext`.
 */

import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { setAppLogoMutations } from "../../blueprintHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { applyToDoc, type MutatingToolResult } from "../common";
import { brandAssetSlot, nullableAssetSlot } from "./shared";

export const setAppLogoInputSchema = z
	.object({
		logo: nullableAssetSlot(
			"Asset id of the image to use as the app logo (shown on the login and " +
				"home screens), or null to clear it. Must be an image asset — discover " +
				"image asset ids with list_media_assets.",
		),
	})
	.strict();

export type SetAppLogoInput = z.infer<typeof setAppLogoInputSchema>;

/** Human-readable success string or an error record. */
export type SetAppLogoResult = string | { error: string };

export const setAppLogoTool = {
	description:
		"Set or clear the app's logo image — the single image shown on the web-apps login and home screens. Pass an image asset id from list_media_assets to set it, or null to clear it.",
	inputSchema: setAppLogoInputSchema,
	async execute(
		input: SetAppLogoInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetAppLogoResult>> {
		const { logo } = input;
		try {
			const mutations = setAppLogoMutations(brandAssetSlot(logo));
			const newDoc = applyToDoc(doc, mutations);
			await ctx.recordMutations(mutations, newDoc, "media:app-logo");

			return {
				kind: "mutate" as const,
				mutations,
				newDoc,
				result:
					logo === null
						? "Cleared the app logo."
						: `Set the app logo to ${logo}.`,
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
