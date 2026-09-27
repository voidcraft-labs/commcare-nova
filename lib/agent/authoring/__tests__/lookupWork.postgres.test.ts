import { expect, it } from "vitest";
import { z } from "zod";
import { getAuthDb } from "@/lib/auth/db";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { AuthoringAuthorityError } from "@/lib/db/authoringSessions";
import { CommitReauthError } from "@/lib/db/commitGuard";
import {
	applyAuthorizedLookupAuthoringBatch,
	readAuthorizedLookupCatalog,
} from "@/lib/lookup/agentService";
import type { LookupAgentWriteScope } from "@/lib/lookup/types";
import { beginWork, executeWorkTool } from "../session";

const h = setupAppStateTestDb("ordinary_lookup_work_", {
	authSchema: "migrated",
});

it("authors Project tables through new MCP work before app birth and reauthorizes exact retries", async () => {
	const actorUserId = "lookup-author";
	const projectId = "lookup-project";
	const host = { kind: "mcp" } as const;
	await h.seedProjectMember(actorUserId, projectId, "owner");
	await h.seedProjectMember("other-author", projectId, "owner");
	const begun = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { name: "Visits" },
		requestId: "begin",
	});
	const args = { actorUserId, host, workId: begun.workId };
	const input = {
		name: "Venues",
		tag: "venues",
		columns: [
			{
				key: "name",
				wireName: "name",
				label: "Venue",
				dataType: "text" as const,
			},
		],
		rows: [{ cells: [{ columnKey: "name", value: "North clinic" }] }],
	};
	const create = {
		...args,
		toolName: "createLookupTable",
		requestId: "create",
		input,
	};
	const created = await executeWorkTool(create);
	const receipt = z
		.object({
			kind: z.literal("read"),
			data: z.object({
				ok: z.literal(true),
				tableId: z.string(),
				columns: z.array(z.object({ columnId: z.string() })),
				revisions: z.object({ tableRevision: z.string() }),
			}),
		})
		.parse(created).data;
	expect(
		await executeWorkTool({ ...args, toolName: "getLookupTables", input: {} }),
	).toMatchObject({
		kind: "read",
		data: { tables: [{ id: receipt.tableId, name: "Venues" }] },
	});
	const updated = await executeWorkTool({
		...args,
		toolName: "updateLookupTable",
		requestId: "rename",
		input: {
			tableId: receipt.tableId,
			expectedTableRevision: receipt.revisions.tableRevision,
			name: "Outreach venues",
		},
	});
	expect(updated).toMatchObject({
		kind: "read",
		data: { ok: true, tableId: receipt.tableId },
	});
	expect(
		await executeWorkTool({ ...args, toolName: "getLookupTables", input: {} }),
	).toMatchObject({
		kind: "read",
		data: { tables: [{ id: receipt.tableId, name: "Outreach venues" }] },
	});
	expect(
		await executeWorkTool({
			...args,
			toolName: "getLookupTableRows",
			input: { tableId: receipt.tableId },
		}),
	).toMatchObject({
		kind: "read",
		data: {
			rows: [
				{
					cells: [
						{ columnId: receipt.columns[0].columnId, value: "North clinic" },
					],
				},
			],
		},
	});
	expect(await executeWorkTool(create)).toEqual(created);
	expect(
		await h.db().selectFrom("lookup_tables").select("id").execute(),
	).toHaveLength(1);
	expect(
		await h
			.db()
			.selectFrom("lookup_authoring_receipts")
			.select("request_id")
			.execute(),
	).toHaveLength(2);
	expect(await h.db().selectFrom("apps").select("id").execute()).toEqual([]);
	expect(
		await h.db().selectFrom("design_sessions").select("id").execute(),
	).toEqual([]);
	expect(
		await h.db().selectFrom("authoring_workspaces").select("id").execute(),
	).toEqual([]);

	const scope: LookupAgentWriteScope = {
		ordinaryAuthoring: { sessionId: begun.workId, origin: "mcp" },
		projectId,
		actorId: actorUserId,
		runId: begun.workId,
		requestId: "create",
	};
	await expect(
		readAuthorizedLookupCatalog({ ...scope, actorId: "other-author" }),
	).rejects.toBeInstanceOf(AuthoringAuthorityError);
	await expect(
		readAuthorizedLookupCatalog({
			...scope,
			ordinaryAuthoring: {
				sessionId: begun.workId,
				origin: "chat",
				threadId: "another-thread",
			},
		}),
	).rejects.toBeInstanceOf(AuthoringAuthorityError);
	await (await getAuthDb())
		.deleteFrom("auth_member")
		.where("userId", "=", actorUserId)
		.execute();
	await expect(executeWorkTool(create)).rejects.toBeInstanceOf(
		CommitReauthError,
	);
	await expect(
		applyAuthorizedLookupAuthoringBatch(scope, {
			createTables: [
				{
					...input,
					key: "table",
					rows: input.rows.map((row, index) => ({
						...row,
						key: `row-${index}`,
					})),
				},
			],
		}),
	).rejects.toBeInstanceOf(CommitReauthError);
});
