import { sql } from "kysely";
import { v7 } from "uuid";
import { beforeEach, expect, it } from "vitest";
import { getWorkerGroupsTool } from "@/lib/agent/tools/workerGroups";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import {
	canonicalTestBlueprint,
	setupAppStateTestDb,
} from "@/lib/db/__tests__/appStateTestDb";
import { withAppTx } from "@/lib/db/pg";
import { readWorkerLookupProjection } from "@/lib/deployment/workerLookupProjection";
import { asUuid } from "@/lib/domain/uuid";
import type { WorkerGroupEdit } from "../assignmentVocabulary";
import { applyLookupAuthoringBatchInTransaction } from "../authoringBatch";
import { readLookupFixtureDataInTransaction } from "../fixtureSnapshot";
import { editWorkerGroup, readPersonaGroups } from "../workerGroups";
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
	unassigned = asUuid(v7()),
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
			[unassigned]: { uuid: unassigned, name: "Sam" },
		},
		personaOrder: [worker, other, unassigned],
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
				expectedTableRevision: revisionsOf(t.revisions).tableRevision,
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
				expectedTableRevision: revisionsOf(saved.tables[0].revisions)
					.tableRevision,
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

it("projects ordered rich rows by assignment even when two rows have identical labels", async () => {
	const clinics = [
		{
			code: "east-one",
			english: "Twin clinic",
			french: "Clinique jumelle",
			assignee: worker,
		},
		{
			code: "east-two",
			english: "Twin clinic",
			french: "Clinique jumelle",
			assignee: worker,
		},
		{
			code: "west-one",
			english: "West clinic",
			french: "Clinique ouest",
			assignee: other,
		},
	];
	const {
		tables: [created],
	} = await batch({
		createTables: [
			{
				key: "clinics",
				name: "Clinics",
				tag: "clinics",
				attributes: [{ wireName: "code", label: "Code" }],
				columns: [
					{
						key: "name",
						wireName: "name",
						label: "Name",
						dataType: "text",
						repeated: true,
						properties: [{ wireName: "lang", label: "Language" }],
					},
				],
				rows: clinics.map(({ code, english, french }) => ({
					key: code,
					cells: [],
					content: {
						attributes: { code },
						occurrences: {
							name: [
								{ text: english, properties: { lang: "en" } },
								{ text: french, properties: { lang: "fr" } },
							],
						},
					},
				})),
			},
		],
	});
	const { tableId, rowIds } = created;
	await batch({
		updateTables: [
			{
				tableId,
				expectedTableRevision: revisionsOf(created.revisions).tableRevision,
				workerAccess: "assigned",
				rowOperations: rowIds.map(({ id }, index) => ({
					kind: "assign",
					rowId: id,
					assignments: [
						{ kind: "worker", appId: scope.appId, id: clinics[index].assignee },
					],
				})),
			},
		],
	});
	const read = (personaUuid: string) =>
		readWorkerLookupProjection({ scope, grant, personaUuid }, [tableId]);
	const east = await read(worker);
	const west = await read(other);
	const none = await read(unassigned);
	const [table] = east.definitions;
	const [name] = table.columns;
	const code = table.attributes?.[0];
	const lang = name.properties?.[0];
	if (!code || !lang)
		throw new Error(
			"The row attribute and occurrence property were not stored.",
		);
	expect(new Set(rowIds.map(({ id }) => id)).size).toBe(3);
	const projected = clinics.map(({ code: key, english, french }, index) => ({
		id: rowIds[index].id,
		attributes: { [code.id]: key },
		occurrences: {
			[name.id]: [
				{ text: english, properties: { [lang.id]: "en" } },
				{ text: french, properties: { [lang.id]: "fr" } },
			],
		},
		values: {},
	}));
	expect(east.rowsByTable.get(tableId)).toEqual(projected.slice(0, 2));
	expect(west.rowsByTable.get(tableId)).toEqual(projected.slice(2));
	expect(none.rowsByTable.get(tableId)).toEqual([]);
	const generic = await withAppTx((tx) =>
		readLookupFixtureDataInTransaction(tx, scope.projectId, [tableId]),
	);
	expect(generic.rowsByTable.has(tableId)).toBe(false);
});

function revisionsOf<T>(revisions: T | undefined): T {
	if (revisions === undefined)
		throw new Error("The saved table returned no revisions.");
	return revisions;
}

it("answers an agent's read of a group that no longer exists with the refusal, not a tool failure", async () => {
	const context = {
		appId: scope.appId,
		projectId: scope.projectId,
		userId: scope.actorUserId,
		runId: "worker-groups-run",
		invocation: {
			requestId: "worker-groups-read",
			invocationOrdinal: 0,
			toolName: "getWorkerGroups",
		},
	} as unknown as ToolInvocationContext;
	const gone = asUuid(v7());
	expect(
		await getWorkerGroupsTool.execute({ search: {}, groupId: gone }, context),
	).toEqual({
		kind: "read",
		data: expect.objectContaining({ success: false, code: "not_found" }),
	});
});
