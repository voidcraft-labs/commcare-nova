import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import {
	readDesignBuildPlan,
	readDesignRevision,
	readDesignRevisionsForSession,
	readDesignSourcePackage,
} from "@/lib/agent/design/artifactStore";
import {
	designArtifactEnvelopeSchema,
	sealArtifactEnvelope,
	verifyArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { DESIGN_WORKSPACE_OPERATION_STORAGE_VERSION } from "@/lib/agent/design/formats";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { claimAndReserveRun, completeAndSettleRun } from "@/lib/db/apps";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import {
	generationTargetHeldLive,
	resolveGenerationTargetScope,
} from "@/lib/db/generationTargetScope";
import { loadThread, upsertThreadTurn } from "@/lib/db/threads";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	retireObsoleteDesignSession,
	scanObsoleteDesignFormats,
} from "../retireDesignFormats";
import legacyContract from "./fixtures/design-contract-v1.json";
import selectionContract from "./fixtures/design-contract-v2.json";

const h = setupAppStateTestDb("retire_design_formats_", {
	poolMax: 3,
	authSchema: "migrated",
});
const actor = "owner-test";
const project = "proj-1";
const digest = "a".repeat(64);
const oldRun = "historical-design";

/** Original contracts captured at 1237d2e5 (v1) and e4ea6aa7 (v2). */
async function seedRevision(
	sessionId: string,
	payload: { schemaVersion: number } = legacyContract,
) {
	const envelope = sealArtifactEnvelope({
		artifactType: "design-contract",
		artifactSchemaVersion: payload.schemaVersion,
		artifactId: randomUUID(),
		designSessionId: sessionId,
		revision: 1,
		parentArtifactId: null,
		sourcePackageDigest: digest,
		inputArtifactDigests: [],
		promptVersion: "design-agent-v33",
		producer: { provider: "test", modelId: "fixture", finishReason: "stop" },
		createdAt: new Date().toISOString(),
		payload,
	});
	designArtifactEnvelopeSchema(
		"design-contract",
		z.object({ schemaVersion: z.number() }).passthrough(),
	).parse(envelope);
	verifyArtifactEnvelope(envelope);
	await h
		.db()
		.insertInto("design_revisions")
		.values({
			id: envelope.artifactId,
			design_session_id: sessionId,
			revision: 1,
			parent_revision_id: null,
			lifecycle: "draft",
			artifact_digest: envelope.artifactDigest,
			contract_digest: canonicalJsonDigest(payload),
			source_package_digest: digest,
			producer_model: "fixture",
			prompt_version: envelope.promptVersion,
			created_by_run_id: oldRun,
			envelope: JSON.stringify(envelope),
		})
		.execute();
	return envelope.artifactId;
}

async function seedUsage(sessionId: string, accounted: boolean) {
	const contextId = randomUUID();
	await h
		.db()
		.insertInto("design_model_contexts")
		.values({
			id: contextId,
			design_session_id: sessionId,
			context_kind: "design",
			generation: 0,
			supersedes_context_id: null,
			model_id: "fixture",
			prompt_version: "design-agent-v33",
			toolset_digest: digest,
			context_version: "old-design",
			revision: 0,
		})
		.execute();
	await h
		.db()
		.insertInto("design_model_steps")
		.values({
			context_id: contextId,
			step_key: "response",
			event_kind: "completed",
			event_digest: digest,
			request_digest: null,
			response_digest: digest,
			usage: JSON.stringify({
				inputTokens: 20,
				outputTokens: 10,
				totalTokens: 30,
			}),
			created_by_run_id: oldRun,
		})
		.execute();
	if (accounted)
		await h
			.db()
			.insertInto("design_model_step_usage_accounts")
			.values({
				context_id: contextId,
				step_key: "response",
				event_kind: "completed",
				run_id: oldRun,
			})
			.execute();
	await h
		.db()
		.insertInto("run_summaries")
		.values({
			app_id: null,
			design_session_id: sessionId,
			run_id: oldRun,
			started_at: "2026-09-12T12:00:00Z",
			finished_at: "2026-09-12T12:00:01Z",
			prompt_mode: "build",
			app_ready: false,
			module_count: 0,
			step_count: 1,
			model: "fixture",
			input_tokens: 20,
			output_tokens: 10,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			cost_estimate: 0.001,
			tool_call_count: 0,
		})
		.execute();
	return contextId;
}

