// Live-Postgres contract for the lookup reference edge tables.
//
// `lookupReferenceEdges.ts` is the only writer of `lookup_table_references` /
// `lookup_column_references`, and those edges are what make a lookup-referencing
// app unmovable and its referenced table undeletable. The composite foreign keys
// carry the real invariants, so this suite runs against a real database rather
// than asserting the SQL it would have emitted.

import type { Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	type LookupReferenceTargetSet,
	normalizeLookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import {
	type LookupTableId,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { createLookupTable } from "@/lib/lookup/service";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import {
	LookupReferenceWriteError,
	lockLookupTablesForReferenceWrite,
	readStoredLookupReferenceTargets,
	replaceLookupReferenceEdges,
} from "../lookupReferenceEdges";
import type { AppDatabase } from "../pg";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("lookup_reference_edges_");

const PROJECT_A = "lookup-reference-project-a";
const PROJECT_B = "lookup-reference-project-b";
const APP_ID = "lookup-reference-app";
const MISSING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);

async function createTable(
	projectId: string,
	name: string,
): Promise<LookupTableSnapshot> {
	return createLookupTable(
		{
			projectId,
			actorId: `${projectId}-owner`,
			role: "owner",
		},
		{
			name,
			tag: name.toLowerCase().replaceAll(" ", "_"),
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		},
	);
}

/** Production edge writers always hold the app row first; the lock helper's
 *  ordering contract only means anything under that precondition. */
async function withLockedApp<T>(
	appId: string,
	body: (tx: Transaction<AppDatabase>) => Promise<T>,
): Promise<T> {
	return h
		.db()
		.transaction()
		.execute(async (tx) => {
			await tx
				.selectFrom("apps")
				.select("id")
				.where("id", "=", appId)
				.forUpdate()
				.executeTakeFirstOrThrow();
			return body(tx);
		});
}

async function readTargets(appId = APP_ID): Promise<LookupReferenceTargetSet> {
	return withLockedApp(appId, (tx) =>
		readStoredLookupReferenceTargets(tx, appId),
	);
}

async function unavailableFromLock(
	tableId: LookupTableId,
): Promise<LookupReferenceWriteError> {
	let caught: unknown;
	try {
		await withLockedApp(APP_ID, (tx) =>
			lockLookupTablesForReferenceWrite(tx, PROJECT_A, [tableId]),
		);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(LookupReferenceWriteError);
	return caught as LookupReferenceWriteError;
}

describe("lookup reference edge materialization", () => {
	it("replaces the complete nonempty set, inserts implied table edges, and clears to empty", async () => {
		const first = await createTable(PROJECT_A, "First");
		const second = await createTable(PROJECT_A, "Second");
		await h.seedApp({ id: APP_ID, project_id: PROJECT_A });

		const columnOnlyInput: LookupReferenceTargetSet = {
			tableIds: [],
			columnTargets: [{ tableId: first.id, columnId: first.columns[0].id }],
		};
		await withLockedApp(APP_ID, async (tx) => {
			await lockLookupTablesForReferenceWrite(tx, PROJECT_A, [first.id]);
			await replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT_A,
				targets: columnOnlyInput,
			});
		});

		// The materializer, not its caller, guarantees that a column target gains
		// the parent table edge required by the composite FK. The plain Kysely
		// read also covers the read-only scanner seam (one SQL snapshot, no tx).
		expect(await readStoredLookupReferenceTargets(h.db(), APP_ID)).toEqual(
			normalizeLookupReferenceTargetSet(columnOnlyInput),
		);
		expect(
			await h
				.db()
				.selectFrom("lookup_table_references")
				.select(["project_id", "table_id", "app_id"])
				.where("app_id", "=", APP_ID)
				.execute(),
		).toEqual([{ project_id: PROJECT_A, table_id: first.id, app_id: APP_ID }]);

		const replacement = normalizeLookupReferenceTargetSet({
			tableIds: [second.id, second.id],
		});
		await withLockedApp(APP_ID, async (tx) => {
			// Production writers lock the previous/candidate union; the helper
			// canonicalizes this deliberately reversed, duplicate input.
			await lockLookupTablesForReferenceWrite(tx, PROJECT_A, [
				second.id,
				first.id,
				second.id,
			]);
			await replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT_A,
				targets: replacement,
			});
		});

		// Replacement is total: the previous column edge is gone, not merged.
		expect(await readTargets()).toEqual(replacement);
		expect(
			await h
				.db()
				.selectFrom("lookup_column_references")
				.select("column_id")
				.where("app_id", "=", APP_ID)
				.execute(),
		).toEqual([]);

		await withLockedApp(APP_ID, async (tx) => {
			await lockLookupTablesForReferenceWrite(tx, PROJECT_A, []);
			await replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT_A,
				targets: EMPTY_LOOKUP_REFERENCE_TARGETS,
			});
		});
		expect(await readTargets()).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
	});

	it("clears stale source-Project edges before an app Project flip", async () => {
		const source = await createTable(PROJECT_A, "Source");
		await h.seedApp({ id: APP_ID, project_id: PROJECT_A });
		const sourceTargets = normalizeLookupReferenceTargetSet({
			columnTargets: [{ tableId: source.id, columnId: source.columns[0].id }],
		});

		await withLockedApp(APP_ID, async (tx) => {
			await lockLookupTablesForReferenceWrite(tx, PROJECT_A, [source.id]);
			await replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT_A,
				targets: sourceTargets,
			});
		});

		await withLockedApp(APP_ID, async (tx) => {
			// Passing the destination scope must still delete by app id across ALL
			// Projects. A destination-filtered delete would leave the source edge and
			// the composite FK would reject the Project update below.
			await replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT_B,
				targets: EMPTY_LOOKUP_REFERENCE_TARGETS,
			});
			// The app-Project trigger requires an exact same-sequence
			// `project-move` change for the transition, so the flip this test
			// exercises has to carry one even though the subject is the edge
			// delete.
			const app = await tx
				.selectFrom("apps")
				.select(["project_id", "mutation_seq"])
				.where("id", "=", APP_ID)
				.executeTakeFirstOrThrow();
			const seq = Number(app.mutation_seq) + 1;
			await tx
				.insertInto("app_changes")
				.values({
					app_id: APP_ID,
					seq,
					batch_id: crypto.randomUUID(),
					run_id: null,
					actor_id: "edge-test",
					kind: "project-move",
					mutations: "[]",
					from_project_id: app.project_id,
					to_project_id: PROJECT_B,
				})
				.execute();
			await tx
				.updateTable("apps")
				.set({ project_id: PROJECT_B, mutation_seq: seq })
				.where("id", "=", APP_ID)
				.executeTakeFirstOrThrow();
		});

		expect(await readTargets()).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		expect((await h.readAppRow(APP_ID))?.project_id).toBe(PROJECT_B);
	});

	it("makes missing and foreign table locks exactly indistinguishable", async () => {
		const foreign = await createTable(PROJECT_B, "Foreign");
		await h.seedApp({ id: APP_ID, project_id: PROJECT_A });

		const missingError = await unavailableFromLock(MISSING_TABLE_ID);
		const foreignError = await unavailableFromLock(foreign.id);
		expect({ code: foreignError.code, message: foreignError.message }).toEqual({
			code: missingError.code,
			message: missingError.message,
		});
		expect(missingError).toMatchObject({
			name: "LookupReferenceWriteError",
			code: "unavailable",
			message: "Lookup reference targets are unavailable.",
		});
	});
});
