/**
 * Reads that hold a sequence behind a fold horizon answer from the saved app.
 *
 * Rows behind a stored-shape cutover's horizon are opaque history in an
 * earlier dialect, so a finished build whose recorded sequence precedes the
 * app's greatest fold baseline must not fold there, and answering from the
 * saved app is no error. A retried batch whose id latched behind the horizon
 * replays without parsing its old-dialect row. The genesis receipt reader is
 * held beside its own fixtures (`materializeGenesis.postgres.test.ts`) and the
 * stream route beside its relay (`stream.postgres.test.ts`), each with the
 * same two checks. Each check also runs across two horizons, step 2's and
 * step 3's, where a sequence between them and one below both answer alike,
 * and across three, with step 5's above both, where a sequence behind the
 * sixth identity's horizon answers from the saved app wherever it sits.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { runBuildOrchestration } from "@/lib/agent/build/orchestrator";
import { completeBuildOrchestration } from "@/lib/agent/build/orchestratorState";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch, loadApp } from "@/lib/db/apps";
import { MutationBatchIdCollisionError } from "@/lib/db/commitGuard";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { log } from "@/lib/logger";
import { greatestFoldBaselineSeq } from "../baseLoader";
import {
	writeHqRoundTripCaseWritesHorizon,
	writeHqRoundTripExpressionsHorizon,
	writeHqRoundTripHorizon,
} from "./foldHorizonFixture";

const h = setupAppStateTestDb("pre_horizon_reads_", {
	authSchema: "migrated",
});

const RUN = "run-pre-horizon";
const NONCE = "6a0a35a4-1111-4222-8333-944445555777";
const ACTOR = "owner-test";
const PROJECT = "project-test";

/** History rows no current parser reads, as a pre-cutover dialect leaves. */
async function writeOldDialectHistory(
	appId: string,
	through: number,
	from = 1,
) {
	await sql`ALTER TABLE app_changes DISABLE TRIGGER app_changes_admit_insert`.execute(
		h.db(),
	);
	try {
		for (let seq = from; seq <= through; seq++) {
			await h
				.db()
				.insertInto("app_changes")
				.values({
					app_id: appId,
					seq,
					batch_id: `old-dialect-${seq}`,
					run_id: null,
					actor_id: ACTOR,
					kind: "autosave",
					mutations: JSON.stringify([
						{ kind: "retired-pre-horizon-vocabulary", hint_media: seq },
					]),
					from_project_id: null,
					to_project_id: null,
				})
				.execute();
		}
	} finally {
		await sql`ALTER TABLE app_changes ENABLE TRIGGER app_changes_admit_insert`.execute(
			h.db(),
		);
	}
	await h
		.db()
		.updateTable("apps")
		.set({ mutation_seq: through })
		.where("id", "=", appId)
		.execute();
}

