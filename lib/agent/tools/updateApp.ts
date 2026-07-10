/**
 * SA tool: `updateApp` — set the app's name and/or its CommCare Connect
 * type, in one gated batch.
 *
 * The app-level twin of `updateModule` / `updateForm`. Two slots:
 *
 *   - `name` — the display title. On a fresh build this is the first
 *     mutation of the run (an empty app's nameless state is a
 *     pre-existing finding that this call resolves).
 *   - `connect_type` — `"learn"` / `"deliver"` enables Connect, `"off"`
 *     disables it, `null` leaves it unchanged (the wire forces every key
 *     present, so null is how a name-only call avoids touching Connect).
 *     The gate adjudicates the flip like any other commit:
 *     enabling Connect on an app with forms but ZERO connect blocks
 *     would introduce CONNECT_NO_PARTICIPATING_FORMS and is rejected —
 *     give at least one form its block first (creation tools'
 *     `connect`, or `updateForm`), then flip. On an empty app the flip
 *     introduces nothing, which is why a Connect build sets the type up
 *     front and then creates each participating form WITH its block;
 *     forms that shouldn't participate just omit one.
 *
 * Both the SA chat factory and the MCP adapter call this through the
 * shared `ToolExecutionContext` interface.
 */

import { z } from "zod";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type {
	MutationSuccess,
	ToolCallSummary,
} from "./shared/toolCallSummary";

export const updateAppInputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				"App display name (the title users see on devices). null keeps the current name.",
			),
		connect_type: z
			.enum(["learn", "deliver", "off"])
			.nullable()
			.optional()
			.describe(
				'CommCare Connect type: "learn" for training/certification, "deliver" for paid service delivery, "off" to make a Connect app standard again. null leaves the current setting unchanged — on a standard app, a name-only call passes null here. Set the type before creating a Connect app\'s modules — each participating form then lands with its connect block, and at least one form must participate.',
			),
	})
	.strict();

export type UpdateAppInput = z.infer<typeof updateAppInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateAppResult = MutationSuccess | { error: string };

export const updateAppTool = {
	description:
		'Set the app\'s name and/or its CommCare Connect type ("learn" / "deliver" / "off" for standard; null leaves it unchanged). Enabling Connect on an app with forms requires at least one of them to already carry its connect block (a Connect app needs one participating form; the rest may stay out) — on a new build, set the type before creating modules.',

	inputSchema: updateAppInputSchema,
	async execute(
		input: UpdateAppInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateAppResult>> {
		try {
			const mutations: Mutation[] = [];
			if (input.name != null) {
				mutations.push({ kind: "setAppName", name: input.name });
			}
			// null = leave unchanged (the wire forces the key present, so null
			// is how a name-only call says "don't touch Connect"); "off" is the
			// explicit disable, stored as the domain's null connectType.
			if (input.connect_type != null) {
				mutations.push({
					kind: "setConnectType",
					connectType: input.connect_type === "off" ? null : input.connect_type,
				});
			}
			if (mutations.length === 0) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: {
						error:
							"Nothing to change — every slot was null. Pass a name, a connect_type, or both.",
					},
				};
			}

			const commit = await guardedMutate(ctx, doc, mutations, "app");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}

			const changes: string[] = [];
			if (input.name != null) changes.push(`name to "${input.name}"`);
			if (input.connect_type != null) {
				changes.push(
					input.connect_type === "off"
						? "Connect off (standard app)"
						: `Connect type to ${input.connect_type}`,
				);
			}
			// The summary reports only what this call CHANGED — the transcript's
			// verb hangs off these facts, so claiming the app name as subject on a
			// connect-only flip would read as a rename that never happened. The
			// named-vs-renamed split needs the pre-commit doc, which only this
			// execution sees (`doc.appName` is "" until the birth finding resolves).
			const summary: ToolCallSummary = {};
			if (input.name != null) {
				summary.subject = input.name;
				summary.nameChange = doc.appName ? "renamed" : "named";
			}
			if (input.connect_type != null) {
				summary.connect = input.connect_type;
			}
			return {
				kind: "mutate" as const,
				mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Successfully set the app's ${changes.join(" and ")}.`,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
