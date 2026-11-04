/**
 * A publish's placements, committed through the real canonical kernel and
 * real Postgres as one `publish-placement` change at the head the publish
 * emitted from.
 *
 * The plausible failures: a record written at a head that moved since the
 * publish emitted (the holds would pin paths that emission no longer
 * derives); a record that skips some of the commit's tail (no entity rows,
 * so a reload loses the holds; no NOTIFY, so open tabs never fold it; a row
 * the fold cannot replay); a publish-placement batch that carries an
 * ordinary edit past the placement rule, which admits the kind whole; and a
 * gate refusal whose finding codes are lost, so the route cannot tell a
 * placement conflict from any other refusal.
 */

import { sql } from "kysely";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import type { LookupRevision } from "@/lib/lookup/types";
import { replayCanonicalAppChangeSuffix } from "../canonicalMutationFold";
import {
	AppHeadMovedError,
	BlueprintCommitRejectedError,
} from "../commitGuard";
import { commitGuardedBatchProposal as commitGuardedBatch } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";
import {
	type HeldPlacementApp,
	heldPlacementApp,
	holdPlacements,
	operationHold,
	villageOnlyIfChanged,
} from "./heldPlacementApp";

const OWNER = "publish-placement-owner";
const PROJECT = "publish-placement-project";

const h = setupAppStateTestDb("publish_placement_commit_");

async function loaded(appId: string) {
	const { loadApp } = await import("../apps");
	const app = await loadApp(appId);
	if (app === null) throw new Error(`The app ${appId} loads.`);
	return app;
}

async function seed(app: HeldPlacementApp): Promise<string> {
	return h.seedAppWithBlueprint(app.doc, { owner: OWNER, projectId: PROJECT });
}

function publish(
	appId: string,
	expectedHeadSeq: number,
	mutations: readonly Mutation[],
) {
	return commitGuardedBatch({
		appId,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		mutations,
		actorUserId: OWNER,
		kind: "publish-placement",
		expectedHeadSeq,
	});
}

function autosave(appId: string, mutations: readonly Mutation[]) {
	return commitGuardedBatch({
		appId,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		mutations,
		actorUserId: OWNER,
		kind: "autosave",
	});
}

async function changeRows(appId: string, afterSeq: number) {
	return h
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
		.where("seq", ">", afterSeq)
		.orderBy("seq")
		.execute();
}

const holdsOf = (
	blueprint: Parameters<typeof hydratePersistedBlueprint>[0],
) => [...readPlacementHolds(hydratePersistedBlueprint(blueprint)).values()];

describe("a publish-placement commit", () => {
	it("a publish-placement commit at the head writes the row, the entities, the NOTIFY and the folded document", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		const seeded = await loaded(appId);
		const holds = [
			operationHold(app, app.own.uuid, app.ownSaveToCase),
			operationHold(app, app.kid.uuid, app.kidSaveToCase),
		];
		const batch = [holdPlacements(...holds)];

		const listener = new Client({ connectionString: h.uri() });
		const payloads: string[] = [];
		const onNotification = (message: { channel: string; payload?: string }) => {
			if (message.channel === "nova_app_stream")
				payloads.push(message.payload ?? "");
		};
		let receipt: Awaited<ReturnType<typeof publish>>;
		try {
			await listener.connect();
			listener.on("notification", onNotification);
			await listener.query("LISTEN nova_app_stream");
			receipt = await publish(appId, seeded.mutation_seq, batch);
			await vi.waitFor(() => {
				expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
					{ appId, seq: seeded.mutation_seq + 1 },
				]);
			});
		} finally {
			listener.off("notification", onNotification);
			await listener.end();
		}

		expect(receipt.deduped).toBe(false);
		expect(receipt.seq).toBe(seeded.mutation_seq + 1);
		expect([...readPlacementHolds(receipt.committedDoc).values()]).toEqual(
			holds,
		);

		const rows = await changeRows(appId, seeded.mutation_seq);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "publish-placement",
			run_id: null,
			actor_id: OWNER,
			from_project_id: null,
			to_project_id: null,
		});
		expect(JSON.parse(rows[0].mutationsText)).toEqual(batch);

		const head = await loaded(appId);
		expect(head.mutation_seq).toBe(receipt.seq);
		expect(holdsOf(head.blueprint)).toEqual(holds);

		const folded = replayCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(seeded.blueprint),
			baselineSeq: seeded.mutation_seq,
			baselineProjectId: PROJECT,
			expectedHeadSeq: head.mutation_seq,
			expectedFinalProjectId: PROJECT,
			suffix: rows,
			finalLookupContext: {
				kind: "available",
				projectId: PROJECT,
				projectRevision: "0" as LookupRevision,
				definitions: [],
			},
		});
		expect(folded.snapshot).toEqual(head.blueprint);
	});

	it("at a moved head it throws AppHeadMovedError and writes nothing", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		const emittedAt = (await loaded(appId)).mutation_seq;
		await autosave(appId, [{ kind: "setAppName", name: "Renamed" }]);
		const moved = await loaded(appId);

		const attempt = publish(appId, emittedAt, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		await expect(attempt).rejects.toBeInstanceOf(AppHeadMovedError);
		await expect(attempt).rejects.toMatchObject({
			expectedSeq: emittedAt,
			headSeq: moved.mutation_seq,
		});

		const after = await loaded(appId);
		expect(after.mutation_seq).toBe(moved.mutation_seq);
		expect(after.blueprint).toEqual(moved.blueprint);
		expect(await changeRows(appId, moved.mutation_seq)).toEqual([]);
	});

	it("a publish-placement batch holding another mutation throws", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		const seeded = await loaded(appId);

		const attempt = publish(appId, seeded.mutation_seq, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
			{ kind: "setAppName", name: "Renamed" },
		]);
		await expect(attempt).rejects.toThrow(
			"[commitCanonicalBatch] a publish-placement batch holds only holdPlacements",
		);
		await expect(attempt).rejects.not.toBeInstanceOf(
			BlueprintCommitRejectedError,
		);

		const after = await loaded(appId);
		expect(after.mutation_seq).toBe(seeded.mutation_seq);
		expect(after.blueprint).toEqual(seeded.blueprint);
		expect(await changeRows(appId, seeded.mutation_seq)).toEqual([]);
	});

	it("a gate refusal carries its finding codes", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		// Save to Case cannot keep only the answers the worker changed, so the
		// own case's Save to Case block cannot express its writes.
		await autosave(appId, [villageOnlyIfChanged(app, true)]);
		const edited = await loaded(appId);

		const attempt = publish(appId, edited.mutation_seq, [
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		const refusal: unknown = await attempt.then(
			() => undefined,
			(error: unknown) => error,
		);
		if (!(refusal instanceof BlueprintCommitRejectedError))
			throw new Error(
				`The gate should have refused the publish's holds, and it answered ${String(refusal)}.`,
			);
		expect(refusal.findingCodes).toContain("HELD_PLACEMENT_INEXPRESSIBLE");
		expect(refusal.placementRule).toBe(false);

		const after = await loaded(appId);
		expect(after.mutation_seq).toBe(edited.mutation_seq);
		expect(holdsOf(after.blueprint)).toEqual([]);
	});
});
