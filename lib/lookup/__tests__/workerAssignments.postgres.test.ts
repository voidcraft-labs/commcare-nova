import { sql } from "kysely";
import { v7 } from "uuid";
import { beforeEach, expect, it } from "vitest";
import {
	canonicalTestBlueprint,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { withAppTx } from "@/lib/db/pg";
import { readWorkerLookupProjection } from "@/lib/deployment/workerLookupProjection";
import { asUuid } from "@/lib/domain/uuid";
import { applyLookupAuthoringBatchInTransaction } from "../authoringBatch";
import { readLookupFixtureDataInTransaction } from "../fixtureSnapshot";
import { editWorkerGroup, readPersonaGroups } from "../workerGroups";
import type { WorkerGroupEdit } from "../assignmentVocabulary";
import { authorizeLookupWriteInTransaction } from "../writerTransaction";

const h = setupAppStateTestDb("worker_assignments_", {
	authSchema: "migrated",
});
const scope = {
	projectId: "clinics",
	actorUserId: "designer",
	appId: "roster",
};
const actor = {
	projectId: scope.projectId,
	actorId: scope.actorUserId,
	role: "owner",
};
const grant = { kind: "session", sessionId: "worker-preview-session" } as const;
const worker = asUuid(v7()),
	other = asUuid(v7()),
	root = asUuid(v7()),
	primary = asUuid(v7()),
	extra = asUuid(v7()),
	level = asUuid(v7()),
	clinicLevel = asUuid(v7());
const batch = (
	input: Parameters<typeof applyLookupAuthoringBatchInTransaction>[2],
) =>
	withAppTx(async (tx) =>
		applyLookupAuthoringBatchInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, actor, "edit"),
			input,
		),
	);
const group = (input: WorkerGroupEdit) =>
	withAppTx(async (tx) =>
		editWorkerGroup(
			tx,
			await authorizeLookupWriteInTransaction(tx, actor, "edit"),
			input,
		),
	);

beforeEach(async () => {
	const flow = {
		workers: "assigned",
		ownsCases: true,
		descendantCases: { kind: "none" },
	} as const;
	const doc = {
		...canonicalTestBlueprint(scope.appId),
		organizationLevels: {
			[level]: {
				uuid: level,
				name: "District",
				code: "district",
				caseFlow: flow,
				addressBook: { reach: "own-branch" as const },
			},
			[clinicLevel]: {
				uuid: clinicLevel,
				name: "Clinic",
				code: "clinic",
				parentLevelUuid: level,
				caseFlow: flow,
				addressBook: { reach: "own-branch" as const },
			},
		},
		organizationLevelOrder: [level, clinicLevel],
		personas: {
			[worker]: {
				uuid: worker,
				name: "Kai",
				locations: { primaryUuid: primary, additionalUuids: [extra] },
			},
			[other]: { uuid: other, name: "Kai" },
		},
		personaOrder: [worker, other],
	};
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: actor.actorId,
		projectId: actor.projectId,
	});
	for (const [id, parent, name] of [
		[root, null, "district"],
		[primary, root, "clinic"],
		[extra, null, "outpost"],
	] as const) {
		await sql`INSERT INTO app_locations(app_id,id,level_uuid,parent_id,name,site_code,order_key) VALUES (${scope.appId},${id},${parent ? clinicLevel : level},${parent},${name},${name},'V')`.execute(
			h.db(),
		);
	}
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES
		(${grant.sessionId},'synthetic-token',${actor.actorId},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
});

