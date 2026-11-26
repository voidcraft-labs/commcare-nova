import { z } from "zod";
import { CONNECT_ROLES, type ConnectRole } from "@/lib/domain";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type { ToolCallSummary } from "./shared/toolCallSummary";

export const configureConnectInputSchema = z
	.strictObject({
		roles: z
			.array(z.enum(CONNECT_ROLES))
			.max(2)
			.describe(
				"The Connect roles this Android app uses. Choose learning, delivery, both, or neither. Use addFields for each Connect activity at its position in a form.",
			),
	})
	.refine(({ roles }) => new Set(roles).size === roles.length, {
		error: "Choose each Connect role once.",
	});

export const configureConnectTool = {
	description:
		"Choose the roles an Android app uses in CommCare Connect. Activities live in forms and can be added or edited with the field tools. Before removing a role, remove or change the activities that use it. A role can be selected before its first activity.",
	inputSchema: configureConnectInputSchema,
	async execute(
		input: z.infer<typeof configureConnectInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<
		MutatingToolResult<
			| { ok: true; roles: readonly ConnectRole[]; summary: ToolCallSummary }
			| { error: string }
		>
	> {
		const roles = CONNECT_ROLES.filter((role) => input.roles.includes(role));
		const current = ctx.snapshot.doc.connectRoles;
		if (
			current.length === roles.length &&
			roles.every((role, i) => current[i] === role)
		)
			return {
				kind: "mutate" as const,
				mutations: [] as const,
				result: { ok: true as const, roles, summary: { noop: true as const } },
			};
		try {
			const commit = await guardedMutate(
				ctx,
				[{ kind: "setConnectRoles", roles }],
				"app",
			);
			if (!commit.ok)
				return {
					kind: "mutate" as const,
					mutations: [] as const,
					result: { error: commit.error },
				};
			const saved = commit.newDoc.connectRoles;
			const summary: ToolCallSummary = {
				connect: saved.length === 2 ? "both" : (saved[0] ?? "off"),
			};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: { ok: true as const, roles: saved, summary },
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
