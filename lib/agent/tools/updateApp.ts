/**
 * SA tool: `updateApp` — set the app's display name.
 *
 * Connect mode and participation are deliberately absent. The shared
 * `configureConnect` / `configure_connect` command owns that complete
 * app-wide target state atomically.
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
			.describe("App display name (the title users see on devices)."),
	})
	.strict();

export type UpdateAppInput = z.infer<typeof updateAppInputSchema>;

/** Human-readable success string or an error record. */
export type UpdateAppResult = MutationSuccess | { error: string };

export const updateAppTool = {
	description: "Set the app's display name.",

	inputSchema: updateAppInputSchema,
	async execute(
		input: UpdateAppInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<UpdateAppResult>> {
		try {
			const mutations: Mutation[] = [{ kind: "setAppName", name: input.name }];

			const commit = await guardedMutate(ctx, doc, mutations, "app");
			if (!commit.ok) {
				return {
					kind: "mutate" as const,
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}

			const summary: ToolCallSummary = {
				subject: input.name,
				nameChange: doc.appName ? "renamed" : "named",
			};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message: `Successfully set the app's name to "${input.name}".`,
					summary,
				},
			};
		} catch (err) {
			return toToolErrorResult(err, doc);
		}
	},
};
