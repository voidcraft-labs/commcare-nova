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
 * A set runs the at-source asset verdict before the gated commit
 * (`attachGuardedMutate` — exists / owned / ready / kind-matched /
 * inside the export ceiling), so a committed reference can't dangle; a
 * `null` clear carries no expectations and skips the asset read.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolInvocationContext`.
 */

import { z } from "zod";
import { setAppLogoMutations } from "../../blueprintHelpers";
import type { ToolInvocationContext } from "../../workspace/types";
import { type MutatingToolResult, toToolErrorResult } from "../common";
import {
	attachGuardedMutate,
	nullableAssetSlot,
	slotExpectation,
} from "./shared";

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
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<SetAppLogoResult>> {
		const doc = ctx.snapshot.doc;
		const { logo } = input;
		try {
			const mutations = setAppLogoMutations(logo);
			const commit = await attachGuardedMutate(
				ctx,
				doc,
				mutations,
				"media:app-logo",
				slotExpectation(logo, "image", "the app logo"),
			);
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			}

			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result:
					logo === null
						? "Cleared the app logo."
						: `Set the app logo to ${logo}.`,
			};
		} catch (err) {
			return toToolErrorResult(err);
		}
	},
};