async function seedWorkspace(
	sessionId: string,
	storageVersion: 2 | 3 | typeof DESIGN_WORKSPACE_OPERATION_STORAGE_VERSION,
) {
	const workspaceId = randomUUID();
	const lineage = {
		schemaVersion: 1,
		artifactKind: "contract",
		sourcePackageDigest: digest,
		reviewArtifacts: [],
	};
	const operation = {
		kind: "contract",
		root: { id: legacyContract.id, charter: legacyContract.charter },
		collections:
			storageVersion === 2
				? [
						{
							collection: "navigation",
							upserts: legacyContract.navigation,
							removeIds: [],
						},
					]
				: storageVersion === 3
					? [
							{
								collection: "moduleCompositions",
								upserts: selectionContract.moduleCompositions,
								removeIds: [],
							},
						]
					: [],
	};
	await h
		.db()
		.insertInto("design_artifact_workspaces")
		.values({
			id: workspaceId,
			design_session_id: sessionId,
			artifact_kind: "contract",
			lineage_digest: canonicalJsonDigest(lineage),
			lineage: JSON.stringify(lineage),
			revision: 1,
			status: "open",
			finalized_artifact_id: null,
			created_by_run_id: oldRun,
			updated_by_run_id: oldRun,
			finalized_at: null,
		})
		.execute();
	await h
		.db()
		.insertInto("design_artifact_workspace_steps")
		.values({
			workspace_id: workspaceId,
			revision: 1,
			tool_call_id: "root",
			input_digest: canonicalJsonDigest(operation),
			operation: JSON.stringify({ storageVersion, operation }),
			created_by_run_id: oldRun,
		})
		.execute();
	return workspaceId;
}

async function immutableSnapshot(appId: string, sessionId: string) {
	const result = await sql<{ snapshot: string }>`select jsonb_build_object(
		'app', (select to_jsonb(a) from apps a where id = ${appId}),
		'entities', (select jsonb_agg(to_jsonb(e) order by uuid) from blueprint_entities e where app_id = ${appId}),
		'revisions', (select jsonb_agg(to_jsonb(r) order by id) from design_revisions r where design_session_id = ${sessionId}::uuid),
		'contexts', (select jsonb_agg(to_jsonb(c) order by id) from design_model_contexts c where design_session_id = ${sessionId}::uuid),
		'steps', (select jsonb_agg(to_jsonb(s) order by context_id, step_key) from design_model_steps s),
		'accounts', (select jsonb_agg(to_jsonb(a) order by context_id, step_key) from design_model_step_usage_accounts a),
		'runs', (select jsonb_agg(to_jsonb(r) order by run_id) from run_summaries r)
	)::text as snapshot`.execute(h.db());
	return result.rows[0]?.snapshot;
}

