/**
 * The recordings of held placements, read from real Postgres. The plausible
 * failures: an older recording, a recording behind the fold horizon, or an
 * editor's own row answering a key (a forged autosave would then make its
 * own hold restorable); the baseline snapshot answering a key a newer row
 * cleared; a read for a commit that changes no hold (a query on every save);
 * and a table resolved by the session's search path rather than by its
 * schema.
 */

import type { KyselyPlugin } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { placementTargetKey } from "@/lib/doc/placementHolds";
import type { CasePlacement } from "@/lib/domain";
import { readRecordedPlacementHolds } from "../placementRecords";
import { setupAppStateTestDb } from "./appStateTestDb";
import {
	appendChangeRow,
	type HeldPlacementApp,
	heldPlacementApp,
	holdOperation,
	holdPlacements,
	operationHold,
} from "./heldPlacementApp";

const h = setupAppStateTestDb("placement_records_");

const OWNER = "placement-owner";
const PROJECT = "placement-project";

const EDITOR_PLACE: CasePlacement = {
	kind: "save-to-case",
	path: ["nova_operations", "edited_patient"],
};

async function seed(app: HeldPlacementApp): Promise<string> {
	return h.seedAppWithBlueprint(app.doc, { owner: OWNER, projectId: PROJECT });
}

const keyOf = (app: HeldPlacementApp, operationUuid: string) =>
	placementTargetKey({
		target: "case-operation",
		formUuid: app.formUuid,
		operationUuid,
	});

/** A plugin that records every statement's tables, run on the test's db. */
function statementLog() {
	const statements: string[] = [];
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			statements.push(JSON.stringify(args.node));
			return args.node;
		},
		async transformResult(args) {
			return args.result;
		},
	};
	return { statements, db: h.db().withPlugin(plugin) };
}

describe("readRecordedPlacementHolds", () => {
	it("answers with the newest recording row above the greatest fold baseline", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(
				operationHold(app, app.kid.uuid, app.kidSaveToCase),
				operationHold(app, app.own.uuid, app.ownSaveToCase),
			),
		]);

		const recorded = await readRecordedPlacementHolds(h.db(), appId, [
			keyOf(app, app.own.uuid),
			keyOf(app, app.kid.uuid),
		]);
		expect(recorded).toEqual(
			new Map([
				[
					keyOf(app, app.own.uuid),
					operationHold(app, app.own.uuid, app.ownSaveToCase),
				],
				[
					keyOf(app, app.kid.uuid),
					operationHold(app, app.kid.uuid, app.kidSaveToCase),
				],
			]),
		);
	});

	it("does not read a recording row at or below the greatest fold baseline", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(operationHold(app, app.own.uuid, app.ownSaveToCase)),
		]);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");

		// The baseline snapshot holds nothing, and the earlier row is behind it.
		expect(
			await readRecordedPlacementHolds(h.db(), appId, [
				keyOf(app, app.own.uuid),
			]),
		).toEqual(new Map());
	});

	it("answers a key no row names from the baseline snapshot", async () => {
		const app = heldPlacementApp((a) => {
			holdOperation(a, a.own.uuid, a.ownSaveToCase);
			holdOperation(a, a.kid.uuid, a.kidSaveToCase);
		});
		const appId = await seed(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(operationHold(app, app.own.uuid, app.ownBasic)),
		]);

		expect(
			await readRecordedPlacementHolds(h.db(), appId, [
				keyOf(app, app.own.uuid),
				keyOf(app, app.kid.uuid),
			]),
		).toEqual(
			new Map([
				[
					keyOf(app, app.own.uuid),
					operationHold(app, app.own.uuid, app.ownBasic),
				],
				[
					keyOf(app, app.kid.uuid),
					operationHold(app, app.kid.uuid, app.kidSaveToCase),
				],
			]),
		);
	});

	it("leaves absent a target whose latest recording cleared it", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await seed(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(operationHold(app, app.own.uuid, null)),
		]);

		expect(
			await readRecordedPlacementHolds(h.db(), appId, [
				keyOf(app, app.own.uuid),
			]),
		).toEqual(new Map());
	});

	it("never counts an editor's row", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await seed(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		for (const kind of ["autosave", "mcp", "chat"] as const) {
			await appendChangeRow(h.db(), appId, kind, [
				holdPlacements(
					operationHold(app, app.own.uuid, EDITOR_PLACE),
					operationHold(app, app.kid.uuid, app.kidSaveToCase),
				),
			]);
		}

		expect(
			await readRecordedPlacementHolds(h.db(), appId, [
				keyOf(app, app.own.uuid),
				keyOf(app, app.kid.uuid),
			]),
		).toEqual(
			new Map([
				[
					keyOf(app, app.own.uuid),
					operationHold(app, app.own.uuid, app.ownSaveToCase),
				],
			]),
		);
	});

	it("issues no query for an empty key list", async () => {
		const app = heldPlacementApp();
		const appId = await seed(app);
		const { statements, db } = statementLog();

		expect(await readRecordedPlacementHolds(db, appId, [])).toEqual(new Map());
		expect(statements).toEqual([]);
	});

	it("reads its tables by schema, whatever the search path finds first", async () => {
		const app = heldPlacementApp((a) =>
			holdOperation(a, a.own.uuid, a.ownSaveToCase),
		);
		const appId = await seed(app);
		await writeHqRoundTripHorizon(h.db(), appId, "Held placements");
		await appendChangeRow(h.db(), appId, "blueprint-migration", [
			holdPlacements(operationHold(app, app.kid.uuid, app.kidSaveToCase)),
		]);
		const decoyHold = JSON.stringify([
			holdPlacements(
				operationHold(app, app.own.uuid, EDITOR_PLACE),
				operationHold(app, app.kid.uuid, null),
			),
		]);

		const recorded = await h.withTransaction(async (tx) => {
			await sql`CREATE SCHEMA nova_placement_decoy`.execute(tx);
			await sql`
				CREATE TABLE nova_placement_decoy.app_changes
					(LIKE public.app_changes INCLUDING DEFAULTS)
			`.execute(tx);
			await sql`
				CREATE TABLE nova_placement_decoy.app_change_fold_baselines
					(LIKE public.app_change_fold_baselines INCLUDING DEFAULTS)
			`.execute(tx);
			await sql`
				INSERT INTO nova_placement_decoy.app_changes
					(app_id, seq, batch_id, actor_id, kind, mutations)
				VALUES
					(${appId}, 100, 'decoy', 'system:decoy',
					 'blueprint-migration', ${decoyHold}::jsonb)
			`.execute(tx);
			await sql`
				INSERT INTO nova_placement_decoy.app_change_fold_baselines
					(app_id, seq, project_id, snapshot, snapshot_digest)
				VALUES (${appId}, 99, ${PROJECT}, '{}'::jsonb, 'decoy')
			`.execute(tx);
			await sql`SET LOCAL search_path = nova_placement_decoy, public`.execute(
				tx,
			);
			return readRecordedPlacementHolds(tx, appId, [
				keyOf(app, app.own.uuid),
				keyOf(app, app.kid.uuid),
			]);
		});

		expect(recorded).toEqual(
			new Map([
				[
					keyOf(app, app.kid.uuid),
					operationHold(app, app.kid.uuid, app.kidSaveToCase),
				],
				[
					keyOf(app, app.own.uuid),
					operationHold(app, app.own.uuid, app.ownSaveToCase),
				],
			]),
		);
	});
});
