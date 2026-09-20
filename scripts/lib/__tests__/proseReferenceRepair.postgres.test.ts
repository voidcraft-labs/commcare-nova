import { sql } from "kysely";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { appendSyntheticBatch } from "@/lib/db/apps";
import { foldCanonicalAppChangeSuffixBounded } from "@/lib/db/canonicalMutationFold";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { loadPersistedBlueprintSnapshot } from "../loadPersistedBlueprint";
import {
	applyProseReferenceRepair,
	applyProseReferenceRepairInTransaction,
	PROSE_REPAIR_MARKER,
	planProseReferenceRepair,
	scanProseReferenceRepair,
} from "../proseReferenceRepair";

const h = setupAppStateTestDb("prose_reference_repair_");
const PROJECT = "prose-repair-project";
const DIGEST = "a".repeat(64);

async function seed() {
	const doc = buildDoc({
		appName: "Reference repair",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", label: "Name" }),
							f({ kind: "label", id: "summary", label: "Hello #form/name" }),
						],
					},
				],
			},
		],
	});
	const appId = await h.seedAppWithBlueprint(doc, { projectId: PROJECT });
	await h.withTransaction(async (tx) => {
		// The real historical cutover rewrote entities in the baseline transaction.
		await sql`UPDATE blueprint_entities SET data = data WHERE app_id = ${appId}`.execute(
			tx,
		);
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq: 1,
				batch_id: PROSE_REPAIR_MARKER,
				actor_id: "system:canonical-identity-foundation",
				run_id: null,
				kind: "fold-baseline",
				mutations: "[]",
			})
			.execute();
		await tx
			.updateTable("apps")
			.set({ mutation_seq: 1 })
			.where("id", "=", appId)
			.execute();
		await sql`INSERT INTO app_change_fold_baselines (app_id,seq,project_id,snapshot,snapshot_digest)
			SELECT ${appId},1,${PROJECT},snapshot,nova_app_change_fold_snapshot_digest(snapshot)
			FROM (SELECT nova_current_app_change_fold_snapshot(${appId}) AS snapshot) s`.execute(
			tx,
		);
	});
	const snapshot = await loadPersistedBlueprintSnapshot(appId);
	if (!snapshot) throw new Error("fixture missing");
	const entry = planProseReferenceRepair(
		snapshot.blueprint,
		snapshot.blueprint,
		PROJECT,
		1,
	);
	if (!entry) throw new Error("plan missing");
	return { appId, entry, original: snapshot.blueprint };
}

describe("prose repair transactions", () => {
	it("waits for a competing app lock and then observes the newly occupied run", async () => {
		const { appId, entry, original } = await seed();
		const gate = new Client({ connectionString: h.uri() });
		await gate.connect();
		let repair: Promise<unknown> | undefined;
		try {
			await gate.query("BEGIN");
			await gate.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [appId]);
			repair = applyProseReferenceRepair(entry, DIGEST, "execute").then(
				(value) => value,
				(error: unknown) => error,
			);
			await vi.waitFor(async () => {
				const waiting = await gate.query<{ n: string }>(
					"SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'transactionid' AND pg_backend_pid() = ANY(pg_blocking_pids(pid))",
				);
				expect(Number(waiting.rows[0].n)).toBeGreaterThan(0);
			});
			await gate.query("UPDATE apps SET status = 'generating' WHERE id = $1", [
				appId,
			]);
			await gate.query("COMMIT");
			expect(await repair).toMatchObject({
				message: "App has an occupied agent run.",
			});
			expect((await loadPersistedBlueprintSnapshot(appId))?.blueprint).toEqual(
				original,
			);
		} finally {
			await gate.query("ROLLBACK");
			await gate.end();
			if (repair !== undefined) await repair;
		}
	});
	it("commits replayable history, retries without writing and compensates exactly", async () => {
		const { appId, entry, original } = await seed();
		expect((await scanProseReferenceRepair()).manifest.entries).toEqual([
			entry,
		]);
		expect(await applyProseReferenceRepair(entry, DIGEST, "execute")).toEqual({
			kind: "committed",
			seq: 2,
		});
		expect(await applyProseReferenceRepair(entry, DIGEST, "execute")).toEqual({
			kind: "deduped",
			seq: 2,
		});
		const suffix = await h
			.db()
			.selectFrom("app_changes")
			.select([
				"seq",
				"batch_id",
				"run_id",
				"actor_id",
				"kind",
				"from_project_id",
				"to_project_id",
			])
			.select(sql<string>`mutations::text`.as("mutationsText"))
			.where("app_id", "=", appId)
			.where("seq", ">", 1)
			.execute();
		const folded = foldCanonicalAppChangeSuffixBounded({
			baselineSnapshotText: JSON.stringify(original),
			baselineSeq: 1,
			baselineProjectId: PROJECT,
			targetSeq: 2,
			suffix,
		});
		expect(folded.snapshot).toEqual(
			(await loadPersistedBlueprintSnapshot(appId))?.blueprint,
		);
		expect(canonicalJsonDigest(folded.snapshot)).toBe(entry.targetDigest);
		expect(await applyProseReferenceRepair(entry, DIGEST, "rollback")).toEqual({
			kind: "committed",
			seq: 3,
		});
		expect((await loadPersistedBlueprintSnapshot(appId))?.blueprint).toEqual(
			original,
		);
		expect(await applyProseReferenceRepair(entry, DIGEST, "rollback")).toEqual({
			kind: "deduped",
			seq: 3,
		});
	});

	it("rolls back document and history when the containing transaction fails", async () => {
		const { appId, entry, original } = await seed();
		await expect(
			h.withTransaction(async (tx) => {
				await applyProseReferenceRepairInTransaction(
					tx,
					entry,
					DIGEST,
					"execute",
				);
				throw new Error("injected failure after write");
			}),
		).rejects.toThrow("injected failure");
		expect((await loadPersistedBlueprintSnapshot(appId))?.blueprint).toEqual(
			original,
		);
		expect(
			await h
				.db()
				.selectFrom("app_changes")
				.select("seq")
				.where("app_id", "=", appId)
				.execute(),
		).toHaveLength(1);
	});

	it("refuses changed revisions and projects without altering newer work", async () => {
		const { appId, entry, original } = await seed();
		await expect(
			applyProseReferenceRepair(
				{ ...entry, projectId: "different-project" },
				DIGEST,
				"execute",
			),
		).rejects.toThrow("Project changed");
		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: 1,
			targetDoc: { ...original, appName: "Newer work" },
			authority: {
				kind: "system",
				actorId: "system:test",
				reason: "Concurrent edit",
			},
		});
		await expect(
			applyProseReferenceRepair(entry, DIGEST, "execute"),
		).rejects.toThrow("source changed");
		expect(
			(await loadPersistedBlueprintSnapshot(appId))?.blueprint.appName,
		).toBe("Newer work");
	});

	it("refuses an occupied build, including a stale paused build", async () => {
		const { appId, entry, original } = await seed();
		await h
			.db()
			.updateTable("apps")
			.set({
				status: "generating",
				awaiting_input: true,
				updated_at: new Date(0),
			})
			.where("id", "=", appId)
			.execute();
		await expect(
			applyProseReferenceRepair(entry, DIGEST, "execute"),
		).rejects.toThrow("occupied agent run");
		expect((await loadPersistedBlueprintSnapshot(appId))?.blueprint).toEqual(
			original,
		);
	});
});
