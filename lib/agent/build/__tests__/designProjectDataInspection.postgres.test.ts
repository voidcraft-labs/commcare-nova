import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
	DESIGN_PROJECT_DATA_CATALOG_PAGE_MAX_BYTES,
	inspectAuthorizedProjectData,
	validateAuthorizedProjectLookupEvidence,
} from "@/lib/agent/build/designLoopRunner";
import {
	fixtureValue,
	ids,
	makeContract,
	messageRef,
} from "@/lib/agent/design/__tests__/fixtures";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import type { LookupScope } from "@/lib/lookup/types";

const h = setupAppStateTestDb("design_project_data_inspection_");

const RUN_ID = "run-project-data-inspector";
const ACTOR = "project-data-inspector";
const PROJECT = "project-data-inspection";
const NONCE = "00000000-0000-4000-8000-000000009901";

async function setup() {
	const designSessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
	});
	const scope: LookupScope = {
		projectId: PROJECT,
		actorId: ACTOR,
		role: "owner",
	};
	const receipt = await h
		.db()
		.transaction()
		.execute((tx) =>
			applyLookupAuthoringBatchInTransaction(tx, scope, {
				createTables: [
					{
						key: "facilities",
						name: "Facilities",
						tag: "facilities",
						columns: [
							{
								key: "name",
								wireName: "name",
								label: "Name",
								dataType: "text",
							},
						],
						rows: [
							{
								key: "clinic",
								cells: [{ columnKey: "name", value: "Clinic" }],
							},
							{
								key: "hospital",
								cells: [{ columnKey: "name", value: "Hospital" }],
							},
						],
					},
				],
			}),
		);
	return {
		args: {
			designSessionId,
			actorUserId: ACTOR,
			projectId: PROJECT,
			runId: RUN_ID,
			holderNonce: NONCE,
		},
		tableId: receipt.tables[0].tableId,
		columnId: receipt.tables[0].columnIds[0]?.id,
		rowIds: receipt.tables[0].rowIds.map((row) => row.id),
		scope,
	};
}

async function addWideCatalogTable(scope: LookupScope) {
	return h
		.db()
		.transaction()
		.execute((tx) =>
			applyLookupAuthoringBatchInTransaction(tx, scope, {
				createTables: [
					{
						key: "wide-catalog-table",
						name: "Wide catalog table",
						tag: "wide_catalog_table",
						columns: Array.from({ length: 250 }, (_, index) => ({
							key: `column-${index}`,
							wireName: `column_${index}_${"w".repeat(220)}`,
							label: `Column ${index} ${"l".repeat(100)}`,
							dataType: "text" as const,
						})),
						rows: [],
					},
				],
			}),
		);
}