describe("one-time design-format retirement", () => {
	it("retires a version-2 design without rewriting its sealed selection metadata", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
		});
		const revisionId = await seedRevision(sessionId, selectionContract);
		const readBytes = () =>
			h
				.pool()
				.query("SELECT envelope::text FROM design_revisions WHERE id = $1", [
					revisionId,
				]);
		const before = await readBytes();
		await expect(readDesignRevision(revisionId)).rejects.toThrow();
		expect(await scanObsoleteDesignFormats()).toMatchObject([
			{ sessionId, status: "ready", obsoleteRevisions: 1 },
		]);
		expect((await readBytes()).rows).toEqual(before.rows);
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
		});
		expect((await readBytes()).rows).toEqual(before.rows);
		expect(await readDesignRevision(revisionId)).toBeNull();
		expect(await scanObsoleteDesignFormats()).toEqual([]);
	});

	it.each([2, 3] as const)(
		"retires version-%i workspace-only sessions and preserves current private work",
		async (storageVersion) => {
			const oldSession = await h.seedDesignSession({
				owner_user_id: actor,
				project_id: project,
			});
			const currentSession = await h.seedDesignSession({
				owner_user_id: actor,
				project_id: project,
			});
			const oldWorkspace = await seedWorkspace(oldSession, storageVersion);
			const currentWorkspace = await seedWorkspace(
				currentSession,
				DESIGN_WORKSPACE_OPERATION_STORAGE_VERSION,
			);
			const steps = await h
				.pool()
				.query(
					"SELECT operation::text FROM design_artifact_workspace_steps ORDER BY workspace_id",
				);
			expect(await scanObsoleteDesignFormats()).toMatchObject([
				{
					sessionId: oldSession,
					obsoleteRevisions: 0,
					obsoleteOperations: 1,
					status: "ready",
				},
			]);
			expect(await retireObsoleteDesignSession(oldSession)).toMatchObject({
				status: "retired",
			});
			expect(await retireObsoleteDesignSession(currentSession)).toMatchObject({
				status: "current",
			});
			expect(
				(
					await h
						.pool()
						.query(
							"SELECT operation::text FROM design_artifact_workspace_steps ORDER BY workspace_id",
						)
				).rows,
			).toEqual(steps.rows);
			expect(
				await h
					.db()
					.selectFrom("design_artifact_workspaces")
					.select("status")
					.where("id", "=", oldWorkspace)
					.executeTakeFirst(),
			).toEqual({ status: "superseded" });
			expect(
				await h
					.db()
					.selectFrom("design_artifact_workspaces")
					.select("status")
					.where("id", "=", currentWorkspace)
					.executeTakeFirst(),
			).toEqual({ status: "open" });
		},
	);

	it("refuses a stale paused holder and an unfinished canonical app", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
			awaiting_input: true,
			run_id: oldRun,
			run_holder_nonce: randomUUID(),
			run_actor_user_id: actor,
			run_lease_expires_at: new Date(Date.now() - 60_000),
		});
		await seedWorkspace(sessionId, 2);
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "busy",
		});
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status: "error",
		});
		const unfinished = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
			state: "materialized",
			app_id: appId,
		});
		await seedRevision(unfinished);
		expect(await retireObsoleteDesignSession(unfinished)).toMatchObject({
			status: "incomplete-app",
		});
		expect((await h.readAppRow(appId))?.status).toBe("error");
	});

	it("preserves sealed history and billing while returning an app conversation to ordinary editing", async () => {
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status: "complete",
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
			app_id: appId,
			state: "materialized",
		});
		const revisionId = await seedRevision(sessionId);
		await seedUsage(sessionId, true);
		const threadId = randomUUID();
		const messages = [
			{
				id: "request",
				role: "user" as const,
				parts: [{ type: "text" as const, text: "Track visits." }],
			},
		];
		await h
			.db()
			.insertInto("threads")
			.values({
				thread_id: threadId,
				app_id: null,
				design_session_id: sessionId,
				thread_type: "build",
				summary: "Visits",
				run_id: oldRun,
				active_stream_id: null,
				active_holder_nonce: null,
				created_at: "2026-09-12T12:00:00Z",
				updated_at: "2026-09-12T12:00:01Z",
				messages: JSON.stringify(messages),
			})
			.execute();
		const before = await immutableSnapshot(appId, sessionId);
		await expect(readDesignRevision(revisionId)).rejects.toThrow();
		expect(await scanObsoleteDesignFormats()).toMatchObject([
			{ sessionId, status: "ready", obsoleteRevisions: 1, threads: 1 },
		]);
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
		});
		expect(await immutableSnapshot(appId, sessionId)).toBe(before);
		expect(await readDesignRevision(revisionId)).toBeNull();
		expect(await readDesignRevisionsForSession(sessionId)).toEqual([]);
		expect(await scanObsoleteDesignFormats()).toEqual([]);
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
		});
		expect(
			(await loadThread({ kind: "app", appId }, threadId, actor))?.messages,
		).toEqual(messages);
		const target = {
			kind: "design-session" as const,
			designSessionId: sessionId,
		};
		await expect(resolveGenerationTargetScope(target, actor)).rejects.toThrow();
		const runId = "new-app-edit";
		const nonce = randomUUID();
		await claimAndReserveRun(appId, "edit", runId, actor, 1, project, nonce);
		try {
			expect(await generationTargetHeldLive(target)).toBe(false);
			await expect(
				h.withTransaction((tx) =>
					assertDesignSessionRunAuthorityInTransaction(tx, {
						designSessionId: sessionId,
						actorUserId: actor,
						expectedProjectId: project,
						holder: { mode: "edit", runId, nonce },
					}),
				),
			).rejects.toThrow();
			const turn = {
				threadId,
				runId,
				streamId: "new-stream",
				holderNonce: nonce,
				threadType: "edit" as const,
				messages,
				expectedProjectId: project,
			};
			await expect(upsertThreadTurn({ ...turn, target })).rejects.toThrow();
			expect(
				await upsertThreadTurn({ ...turn, target: { kind: "app", appId } }),
			).toBe(true);
		} finally {
			await completeAndSettleRun(appId, runId, nonce);
		}
	});

	it("blocks retirement until completed model usage has been accounted", async () => {
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
		});
		await seedRevision(sessionId);
		const contextId = await seedUsage(sessionId, false);
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "unaccounted-usage",
		});
		await h
			.db()
			.insertInto("design_model_step_usage_accounts")
			.values({
				context_id: contextId,
				step_key: "response",
				event_kind: "completed",
				run_id: oldRun,
			})
			.execute();
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
		});
	});

	it("blocks unaccounted localization usage and keeps its completed evidence after retirement", async () => {
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status: "complete",
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
			app_id: appId,
			state: "materialized",
		});
		// This test concerns ledger admission, not artifact content. The shared
		// fixture supplies the real foreign-key lineage for the paid batch.
		const lineage = await h.seedDesignLineage({
			existingSessionId: sessionId,
			project_id: project,
		});
		const attemptId = randomUUID();
		const batchId = randomUUID();
		await h
			.db()
			.insertInto("design_localization_attempts")
			.values({
				id: attemptId,
				design_session_id: sessionId,
				design_revision_id: lineage.designRevisionId,
				design_revision_digest: lineage.designRevisionDigest,
				build_plan_id: lineage.buildPlanId,
				build_plan_digest: lineage.buildPlanDigest,
				app_id: appId,
				source_seq: 1,
				source_snapshot_digest: digest,
				intent_digest: digest,
				intent: JSON.stringify({}),
				status: "committed",
				committed_seq: 2,
				committed_batch_id: "completed-localization",
				committed_snapshot_digest: digest,
				created_by_run_id: oldRun,
				updated_by_run_id: oldRun,
			})
			.execute();
		await h
			.db()
			.insertInto("design_localization_batches")
			.values({
				id: batchId,
				attempt_id: attemptId,
				batch_index: 0,
				source_language: "eng",
				target_language: "spa",
				unit_ids: JSON.stringify(["field-label"]),
				input_digest: digest,
				model_id: "historical-translator",
				prompt_version: "fixture-v1",
				schema_version: "fixture-v1",
				status: "accepted",
				claim_token: randomUUID(),
				claimed_by_run_id: oldRun,
				output: JSON.stringify({ label: "Nombre" }),
				usage: JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
				failure_code: null,
			})
			.execute();
		const snapshot = async () => {
			const result = await sql<{ value: string }>`select jsonb_build_object(
				'attempt', (select to_jsonb(a) from design_localization_attempts a where id = ${attemptId}::uuid),
				'batch', (select to_jsonb(b) from design_localization_batches b where id = ${batchId}::uuid),
				'account', (select to_jsonb(a) from design_localization_batch_usage_accounts a where batch_id = ${batchId}::uuid)
			)::text as value`.execute(h.db());
			return result.rows[0]?.value;
		};
		const beforeAccounting = await snapshot();
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "unaccounted-usage",
		});
		expect(await snapshot()).toBe(beforeAccounting);
		await h
			.db()
			.insertInto("design_localization_batch_usage_accounts")
			.values({
				batch_id: batchId,
				run_id: oldRun,
			})
			.execute();
		const accounted = await snapshot();
		const source = await h
			.db()
			.selectFrom("design_source_packages")
			.select("package_digest")
			.where("design_session_id", "=", sessionId)
			.executeTakeFirstOrThrow();
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
		});
		expect(await snapshot()).toBe(accounted);
		expect(await readDesignBuildPlan(lineage.buildPlanId)).toBeNull();
		expect(
			await readDesignSourcePackage(sessionId, source.package_digest),
		).toBeNull();
	});

	it("rechecks app ownership after waiting for its lock", async () => {
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status: "complete",
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
			app_id: appId,
			state: "materialized",
		});
		await seedRevision(sessionId);
		const result = await whileBlocked(
			h,
			(pg) => pg.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [appId]),
			() => retireObsoleteDesignSession(sessionId),
			async (settled, pg) => {
				expect(settled).toBe(false);
				await pg.query(
					"UPDATE apps SET lock_run_id = 'winning-edit', lock_actor_user_id = $2, lock_expire_at = now() + interval '1 minute', run_holder_nonce = $3 WHERE id = $1",
					[appId, actor, randomUUID()],
				);
			},
			undefined,
			"COMMIT",
		);
		expect(result).toMatchObject({ status: "busy" });
		expect((await h.readDesignSessionRow(sessionId))?.state).toBe(
			"materialized",
		);
	});

	it("retries through app-first locking when materialization wins the pre-app session lock", async () => {
		const appId = await h.seedApp({
			owner: actor,
			project_id: project,
			status: "complete",
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: actor,
			project_id: project,
		});
		await seedRevision(sessionId);
		const result = await whileBlocked(
			h,
			(pg) =>
				pg.query("SELECT id FROM design_sessions WHERE id = $1 FOR UPDATE", [
					sessionId,
				]),
			() => retireObsoleteDesignSession(sessionId),
			async (settled, pg) => {
				expect(settled).toBe(false);
				await pg.query(
					"UPDATE design_sessions SET app_id = $2, state = 'materialized' WHERE id = $1",
					[sessionId, appId],
				);
			},
			undefined,
			"COMMIT",
		);
		expect(result).toMatchObject({ status: "retry", appId });
		expect(await retireObsoleteDesignSession(sessionId)).toMatchObject({
			status: "retired",
			appId,
		});
	});
});
