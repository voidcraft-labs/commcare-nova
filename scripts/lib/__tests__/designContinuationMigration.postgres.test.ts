import { describe, expect, it } from "vitest";
import { openDesignModelContext } from "@/lib/agent/build/modelContextStore";
import {
	did,
	fixtureValue,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import {
	normalizeStoredDesignArtifactWorkspaceOperation,
	prepareDesignArtifactWorkspaceOperationForStorage,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	durableModelValueDigest,
	persistModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	migrateDesignContinuation,
	scanDesignContinuationMigration,
} from "../designContinuationMigration";

const h = setupAppStateTestDb("design_continuation_migration_");
async function seed(known = true) {
	const id = await h.seedDesignSession();
	if (known)
		await h
			.db()
			.insertInto("threads")
			.values({
				thread_id: crypto.randomUUID(),
				app_id: null,
				design_session_id: id,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				thread_type: "chat",
				summary: "Migration fixture",
				run_id: "old-run",
				active_stream_id: null,
				messages: JSON.stringify([
					{
						id: "original-user",
						role: "user",
						parts: [{ type: "text", text: "Build this app" }],
					},
				]),
			})
			.execute();
	const contextId = crypto.randomUUID();
	await h
		.db()
		.insertInto("design_model_contexts")
		.values({
			id: contextId,
			design_session_id: id,
			context_kind: "design",
			generation: 0,
			supersedes_context_id: null,
			model_id: "old",
			prompt_version: "old",
			toolset_digest: "a".repeat(64),
			context_version: "old",
			revision: 1,
		})
		.execute();
	const stepKey = `design:old-call:0:${"b".repeat(64)}`;
	const responseDigest = durableModelValueDigest([
		{ role: "assistant", content: "Saved design work" },
	]);
	const message = persistModelMessage({
		role: "assistant",
		content: "Saved design work",
	});
	await h
		.db()
		.insertInto("design_model_context_items")
		.values({
			context_id: contextId,
			ordinal: 1,
			append_key: known
				? `design-response:original-user:author:${stepKey}:${responseDigest}`
				: "unattributed-history",
			append_index: 0,
			item_digest: canonicalJsonDigest(message),
			message: JSON.stringify(message),
			created_by_run_id: "old-run",
		})
		.execute();
	const event = {
		stepKey,
		eventKind: "started",
		requestDigest: "b".repeat(64),
	};
	await h
		.db()
		.insertInto("design_model_steps")
		.values({
			context_id: contextId,
			step_key: stepKey,
			event_kind: "started",
			event_digest: canonicalJsonDigest(event),
			request_digest: event.requestDigest,
			response_digest: null,
			usage: null,
			created_by_run_id: "old-run",
		})
		.execute();
	if (known)
		await h
			.db()
			.insertInto("design_model_steps")
			.values({
				context_id: contextId,
				step_key: stepKey,
				event_kind: "completed",
				event_digest: canonicalJsonDigest({
					stepKey,
					eventKind: "completed",
					responseDigest,
				}),
				request_digest: null,
				response_digest: responseDigest,
				usage: null,
				created_by_run_id: "old-run",
			})
			.execute();
	const session = await h
		.db()
		.selectFrom("design_sessions")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return {
		contextId,
		stepKey,
		args: {
			designSessionId: id,
			actorUserId: session.owner_user_id,
			expectedUpdatedAt: session.updated_at.toISOString(),
			execute: true,
		},
	};
}

describe("one-time design continuation migration", () => {
	it("appends menu conversion atomically and keeps original operations intact", async () => {
		const { args } = await seed();
		const source = makeNestedMenuContract();
		const parent = fixtureValue(source.moduleCompositions[0], "parent");
		const child = {
			...fixtureValue(source.moduleCompositions[1], "child"),
			parentModuleCompositionId: undefined,
		};
		const sibling = { ...child, id: did(999) };
		const operations = [
			[parent, child, sibling],
			[{ ...child, parentModuleCompositionId: parent.id }],
			[child],
		].map((upserts) =>
			normalizeStoredDesignArtifactWorkspaceOperation({
				storageVersion: 2,
				operation: {
					kind: "contract",
					collections: [
						{ collection: "moduleCompositions", upserts, removeIds: [] },
					],
				},
			}),
		);
		const workspaceId = crypto.randomUUID();
		const lineage = {
			schemaVersion: 1,
			artifactKind: "contract",
			sourcePackageDigest: "a".repeat(64),
			reviewArtifacts: [],
		};
		await h
			.db()
			.insertInto("design_artifact_workspaces")
			.values({
				id: workspaceId,
				design_session_id: args.designSessionId,
				artifact_kind: "contract",
				lineage: JSON.stringify(lineage),
				lineage_digest: canonicalJsonDigest(lineage),
				revision: operations.length,
				status: "open",
				finalized_artifact_id: null,
				created_by_run_id: "old",
				updated_by_run_id: "old",
				finalized_at: null,
			})
			.execute();
		for (const [index, operation] of operations.entries())
			await h
				.db()
				.insertInto("design_artifact_workspace_steps")
				.values({
					workspace_id: workspaceId,
					revision: index + 1,
					tool_call_id: `old-${index}`,
					input_digest: canonicalJsonDigest({ operation, handleBindings: [] }),
					operation: JSON.stringify(
						prepareDesignArtifactWorkspaceOperationForStorage(operation),
					),
					created_by_run_id: "old",
				})
				.execute();
		const before = await h
			.db()
			.selectFrom("design_artifact_workspace_steps")
			.selectAll()
			.orderBy("revision")
			.execute();
		expect(
			await migrateDesignContinuation({ ...args, execute: false }),
		).toMatchObject({ workspaces: 1 });
		expect(
			await h
				.db()
				.selectFrom("design_artifact_workspace_steps")
				.selectAll()
				.orderBy("revision")
				.execute(),
		).toEqual(before);
		expect(await migrateDesignContinuation(args)).toMatchObject({
			workspaces: 1,
		});
		const after = await h
			.db()
			.selectFrom("design_artifact_workspace_steps")
			.selectAll()
			.orderBy("revision")
			.execute();
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.length).toBeGreaterThan(before.length);
		const candidate = replayDesignWorkspace({
			kind: "contract",
			operations: after.map((row) =>
				normalizeStoredDesignArtifactWorkspaceOperation(row.operation),
			),
		});
		expect(
			(candidate.moduleCompositions as { id: string }[]).map((menu) => menu.id),
		).toEqual([parent.id, child.id, sibling.id]);
		expect(await migrateDesignContinuation(args)).toMatchObject({
			deduplicated: true,
		});
		expect(await scanDesignContinuationMigration()).toEqual([]);
	});
	it("rejects altered completed response evidence without backfilling any start", async () => {
		const { args, contextId } = await seed();
		await h
			.db()
			.updateTable("design_model_context_items")
			.set({ item_digest: "f".repeat(64) })
			.where("context_id", "=", contextId)
			.execute();
		await expect(migrateDesignContinuation(args)).rejects.toThrow(
			"item no longer matches its digest",
		);
		expect(
			(
				await h
					.db()
					.selectFrom("design_model_steps")
					.selectAll()
					.where("event_kind", "=", "started")
					.executeTakeFirstOrThrow()
			).turn_provenance_id,
		).toBeNull();
	});

	it("backfills exact provenance without changing original evidence, and is idempotent", async () => {
		const { args, contextId } = await seed();
		const before = await h
			.db()
			.selectFrom("design_model_steps")
			.selectAll()
			.orderBy("event_kind")
			.execute();
		expect(
			(await scanDesignContinuationMigration()).map((row) => row.id),
		).toContain(args.designSessionId);
		expect(
			await migrateDesignContinuation({ ...args, execute: false }),
		).toMatchObject({ steps: 1, unresolved: [] });
		expect(
			await h
				.db()
				.selectFrom("design_model_steps")
				.selectAll()
				.orderBy("event_kind")
				.execute(),
		).toEqual(before);
		expect(await migrateDesignContinuation(args)).toMatchObject({
			steps: 1,
			unresolved: [],
		});
		const after = await h
			.db()
			.selectFrom("design_model_steps")
			.selectAll()
			.orderBy("event_kind")
			.execute();
		expect(after).toEqual(
			before.map((row) =>
				row.event_kind === "completed"
					? row
					: {
							...row,
							turn_provenance_id: "original-user",
							turn_provenance_digest: canonicalJsonDigest({
								contextId,
								stepKey: row.step_key,
								turnProvenanceId: "original-user",
								eventDigest: row.event_digest,
							}),
						},
			),
		);
		expect(await migrateDesignContinuation(args)).toMatchObject({
			deduplicated: true,
		});
		expect(await scanDesignContinuationMigration()).toEqual([]);
	});
	it("refuses ambiguous attribution without an inspected assignment and writes nothing", async () => {
		const { args, contextId, stepKey } = await seed(false);
		expect(
			await migrateDesignContinuation({ ...args, execute: false }),
		).toMatchObject({ unresolved: [`${contextId}/${stepKey}`] });
		await expect(migrateDesignContinuation(args)).rejects.toThrow(
			"Unresolved historical turn provenance",
		);
		expect(
			(await h.db().selectFrom("design_model_steps").selectAll().execute())[0]
				?.turn_provenance_id,
		).toBeNull();
		expect(
			await migrateDesignContinuation({
				...args,
				turnAssignments: {
					[`${contextId}/${stepKey}`]: "inspected-original-user",
				},
			}),
		).toMatchObject({ steps: 1, unresolved: [] });
	});
	it("checks owner, holder freedom, membership, and the inspected timestamp", async () => {
		const { args } = await seed();
		await expect(
			migrateDesignContinuation({ ...args, actorUserId: "wrong-owner" }),
		).rejects.toThrow("owner");
		await expect(
			migrateDesignContinuation({
				...args,
				expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow("changed after inspection");
		await h
			.pool()
			.query('DELETE FROM auth_member WHERE "userId" = $1', [args.actorUserId]);
		await expect(migrateDesignContinuation(args)).rejects.toThrow(
			"Project edit access",
		);
	});
	it("fails closed on unmigrated starts before a provider can be opened", async () => {
		const { args } = await seed();
		const runId = "migration-test-run";
		const nonce = crypto.randomUUID();
		await h
			.db()
			.updateTable("design_sessions")
			.set({
				run_id: runId,
				run_actor_user_id: args.actorUserId,
				run_holder_nonce: nonce,
				run_mode: "build",
				run_lease_expires_at: new Date(Date.now() + 60000),
				res_period: "2026-09",
				res_reserved: 1,
				res_settled: false,
				res_user_id: args.actorUserId,
				res_run_id: runId,
			})
			.where("id", "=", args.designSessionId)
			.execute();
		await expect(migrateDesignContinuation(args)).rejects.toThrow(
			"no run holder",
		);
		await expect(
			openDesignModelContext({
				designSessionId: args.designSessionId,
				kind: "design",
				modelId: "old",
				promptVersion: "old",
				toolsetDigest: "a".repeat(64),
				contextVersion: "old",
				authority: {
					actorUserId: args.actorUserId,
					runId,
					holderNonce: nonce,
					expectedProjectId: "project-test",
				},
			}),
		).rejects.toThrow("one-time design continuation migration");
	});
});