describe("pre-horizon reads", () => {
	it("admits the HQ round-trip emission horizon and refuses an invented operator identity", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		await expect(greatestFoldBaselineSeq(h.db(), appId)).resolves.toBeNull();
		await expect(
			h
				.db()
				.insertInto("app_changes")
				.values({
					app_id: appId,
					seq: 1,
					batch_id: "fold-baseline:invented-cutover",
					run_id: null,
					actor_id: "system:invented-cutover",
					kind: "fold-baseline",
					mutations: "[]",
					from_project_id: null,
					to_project_id: null,
				})
				.execute(),
		).rejects.toThrow(/only an exact fold marker/);

		const horizon = await writeHqRoundTripHorizon(h.db(), appId, "Renamed");
		await expect(greatestFoldBaselineSeq(h.db(), appId)).resolves.toBe(horizon);
	});

	it("answers a finished build recorded behind a horizon from the saved app", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_id: RUN,
			run_holder_nonce: NONCE,
			reservation: {
				period: "2026-10",
				reserved: 1,
				settled: false,
				userId: ACTOR,
				runId: RUN,
			},
		});
		await writeOldDialectHistory(appId, 2);
		const designSessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
		});
		await completeBuildOrchestration({
			designSessionId,
			runId: RUN,
			holderNonce: NONCE,
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
			appId,
			expectedSeq: 2,
			expectedHead: null,
		});
		const horizon = await writeHqRoundTripHorizon(
			h.db(),
			appId,
			"After the cutover",
		);

		const written: unknown[] = [];
		const outcome = await runBuildOrchestration({
			designSessionId,
			proposedAppId: appId,
			projectId: PROJECT,
			projectRole: "owner",
			actorUserId: ACTOR,
			runId: "run-after-cutover",
			holderNonce: crypto.randomUUID(),
			threadId: "thread",
			messages: [],
			responseMessageId: "response",
			writer: { write: (chunk) => written.push(chunk) },
			apiKey: "synthetic-local-only",
			meter: undefined,
			signal: new AbortController().signal,
			materializedAppId: appId,
			finalizeCompletion: async () => {
				throw new Error("A finished build does not complete again.");
			},
		});

		const saved = await loadApp(appId);
		expect(saved?.blueprint.appName).toBe("After the cutover");
		expect(outcome).toEqual({
			kind: "completed",
			appId,
			finalSeq: horizon,
			finalBlueprint: saved?.blueprint,
		});
		expect(written).toEqual([]);
		expect(log.error).not.toHaveBeenCalled();
		expect(log.critical).not.toHaveBeenCalled();
	});

	it("replays a batch whose id latched behind a horizon without reading its old dialect", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		await writeOldDialectHistory(appId, 2);
		const horizon = await writeHqRoundTripHorizon(
			h.db(),
			appId,
			"After the cutover",
		);
		const retry = {
			appId,
			expectedProjectId: PROJECT,
			batchId: "old-dialect-2",
			mutations: admitMutationBatch([
				{ kind: "setAppName", name: "A retried rename" },
			]),
			actorUserId: ACTOR,
			kind: "autosave",
		} as const;

		const replay = await commitGuardedBatch(retry);
		expect(replay).toMatchObject({ seq: 2, deduped: true });
		expect(replay.committedDoc.appName).toBe("After the cutover");
		const saved = await loadApp(appId);
		expect(saved?.mutation_seq).toBe(horizon);
		expect(saved?.blueprint.appName).toBe("After the cutover");

		await expect(
			commitGuardedBatch({ ...retry, kind: "mcp" }),
		).rejects.toBeInstanceOf(MutationBatchIdCollisionError);
		expect((await loadApp(appId))?.mutation_seq).toBe(horizon);
		expect(log.error).not.toHaveBeenCalled();
		expect(log.critical).not.toHaveBeenCalled();
	});

	it("admits the expressions horizon above the emission horizon, only with its own actor", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		const first = await writeHqRoundTripHorizon(h.db(), appId, "Emission");
		await expect(
			h
				.db()
				.insertInto("app_changes")
				.values({
					app_id: appId,
					seq: first + 1,
					batch_id: "fold-baseline:hq-round-trip-expressions",
					run_id: null,
					actor_id: "system:hq-round-trip-emission",
					kind: "fold-baseline",
					mutations: "[]",
					from_project_id: null,
					to_project_id: null,
				})
				.execute(),
		).rejects.toThrow(/only an exact fold marker/);

		const second = await writeHqRoundTripExpressionsHorizon(
			h.db(),
			appId,
			"Expressions",
		);
		expect(second).toBe(first + 1);
		await expect(greatestFoldBaselineSeq(h.db(), appId)).resolves.toBe(second);
		const baselines = await h
			.db()
			.selectFrom("app_change_fold_baselines")
			.select("seq")
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute();
		expect(baselines.map((row) => Number(row.seq))).toEqual([first, second]);
		const saved = await loadApp(appId);
		expect(saved?.mutation_seq).toBe(second);
		expect(saved?.blueprint.appName).toBe("Expressions");
	});

	it.each([
		{ where: "between the two horizons", between: true },
		{ where: "below both horizons", between: false },
	])(
		"answers a finished build recorded $where from the saved app",
		async ({ between }) => {
			const appId = await h.seedApp({
				id: crypto.randomUUID(),
				owner: ACTOR,
				project_id: PROJECT,
				status: "generating",
				run_id: RUN,
				run_holder_nonce: NONCE,
				reservation: {
					period: "2026-10",
					reserved: 1,
					settled: false,
					userId: ACTOR,
					runId: RUN,
				},
			});
			await writeOldDialectHistory(appId, 2);
			const designSessionId = await h.seedDesignSession({
				owner_user_id: ACTOR,
				project_id: PROJECT,
				proposed_app_id: appId,
				app_id: appId,
				state: "materialized",
			});
			const emission = between
				? await writeHqRoundTripHorizon(h.db(), appId, "After step 2")
				: null;
			await completeBuildOrchestration({
				designSessionId,
				runId: RUN,
				holderNonce: NONCE,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				appId,
				expectedSeq: emission ?? 2,
				expectedHead: null,
			});
			if (!between) {
				await writeHqRoundTripHorizon(h.db(), appId, "After step 2");
			}
			const horizon = await writeHqRoundTripExpressionsHorizon(
				h.db(),
				appId,
				"After step 3",
			);

			const written: unknown[] = [];
			const outcome = await runBuildOrchestration({
				designSessionId,
				proposedAppId: appId,
				projectId: PROJECT,
				projectRole: "owner",
				actorUserId: ACTOR,
				runId: "run-after-cutover",
				holderNonce: crypto.randomUUID(),
				threadId: "thread",
				messages: [],
				responseMessageId: "response",
				writer: { write: (chunk) => written.push(chunk) },
				apiKey: "synthetic-local-only",
				meter: undefined,
				signal: new AbortController().signal,
				materializedAppId: appId,
				finalizeCompletion: async () => {
					throw new Error("A finished build does not complete again.");
				},
			});

			const saved = await loadApp(appId);
			expect(saved?.blueprint.appName).toBe("After step 3");
			expect(outcome).toEqual({
				kind: "completed",
				appId,
				finalSeq: horizon,
				finalBlueprint: saved?.blueprint,
			});
			expect(written).toEqual([]);
			expect(log.error).not.toHaveBeenCalled();
			expect(log.critical).not.toHaveBeenCalled();
		},
	);

	it("replays a batch whose id latched between two horizons, or below both, without reading its old dialect", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		await writeOldDialectHistory(appId, 2);
		const emission = await writeHqRoundTripHorizon(
			h.db(),
			appId,
			"After step 2",
		);
		await writeOldDialectHistory(appId, emission + 1, emission + 1);
		const horizon = await writeHqRoundTripExpressionsHorizon(
			h.db(),
			appId,
			"After step 3",
		);
		expect(horizon).toBe(emission + 2);

		for (const seq of [emission + 1, 2]) {
			const replay = await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: `old-dialect-${seq}`,
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: "A retried rename" },
				]),
				actorUserId: ACTOR,
				kind: "autosave",
			});
			expect(replay).toMatchObject({ seq, deduped: true });
			expect(replay.committedDoc.appName).toBe("After step 3");
		}
		const saved = await loadApp(appId);
		expect(saved?.mutation_seq).toBe(horizon);
		expect(saved?.blueprint.appName).toBe("After step 3");
		expect(log.error).not.toHaveBeenCalled();
		expect(log.critical).not.toHaveBeenCalled();
	});

	it("admits the case-writes horizon above the expressions horizon, only with its own actor", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		const first = await writeHqRoundTripHorizon(h.db(), appId, "Emission");
		const second = await writeHqRoundTripExpressionsHorizon(
			h.db(),
			appId,
			"Expressions",
		);
		await expect(
			h
				.db()
				.insertInto("app_changes")
				.values({
					app_id: appId,
					seq: second + 1,
					batch_id: "fold-baseline:hq-round-trip-case-writes",
					run_id: null,
					actor_id: "system:hq-round-trip-expressions",
					kind: "fold-baseline",
					mutations: "[]",
					from_project_id: null,
					to_project_id: null,
				})
				.execute(),
		).rejects.toThrow(/only an exact fold marker/);

		const third = await writeHqRoundTripCaseWritesHorizon(
			h.db(),
			appId,
			"Case writes",
		);
		expect(third).toBe(second + 1);
		await expect(greatestFoldBaselineSeq(h.db(), appId)).resolves.toBe(third);
		const baselines = await h
			.db()
			.selectFrom("app_change_fold_baselines")
			.select("seq")
			.where("app_id", "=", appId)
			.orderBy("seq")
			.execute();
		expect(baselines.map((row) => Number(row.seq))).toEqual([
			first,
			second,
			third,
		]);
		const saved = await loadApp(appId);
		expect(saved?.mutation_seq).toBe(third);
		expect(saved?.blueprint.appName).toBe("Case writes");
	});

	it.each([
		{ where: "between the second and the sixth identity's horizons", below: 2 },
		{ where: "between the first two horizons", below: 1 },
		{ where: "below all three horizons", below: 0 },
	])(
		"answers a finished build recorded $where from the saved app",
		async ({ below }) => {
			const appId = await h.seedApp({
				id: crypto.randomUUID(),
				owner: ACTOR,
				project_id: PROJECT,
				status: "generating",
				run_id: RUN,
				run_holder_nonce: NONCE,
				reservation: {
					period: "2026-10",
					reserved: 1,
					settled: false,
					userId: ACTOR,
					runId: RUN,
				},
			});
			await writeOldDialectHistory(appId, 2);
			const designSessionId = await h.seedDesignSession({
				owner_user_id: ACTOR,
				project_id: PROJECT,
				proposed_app_id: appId,
				app_id: appId,
				state: "materialized",
			});
			const earlier = [
				() => writeHqRoundTripHorizon(h.db(), appId, "After step 2"),
				() => writeHqRoundTripExpressionsHorizon(h.db(), appId, "After step 3"),
			];
			let recorded = 2;
			for (const write of earlier.slice(0, below)) recorded = await write();
			await completeBuildOrchestration({
				designSessionId,
				runId: RUN,
				holderNonce: NONCE,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				appId,
				expectedSeq: recorded,
				expectedHead: null,
			});
			for (const write of earlier.slice(below)) await write();
			const horizon = await writeHqRoundTripCaseWritesHorizon(
				h.db(),
				appId,
				"After step 5",
			);
			expect(horizon).toBe(5);

			const written: unknown[] = [];
			const outcome = await runBuildOrchestration({
				designSessionId,
				proposedAppId: appId,
				projectId: PROJECT,
				projectRole: "owner",
				actorUserId: ACTOR,
				runId: "run-after-cutover",
				holderNonce: crypto.randomUUID(),
				threadId: "thread",
				messages: [],
				responseMessageId: "response",
				writer: { write: (chunk) => written.push(chunk) },
				apiKey: "synthetic-local-only",
				meter: undefined,
				signal: new AbortController().signal,
				materializedAppId: appId,
				finalizeCompletion: async () => {
					throw new Error("A finished build does not complete again.");
				},
			});

			const saved = await loadApp(appId);
			expect(saved?.blueprint.appName).toBe("After step 5");
			expect(outcome).toEqual({
				kind: "completed",
				appId,
				finalSeq: horizon,
				finalBlueprint: saved?.blueprint,
			});
			expect(written).toEqual([]);
			expect(log.error).not.toHaveBeenCalled();
			expect(log.critical).not.toHaveBeenCalled();
		},
	);

	it("replays a batch whose id latched behind the sixth identity's horizon, over three horizons, without reading its old dialect", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
		});
		await writeOldDialectHistory(appId, 2);
		const emission = await writeHqRoundTripHorizon(
			h.db(),
			appId,
			"After step 2",
		);
		await writeOldDialectHistory(appId, emission + 1, emission + 1);
		const expressions = await writeHqRoundTripExpressionsHorizon(
			h.db(),
			appId,
			"After step 3",
		);
		await writeOldDialectHistory(appId, expressions + 1, expressions + 1);
		const horizon = await writeHqRoundTripCaseWritesHorizon(
			h.db(),
			appId,
			"After step 5",
		);
		expect(horizon).toBe(expressions + 2);

		for (const seq of [expressions + 1, emission + 1, 2]) {
			const replay = await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT,
				batchId: `old-dialect-${seq}`,
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: "A retried rename" },
				]),
				actorUserId: ACTOR,
				kind: "autosave",
			});
			expect(replay).toMatchObject({ seq, deduped: true });
			expect(replay.committedDoc.appName).toBe("After step 5");
		}
		const saved = await loadApp(appId);
		expect(saved?.mutation_seq).toBe(horizon);
		expect(saved?.blueprint.appName).toBe("After step 5");
		expect(log.error).not.toHaveBeenCalled();
		expect(log.critical).not.toHaveBeenCalled();
	});
});
