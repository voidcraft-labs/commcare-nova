/**
 * Held placements through real Postgres: an app's held case changes are
 * stored in its entity rows and read back from them, and the server path
 * refuses an edit that strands one without its move and admits the batch the
 * identity-move planner gives every editor, whose recorded history folds to
 * the same head.
 *
 * The plausible failures: a persistence path that drops a hold (the entity
 * row projection, or the assembler reading it back), the commit gate's
 * absence on the server path (a stranded hold committed as it stands, so the
 * next publish moves a case change no one was told of), and a history whose
 * fold reaches another document than the rows hold (a hold the log does not
 * carry, so a reload or a peer's catch-up loses the move).
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { Mutation } from "@/lib/doc/types";
import type { LookupRevision } from "@/lib/lookup/types";
import { replayCanonicalAppChangeSuffix } from "../canonicalMutationFold";
import { BlueprintCommitRejectedError } from "../commitGuard";
import { commitGuardedBatchProposal as commitGuardedBatch } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";
import {
	heldPlacementApp,
	holdOperation,
	operationHold,
	villageOnlyIfChanged,
} from "./heldPlacementApp";

const OWNER = "held-placement-owner";
const PROJECT = "held-placement-project";

const h = setupAppStateTestDb("held_placements_");

async function loaded(appId: string) {
	const { loadApp } = await import("../apps");
	const app = await loadApp(appId);
	if (app === null) throw new Error(`The app ${appId} loads.`);
	return app;
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

describe("held placements through Postgres", () => {
	it("reads back the holds a document's entity rows store", async () => {
		const app = heldPlacementApp((a) => {
			holdOperation(a, a.own.uuid, a.ownSaveToCase);
			holdOperation(a, a.kid.uuid, a.kidSaveToCase);
		});
		const appId = await h.seedAppWithBlueprint(app.doc, {
			owner: OWNER,
			projectId: PROJECT,
		});

		const { blueprint } = await loaded(appId);
		expect([
			...readPlacementHolds(hydratePersistedBlueprint(blueprint)).values(),
		]).toEqual([
			operationHold(app, app.own.uuid, app.ownSaveToCase),
			operationHold(app, app.kid.uuid, app.kidSaveToCase),
		]);
	});

	it("refuses an edit that strands a hold without its move, and admits the planned move, which folds to the same head", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await h.seedAppWithBlueprint(app.doc, {
			owner: OWNER,
			projectId: PROJECT,
		});
		const seeded = await loaded(appId);

		// Save to Case cannot keep only the answers the worker changed, so the
		// edit strands the own case's hold.
		const edit = [villageOnlyIfChanged(app, true)];
		const stranded = autosave(appId, edit);
		await expect(stranded).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		await expect(stranded).rejects.toThrow(
			"where your last publish put it, and this change can't keep it there",
		);
		expect((await loaded(appId)).mutation_seq).toBe(seeded.mutation_seq);

		const plan = withIdentityMoves(
			hydratePersistedBlueprint(seeded.blueprint),
			edit,
		);
		expect(plan.batch).toEqual([
			...edit,
			{
				kind: "holdPlacements",
				holds: [operationHold(app, app.own.uuid, app.ownBasic)],
			},
		]);
		const committed = await autosave(appId, plan.batch);
		const head = await loaded(appId);
		expect(String(head.mutation_seq)).toBe(String(committed.seq));
		expect([
			...readPlacementHolds(hydratePersistedBlueprint(head.blueprint)).values(),
		]).toEqual([operationHold(app, app.own.uuid, app.ownBasic)]);

		// The recorded history, read as the fold reads it, reaches the head.
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
			.where("seq", ">", seeded.mutation_seq)
			.orderBy("seq")
			.execute();
		const folded = replayCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(seeded.blueprint),
			baselineSeq: seeded.mutation_seq,
			baselineProjectId: PROJECT,
			expectedHeadSeq: head.mutation_seq,
			expectedFinalProjectId: PROJECT,
			suffix,
			finalLookupContext: {
				kind: "available",
				projectId: PROJECT,
				projectRevision: "0" as LookupRevision,
				definitions: [],
			},
		});
		expect(folded.snapshot).toEqual(head.blueprint);
	});
});
