import type { z } from "zod";
import { lockProjectDataGrant } from "@/lib/auth/dataGrant";
import { NOVA_MCP_FLOOR_SCOPES } from "@/lib/auth-public";
import { withAppTx } from "@/lib/db/pg";
import {
	bindWorkerGroupTarget,
	readGroupTarget,
} from "@/lib/deployment/workerGroupBinding";
import { authorizeAgentScopeInTransaction } from "@/lib/lookup/agentService";
import {
	workerDirectoryReadSchema,
	workerGroupEditSchema,
} from "@/lib/lookup/assignmentVocabulary";
import { LookupError, lookupFailure } from "@/lib/lookup/errors";
import { editWorkerGroup, readGroupDirectory } from "@/lib/lookup/workerGroups";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import type { ToolInvocationContext } from "../workspace/types";
import type { ReadToolResult } from "./common";
import { lookupAgentScope } from "./shared/lookupScope";

export const getWorkerGroupsTool = {
	description:
		"Find workers, groups and places in this Project by name and kind. A groupId also opens the group's name, case sharing, details and members. Continue searches and membership lists with the returned offsets. Use the Project revision to edit. A target request can list approved project spaces, find exact target group names, or review a chosen target group and its actual member count before connecting it.",
	inputSchema: workerDirectoryReadSchema,
	async execute(
		input: z.infer<typeof workerDirectoryReadSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const scope = lookupAgentScope(ctx);
		const grant = ctx.dataGrant ?? {
			kind: "architect" as const,
			authority: scope,
		};
		try {
			const target = input.target
				? await readGroupTarget({ scope, grant }, input.target)
				: undefined;
			const data = await withAppTx(
				async (tx) => {
					await authorizeAgentScopeInTransaction(tx, scope, "edit");
					if (ctx.dataGrant)
						await lockProjectDataGrant(
							tx,
							scope.actorId,
							ctx.dataGrant,
							NOVA_MCP_FLOOR_SCOPES,
						);
					return readGroupDirectory(tx, scope.projectId, input);
				},
				{ isolationLevel: "repeatable read" },
			);
			return { kind: "read", data: { ...data, target } };
		} catch (error) {
			if (error instanceof LookupError)
				return { kind: "read", data: lookupFailure(error) };
			throw error;
		}
	},
};
export const editWorkerGroupTool = {
	description:
		"Create or change a worker group, its details, whether it shares cases or the membership of one worker. Connect only a target group reviewed with getWorkerGroups using its current witness. Use the Project revision you reviewed and one operation ID for retries. Membership can grant assigned rows even when the group does not share cases.",
	inputSchema: workerGroupEditSchema,
	async execute(
		input: z.infer<typeof workerGroupEditSchema>,
		ctx: ToolInvocationContext,
	): Promise<ReadToolResult<unknown>> {
		const scope = lookupAgentScope(ctx);
		try {
			if (input.change.kind === "connect") {
				const grant = ctx.dataGrant ?? {
					kind: "architect" as const,
					authority: scope,
				};
				const data = await bindWorkerGroupTarget(
					{ scope, grant },
					{
						...input.change,
						operationId: input.operationId,
						expectedProjectRevision: input.expectedProjectRevision,
					},
				);
				return { kind: "read", data };
			}
			const data = await withAppTx(async (tx) => {
				await authorizeAgentScopeInTransaction(tx, scope, "edit");
				if (ctx.dataGrant)
					await lockProjectDataGrant(
						tx,
						scope.actorId,
						ctx.dataGrant,
						NOVA_MCP_FLOOR_SCOPES,
					);
				const authority = await authorizeLookupWriteInTransaction(
					tx,
					scope,
					"edit",
				);
				return editWorkerGroup(tx, authority, input);
			});
			return { kind: "read", data };
		} catch (error) {
			if (error instanceof LookupError)
				return { kind: "read", data: lookupFailure(error) };
			throw error;
		}
	},
};