it("serves the assigned worker's union in row order, excludes additional places, and rechecks both membership and the request grant", async () => {
	const catalog = await group({
		operationId: v7(),
		expectedProjectRevision: "0",
		change: { kind: "create", name: "North", sharesCases: false, metadata: [] },
	});
	const added = await group({
		operationId: v7(),
		expectedProjectRevision: catalog.projectRevision,
		change: {
			kind: "membership",
			groupId: catalog.groupId,
			appId: scope.appId,
			personaId: worker,
			member: true,
		},
	});
	expect(
		await withAppTx((tx) => readPersonaGroups(tx, scope.appId, worker, true)),
	).toEqual([]);
	const receipt = await batch({
		createTables: [
			{
				key: "roster",
				name: "Roster",
				tag: "roster",
				columns: [
					{ key: "name", wireName: "name", label: "Name", dataType: "text" },
				],
				rows: ["shared", "ancestor", "additional", "other"].map((key) => ({
					key,
					cells: [{ columnKey: "name", value: key }],
				})),
			},
		],
	});
	const t = receipt.tables[0],
		[shared, ancestor, additional, otherRow] = t.rowIds.map((row) => row.id);
	expect(BigInt(receipt.projectRevision)).toBeGreaterThan(
		BigInt(added.projectRevision),
	);
	const op = {
		operationId: v7(),
		updateTables: [
			{
				tableId: t.tableId,
				expectedTableRevision: t.revisions!.tableRevision,
				workerAccess: "assigned" as const,
				rowOperations: [
					{
						kind: "assign" as const,
						rowId: shared,
						assignments: [
							{ kind: "group" as const, id: catalog.groupId },
							{ kind: "worker" as const, appId: scope.appId, id: worker },
						],
					},
					{
						kind: "assign" as const,
						rowId: ancestor,
						assignments: [
							{ kind: "place" as const, appId: scope.appId, id: root },
						],
					},
					{
						kind: "assign" as const,
						rowId: additional,
						assignments: [
							{ kind: "place" as const, appId: scope.appId, id: extra },
						],
					},
					{
						kind: "assign" as const,
						rowId: otherRow,
						assignments: [
							{ kind: "worker" as const, appId: scope.appId, id: other },
						],
					},
				],
			},
		],
	};
	const saved = await batch(op);
	expect(await batch(op)).toEqual(saved);
	const load = (personaUuid?: string) =>
		readWorkerLookupProjection({ scope, grant, personaUuid }, [t.tableId]);
	const first = await load(worker);
	expect(first.rowsByTable.get(t.tableId)?.map((row) => row.id)).toEqual([
		shared,
		ancestor,
	]);
	expect(
		(await load(other)).rowsByTable.get(t.tableId)?.map((row) => row.id),
	).toEqual([otherRow]);
	expect((await load()).rowsByTable.get(t.tableId)).toEqual([]);
	const archive = await withAppTx((tx) =>
		readLookupFixtureDataInTransaction(tx, scope.projectId, [t.tableId]),
	);
	expect(archive.rowsByTable.has(t.tableId)).toBe(false);
	await batch({
		updateTables: [
			{
				tableId: t.tableId,
				expectedTableRevision: saved.tables[0].revisions!.tableRevision,
				rowOperations: [
					{
						kind: "assign",
						rowId: shared,
						assignments: [{ kind: "group", id: catalog.groupId }],
					},
				],
			},
		],
	});
	const current = await load(worker);
	await group({
		operationId: v7(),
		expectedProjectRevision: current.projectRevision,
		change: {
			kind: "membership",
			groupId: catalog.groupId,
			appId: scope.appId,
			personaId: worker,
			member: false,
		},
	});
	const revoked = await load(worker);
	expect(revoked.rowsByTable.get(t.tableId)?.map((row) => row.id)).toEqual([
		ancestor,
	]);
	expect(revoked.workerBinding).not.toBe(first.workerBinding);
	await sql`UPDATE auth_session SET "expiresAt"=now() WHERE id=${grant.sessionId}`.execute(
		h.db(),
	);
	await expect(load(worker)).rejects.toMatchObject({ code: "not_found" });
	await sql`UPDATE auth_session SET "expiresAt"=now()+interval '1 hour' WHERE id=${grant.sessionId}`.execute(
		h.db(),
	);
	await h.removeProjectMember(actor.actorId, scope.projectId);
	await expect(load(worker)).rejects.toThrow();
});