describe("reviewed-design Project-data inspection", () => {
	it("returns a rows-free catalog and an identity-addressed row page", async () => {
		const { args, tableId, columnId } = await setup();
		if (columnId === undefined) throw new Error("lookup fixture is incomplete");
		const catalog = await inspectAuthorizedProjectData(args, {});
		expect(catalog).toMatchObject({
			kind: "catalog",
			projectRevision: "1",
			complete: true,
			tables: [
				{
					id: tableId,
					columnCount: 1,
					rowCount: 2,
					tableRevision: "1",
					columnsComplete: true,
				},
			],
		});
		expect(JSON.stringify(catalog)).not.toContain("Clinic");

		const rows = await inspectAuthorizedProjectData(args, {
			tableId,
			choiceProjection: {
				valueColumnId: columnId,
				labelColumnId: columnId,
			},
		});
		expect(rows).toMatchObject({
			kind: "rows",
			table: { id: tableId },
			rows: [
				{ cells: [{ value: "Clinic" }] },
				{ cells: [{ value: "Hospital" }] },
			],
			complete: true,
			choiceProjection: {
				valueColumnId: columnId,
				labelColumnId: columnId,
				inspection: {
					tableRevision: "1",
					tableName: "Facilities",
					valueColumnLabel: "Name",
					labelColumnLabel: "Name",
					rowCount: 2,
					distinctValueCount: 2,
					invalidValueCount: 0,
					blankLabelCount: 0,
					duplicateValueCount: 0,
					projectionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
			},
		});
	});

	it("budgets the complete row result including its choice attestation and cursor", async () => {
		const { args, scope } = await setup();
		const large = "x".repeat(60_000);
		const created = await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					createTables: [
						{
							key: "large-choice",
							name: "Large choice",
							tag: "large_choice",
							columns: [
								{
									key: "value",
									wireName: "value",
									label: "Value",
									dataType: "text",
								},
							],
							rows: [0, 1].map((index) => ({
								key: `row-${index}`,
								cells: [{ columnKey: "value", value: `${index}${large}` }],
							})),
						},
					],
				}),
			);
		const table = created.tables[0];
		const columnId = table.columnIds[0]?.id;
		if (columnId === undefined) throw new Error("lookup fixture is incomplete");
		const projection = {
			valueColumnId: columnId,
			labelColumnId: columnId,
		};
		const first = await inspectAuthorizedProjectData(args, {
			tableId: table.tableId,
			choiceProjection: projection,
		});
		expect(first.kind).toBe("rows");
		if (first.kind !== "rows") throw new Error("Expected a row page.");
		expect(first.rows).toHaveLength(1);
		expect(first.complete).toBe(false);
		expect(first.nextCursor?.length).toBeLessThanOrEqual(4096);
		expect(
			Buffer.byteLength(JSON.stringify(first), "utf8"),
		).toBeLessThanOrEqual(DESIGN_PROJECT_DATA_CATALOG_PAGE_MAX_BYTES);

		const second = await inspectAuthorizedProjectData(args, {
			tableId: table.tableId,
			choiceProjection: projection,
			cursor: first.nextCursor,
		});
		expect(second.kind).toBe("rows");
		if (second.kind !== "rows") throw new Error("Expected a row page.");
		expect(second.rows).toHaveLength(1);
		expect(second.complete).toBe(true);
		expect(
			Buffer.byteLength(JSON.stringify(second), "utf8"),
		).toBeLessThanOrEqual(DESIGN_PROJECT_DATA_CATALOG_PAGE_MAX_BYTES);
	});

	it("pages a large catalog within a fixed byte budget", async () => {
		const { args, scope } = await setup();
		await addWideCatalogTable(scope);

		let page = await inspectAuthorizedProjectData(args, {});
		const columnIds = new Set<string>();
		let sawContinuationSegment = false;
		let pages = 0;
		for (;;) {
			expect(page.kind).toBe("catalog");
			if (page.kind !== "catalog") {
				throw new Error("Expected a Project-data catalog page.");
			}
			pages++;
			expect(
				Buffer.byteLength(JSON.stringify(page), "utf8"),
			).toBeLessThanOrEqual(DESIGN_PROJECT_DATA_CATALOG_PAGE_MAX_BYTES);
			for (const table of page.tables) {
				if (table.columnOffset !== undefined) sawContinuationSegment = true;
				for (const column of table.columns) columnIds.add(column.id);
			}
			if (page.complete) break;
			const cursor = page.nextCursor;
			if (cursor === undefined) {
				throw new Error("An incomplete catalog page omitted its cursor.");
			}
			page = await inspectAuthorizedProjectData(args, {
				cursor,
			});
			expect(pages).toBeLessThan(10);
		}

		expect(pages).toBeGreaterThan(1);
		expect(sawContinuationSegment).toBe(true);
		expect(columnIds.size).toBe(251);
	});

	it("refuses a catalog continuation after the exact Project revision changes", async () => {
		const { args, scope } = await setup();
		await addWideCatalogTable(scope);
		const first = await inspectAuthorizedProjectData(args, {});
		if (first.kind !== "catalog" || first.nextCursor === undefined) {
			throw new Error("Expected the wide catalog to continue.");
		}

		await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					createTables: [
						{
							key: "new-project-generation",
							name: "New Project generation",
							tag: "new_project_generation",
							columns: [
								{
									key: "value",
									wireName: "value",
									label: "Value",
									dataType: "text",
								},
							],
							rows: [],
						},
					],
				}),
			);

		await expect(
			inspectAuthorizedProjectData(args, { cursor: first.nextCursor }),
		).resolves.toMatchObject({
			kind: "error",
			code: "conflict",
			error: expect.stringContaining("changed"),
		});
	});

	it("validates the complete revision-bound choice attestation before persistence", async () => {
		const { args, tableId, columnId } = await setup();
		if (columnId === undefined) throw new Error("lookup fixture is incomplete");
		const inspected = await inspectAuthorizedProjectData(args, {
			tableId,
			choiceProjection: {
				valueColumnId: columnId,
				labelColumnId: columnId,
			},
		});
		if (inspected.kind !== "rows" || inspected.choiceProjection === undefined)
			throw new Error("choice attestation is missing");
		const contract = makeContract();
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId,
			valueColumnId: columnId,
			labelColumnId: columnId,
			inspection: inspected.choiceProjection.inspection,
		};
		expect(
			await validateAuthorizedProjectLookupEvidence(args, contract),
		).toEqual([]);

		risk.choiceSource.inspection.projectionDigest = "f".repeat(64);
		expect(
			await validateAuthorizedProjectLookupEvidence(args, contract),
		).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("does not match"),
			}),
		]);
	});

	it("validates approved existing-row changes against authoritative pre-state", async () => {
		const { args, tableId, columnId, rowIds } = await setup();
		if (columnId === undefined || rowIds[1] === undefined)
			throw new Error("lookup fixture is incomplete");
		const inspected = await inspectAuthorizedProjectData(args, {
			tableId,
			choiceProjection: {
				valueColumnId: columnId,
				labelColumnId: columnId,
			},
		});
		if (inspected.kind !== "rows" || inspected.choiceProjection === undefined)
			throw new Error("choice attestation is missing");
		const contract = makeContract();
		const risk = fixtureValue(
			contract.records[0]?.properties.find(
				(property) => property.id === ids.factRisk,
			),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId,
			valueColumnId: columnId,
			labelColumnId: columnId,
			inspection: inspected.choiceProjection.inspection,
		};
		contract.lookupTables.push({
			kind: "modify-existing",
			id: ids.lookupRisk,
			tableId,
			expectedTableRevision: "1" as never,
			purpose: "Apply the requested facility correction.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "This changes the shared facility table.",
			},
			operations: [
				{
					kind: "update-row",
					rowId: rowIds[1],
					cells: [
						{
							column: { kind: "existing-column", columnId },
							value: "Clinic",
						},
					],
					rowEvidence: {
						sourceRefs: [messageRef()],
						summary: "The request corrects this exact facility row.",
					},
				},
			],
		});
		expect(
			await validateAuthorizedProjectLookupEvidence(args, contract),
		).toEqual([
			expect.objectContaining({
				message: expect.stringContaining("at least two distinct"),
			}),
		]);

		const changed = contract.lookupTables.find(
			(table) => table.kind === "modify-existing",
		);
		const operation =
			changed?.kind === "modify-existing" ? changed.operations[0] : undefined;
		if (operation?.kind !== "update-row")
			throw new Error("expected update-row operation");
		operation.cells[0] = {
			column: { kind: "existing-column", columnId },
			value: "Hospital2",
		};
		expect(
			await validateAuthorizedProjectLookupEvidence(args, contract),
		).toEqual([]);
	});

	it("rejects stable operation columns from a different existing table", async () => {
		const { args, tableId } = await setup();
		const foreign = await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(
					tx,
					{ projectId: PROJECT, actorId: ACTOR, role: "owner" },
					{
						createTables: [
							{
								key: "foreign",
								name: "Foreign table",
								tag: "foreign_table",
								columns: [
									{
										key: "foreign_column",
										wireName: "foreign_column",
										label: "Foreign column",
										dataType: "text",
									},
								],
								rows: [],
							},
						],
					},
				),
			);
		const foreignColumnId = foreign.tables[0]?.columnIds[0]?.id;
		if (foreignColumnId === undefined)
			throw new Error("foreign lookup fixture is incomplete");
		const contract = makeContract();
		contract.lookupTables.push({
			kind: "modify-existing",
			id: ids.lookupRisk,
			tableId,
			expectedTableRevision: "1" as never,
			purpose: "Apply the requested shared-column correction.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "This changes one shared Project table.",
			},
			operations: [
				{
					kind: "update-column",
					columnId: foreignColumnId,
					label: "Incorrect target",
				},
			],
		});
		expect(
			await validateAuthorizedProjectLookupEvidence(args, contract),
		).toEqual([
			expect.objectContaining({
				path: ["lookupTables", 0, "operations", 0, "columnId"],
				message: expect.stringContaining("does not belong"),
			}),
		]);
	});

	it("reproves the exact holder and current edit membership on every call", async () => {
		const { args } = await setup();
		await h
			.db()
			.updateTable("design_sessions")
			.set({ run_holder_nonce: crypto.randomUUID() })
			.where("id", "=", args.designSessionId)
			.execute();
		await expect(inspectAuthorizedProjectData(args, {})).rejects.toMatchObject({
			name: "RunHolderLostError",
		});

		await h
			.db()
			.updateTable("design_sessions")
			.set({ run_holder_nonce: NONCE })
			.where("id", "=", args.designSessionId)
			.execute();
		await sql`
			UPDATE auth_member
			SET role = 'viewer'
			WHERE "organizationId" = ${PROJECT}
				AND "userId" = ${ACTOR}
		`.execute(h.db());
		await expect(inspectAuthorizedProjectData(args, {})).rejects.toThrow(
			"no longer have edit access",
		);
	});
});
