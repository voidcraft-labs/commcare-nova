import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import type { DesignArtifactWriteAuthority } from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContract,
	appDesignContractBaseSchema,
	appDesignContractSchema,
} from "@/lib/agent/design/contract";
import { sealArtifactEnvelope } from "@/lib/agent/design/envelope";
import { computeLookupChoiceProjectionAttestation } from "@/lib/agent/design/lookupChoiceAttestation";
import {
	assertDesignLookupMaterializationCurrentInTransaction,
	ensureAcceptedLookupMaterialization,
} from "@/lib/agent/design/lookupMaterialization";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { getAllLookupDefinitions, getLookupTable } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	did,
	ids,
	makeContract,
	makeLookupContract,
	messageRef,
} from "./fixtures";
import { persistAcceptedRevisionFixture } from "./persistedFixtures";

const h = setupAppStateTestDb("design_lookup_materialization_", { poolMax: 3 });

const RUN_ID = "run-design-lookup";
const ACTOR = "lookup-designer";
const PROJECT = "project-design-lookup";
const NONCE = "00000000-0000-4000-8000-000000009701";

const scope: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "owner",
};

function authority(): DesignArtifactWriteAuthority {
	return {
		actorUserId: ACTOR,
		runId: RUN_ID,
		holderNonce: NONCE,
		expectedProjectId: PROJECT,
	};
}

function designedLookupContract(): AppDesignContract {
	return makeLookupContract();
}

async function seedAcceptedRevision(
	contract: AppDesignContract = designedLookupContract(),
	storedPayload: unknown = contract,
): Promise<{
	designSessionId: string;
	designRevisionId: string;
	designRevisionDigest: string;
}> {
	const designSessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
	});
	const persisted = await persistAcceptedRevisionFixture({
		designSessionId,
		authority: authority(),
		contract,
	});
	let accepted = persisted.accepted;
	if (storedPayload !== contract) {
		// Explicit legacy-storage reader control. Normal accepted fixtures enter
		// through the actual source, draft, independent review and acceptance writers.
		const { artifactDigest: _digest, ...unsealed } = accepted.envelope;
		const envelope = sealArtifactEnvelope({
			...unsealed,
			payload: storedPayload,
		});
		await h
			.db()
			.updateTable("design_revisions")
			.set({
				envelope: JSON.stringify(envelope),
				artifact_digest: envelope.artifactDigest,
				contract_digest: canonicalJsonDigest(storedPayload),
			})
			.where("id", "=", accepted.id)
			.execute();
		accepted = { ...accepted, artifactDigest: envelope.artifactDigest };
	}
	return {
		designSessionId,
		designRevisionId: accepted.id,
		designRevisionDigest: accepted.artifactDigest,
	};
}

async function materialize(
	lineage: Awaited<ReturnType<typeof seedAcceptedRevision>>,
	contract = designedLookupContract(),
) {
	return ensureAcceptedLookupMaterialization({
		...lineage,
		contract,
		authority: authority(),
	});
}

async function seedSuccessorAcceptedRevision(
	prior: Awaited<ReturnType<typeof seedAcceptedRevision>>,
	contract: AppDesignContract,
) {
	const previous = await h
		.db()
		.selectFrom("design_revisions")
		.select(["id", "revision", "artifact_digest"])
		.where("id", "=", prior.designRevisionId)
		.executeTakeFirstOrThrow();
	const { accepted } = await persistAcceptedRevisionFixture({
		designSessionId: prior.designSessionId,
		authority: authority(),
		contract,
		predecessor: {
			id: previous.id,
			revision: Number(previous.revision),
			artifactDigest: previous.artifact_digest,
		},
	});
	return {
		designSessionId: prior.designSessionId,
		designRevisionId: accepted.id,
		designRevisionDigest: accepted.artifactDigest,
	};
}

async function existingLookupFixture() {
	const created = await h
		.db()
		.transaction()
		.execute((tx) =>
			applyLookupAuthoringBatchInTransaction(tx, scope, {
				createTables: [
					{
						key: "existing",
						name: "Existing risk",
						tag: "existing_risk",
						columns: [
							{
								key: "value",
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
							{
								key: "label",
								wireName: "label",
								label: "Label",
								dataType: "text",
							},
							{
								key: "number",
								wireName: "number",
								label: "Number",
								dataType: "text",
							},
							{
								key: "discard",
								wireName: "discard",
								label: "Discard",
								dataType: "text",
							},
						],
						rows: ["low", "high", "priority"].map((value) => ({
							key: value,
							cells: [
								{ columnKey: "value", value },
								{ columnKey: "label", value: value.toUpperCase() },
							],
						})),
					},
				],
			}),
		);
	const table = created.tables[0];
	const column = (key: string) => {
		const id = table.columnIds.find((item) => item.key === key)?.id;
		if (id === undefined) throw new Error(`Missing fixture column ${key}`);
		return id;
	};
	const row = (key: string) => {
		const id = table.rowIds.find((item) => item.key === key)?.id;
		if (id === undefined) throw new Error(`Missing fixture row ${key}`);
		return id;
	};
	const contract = makeContract();
	const risk = contract.records[0]?.properties.find(
		(property) => property.id === ids.factRisk,
	);
	if (risk === undefined) throw new Error("Missing risk property");
	delete risk.choiceValues;
	risk.choiceSource = {
		kind: "existing-project-lookup",
		tableId: table.tableId,
		valueColumnId: column("value"),
		labelColumnId: column("label"),
		inspection: computeLookupChoiceProjectionAttestation({
			tableRevision: created.projectRevision,
			tableName: "Existing risk",
			valueColumnLabel: "Value",
			labelColumnLabel: "Label",
			rows: ["low", "high", "priority"].map((value) => ({
				rowId: row(value),
				value,
				label: value.toUpperCase(),
			})),
		}),
	};
	return { table, column, row, contract };
}

describe("accepted design lookup materialization", () => {
	it("refuses a source package whose payload Project disagrees with its stored authority", async () => {
		const lineage = await seedAcceptedRevision();
		await sql`UPDATE design_source_packages SET payload = jsonb_set(payload, '{projectId}', '"another-project"'::jsonb) WHERE design_session_id = ${lineage.designSessionId}`.execute(
			h.db(),
		);
		await expect(materialize(lineage)).rejects.toThrow(
			"different identity or digest",
		);
		expect((await getAllLookupDefinitions(scope)).definitions).toEqual([]);
	});
	it("materializes ordered existing-table edits through the real authoring and governance writers", async () => {
		const { table, column, row, contract } = await existingLookupFixture();
		const extra = did(700),
			extra2 = did(701),
			urgent = did(702),
			tail = did(703);
		const rowEvidence = {
			sourceRefs: [messageRef()],
			summary: "The request specifies these exact risk rows.",
		};
		const col = (key: string) => ({
			kind: "existing-column" as const,
			columnId: column(key),
		});
		contract.lookupTables = [
			{
				kind: "modify-existing",
				id: ids.lookupRisk,
				tableId: table.tableId,
				expectedTableRevision: "1" as never,
				purpose: "Apply the reviewed shared risk update",
				authorization: {
					kind: "direct-user-request",
					sourceRefs: [messageRef()],
					impactSummary: "Changes the shared risk table.",
				},
				operations: [
					{ kind: "update-table", name: "Reviewed risk", tag: "reviewed_risk" },
					{
						kind: "update-column",
						columnId: column("label"),
						label: "Display",
						wireName: "caption",
					},
					{
						kind: "update-column",
						columnId: column("number"),
						dataType: "int",
					},
					{
						kind: "add-column",
						column: {
							id: extra,
							wireName: "extra",
							label: "Extra",
							dataType: "text",
						},
						after: col("label"),
					},
					{
						kind: "add-column",
						column: {
							id: extra2,
							wireName: "front",
							label: "Front",
							dataType: "text",
						},
						after: { kind: "added-column", columnId: extra },
					},
					{
						kind: "move-column",
						column: { kind: "added-column", columnId: extra2 },
					},
					{ kind: "remove-column", columnId: column("discard") },
					{
						kind: "update-row",
						rowId: row("low"),
						cells: [
							{ column: col("value"), value: "routine" },
							{ column: col("label"), value: "Routine" },
							{ column: col("number"), value: 1 },
							{
								column: { kind: "added-column", columnId: extra },
								value: "alpha",
							},
						],
						rowEvidence,
					},
					{ kind: "remove-row", rowId: row("high") },
					{
						kind: "add-row",
						rowId: urgent,
						after: { kind: "existing-row", rowId: row("low") },
						cells: [
							{ column: col("value"), value: "urgent" },
							{ column: col("label"), value: "Urgent" },
							{ column: col("number"), value: 2 },
						],
						rowEvidence,
					},
					{
						kind: "add-row",
						rowId: tail,
						after: { kind: "added-row", rowId: urgent },
						cells: [
							{ column: col("value"), value: "tail" },
							{ column: col("label"), value: "Tail" },
						],
						rowEvidence,
					},
					{ kind: "move-row", row: { kind: "added-row", rowId: urgent } },
					{
						kind: "move-row",
						row: { kind: "existing-row", rowId: row("priority") },
						after: { kind: "added-row", rowId: tail },
					},
				],
			},
		];
		const admitted = appDesignContractSchema.parse(contract);
		const receipt = await materialize(
			await seedAcceptedRevision(admitted),
			admitted,
		);
		if (receipt === null) throw new Error("Expected receipt");
		const addedId = (designId: string) => {
			const binding = receipt.payload.bindings.find(
				(item) => item.designId === designId,
			);
			if (binding === undefined) throw new Error("Missing created identity");
			return binding.lookupId;
		};
		expect(
			await h
				.db()
				.selectFrom("lookup_tables")
				.select(["name", "tag"])
				.where("id", "=", table.tableId)
				.executeTakeFirstOrThrow(),
		).toEqual({ name: "Reviewed risk", tag: "reviewed_risk" });
		expect(
			await h
				.db()
				.selectFrom("lookup_columns")
				.select(["id", "wire_name", "label", "data_type"])
				.where("table_id", "=", table.tableId)
				.orderBy("order_key")
				.execute(),
		).toEqual([
			{
				id: addedId(extra2),
				wire_name: "front",
				label: "Front",
				data_type: "text",
			},
			{
				id: column("value"),
				wire_name: "value",
				label: "Value",
				data_type: "text",
			},
			{
				id: column("label"),
				wire_name: "caption",
				label: "Display",
				data_type: "text",
			},
			{
				id: addedId(extra),
				wire_name: "extra",
				label: "Extra",
				data_type: "text",
			},
			{
				id: column("number"),
				wire_name: "number",
				label: "Number",
				data_type: "int",
			},
		]);
		expect(
			await h
				.db()
				.selectFrom("lookup_rows")
				.select(["id", "values"])
				.where("table_id", "=", table.tableId)
				.orderBy("order_key")
				.execute(),
		).toEqual([
			{
				id: addedId(urgent),
				values: {
					[column("value")]: "urgent",
					[column("label")]: "Urgent",
					[column("number")]: 2,
				},
			},
			{
				id: row("low"),
				values: {
					[column("value")]: "routine",
					[column("label")]: "Routine",
					[column("number")]: 1,
					[addedId(extra)]: "alpha",
				},
			},
			{
				id: addedId(tail),
				values: { [column("value")]: "tail", [column("label")]: "Tail" },
			},
			{
				id: row("priority"),
				values: {
					[column("value")]: "priority",
					[column("label")]: "PRIORITY",
				},
			},
		]);
		expect(receipt.payload.projectRevision).toBe("2");
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("column_id")
				.where("materialization_id", "=", receipt.id)
				.execute(),
		).toEqual(
			expect.arrayContaining(
				[
					null,
					addedId(extra),
					addedId(extra2),
					column("value"),
					column("label"),
					column("number"),
				].map((column_id) => ({ column_id })),
			),
		);
	});

	it("replaces the complete row set with minted identities while preserving the existing columns", async () => {
		const { table, column, row, contract } = await existingLookupFixture();
		contract.lookupTables = [
			{
				kind: "modify-existing",
				id: ids.lookupRisk,
				tableId: table.tableId,
				expectedTableRevision: "1" as never,
				purpose: "Replace reviewed values",
				authorization: {
					kind: "direct-user-request",
					sourceRefs: [messageRef()],
					impactSummary: "Replaces all rows in the shared risk table.",
				},
				operations: [
					{
						kind: "replace-rows",
						rowEvidence: {
							sourceRefs: [messageRef()],
							summary: "The request names exactly the two replacement values.",
						},
						rows: ["routine", "urgent"].map((value, index) => ({
							id: did(750 + index),
							cells: [
								{
									column: {
										kind: "existing-column",
										columnId: column("value"),
									},
									value,
								},
								{
									column: {
										kind: "existing-column",
										columnId: column("label"),
									},
									value: value.toUpperCase(),
								},
							],
						})),
					},
				],
			},
		];
		const admitted = appDesignContractSchema.parse(contract);
		const receipt = await materialize(
			await seedAcceptedRevision(admitted),
			admitted,
		);
		if (receipt === null) throw new Error("Expected receipt");
		const rows = await h
			.db()
			.selectFrom("lookup_rows")
			.select(["id", "values"])
			.where("table_id", "=", table.tableId)
			.orderBy("order_key")
			.execute();
		expect(rows).toEqual(
			["routine", "urgent"].map((value, index) => ({
				id: receipt.payload.bindings.find(
					(binding) => binding.designId === did(750 + index),
				)?.lookupId,
				values: {
					[column("value")]: value,
					[column("label")]: value.toUpperCase(),
				},
			})),
		);
		expect(rows.map(({ id }) => id)).not.toEqual(
			expect.arrayContaining([row("low"), row("high"), row("priority")]),
		);
		expect(receipt.payload.projectRevision).toBe("2");
	});
	it("normalizes a digest-verified historical list selection before materializing", async () => {
		const contract = designedLookupContract();
		const stored = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		const list = (stored.lists as Array<Record<string, unknown>>)[0];
		if (list === undefined) throw new Error("Expected a list fixture.");
		const module = (
			stored.moduleCompositions as Array<Record<string, unknown>>
		)[0];
		if (module === undefined) throw new Error("Expected a module fixture.");
		const selection = module.selection as { readonly workflowIds: string[] };
		delete module.selection;
		list.selectionWorkflowId = selection.workflowIds[0];

		const lineage = await seedAcceptedRevision(contract, stored);
		const receipt = await materialize(lineage, contract);

		expect(receipt).not.toBeNull();
		expect((await getAllLookupDefinitions(scope)).definitions).toHaveLength(1);
	});

	it("refuses Project-data evidence outside the accepted source package", async () => {
		const contract = designedLookupContract();
		const table = contract.lookupTables[0];
		if (table?.kind !== "create") throw new Error("Expected a create intent.");
		table.rowEvidence.sourceRefs = [messageRef(7)];
		const lineage = await seedAcceptedRevision(contract);
		await expect(materialize(lineage, contract)).rejects.toThrow(
			"cites evidence outside the accepted design's source package",
		);
		expect((await getAllLookupDefinitions(scope)).definitions).toEqual([]);
	});

	it("refuses a different caller contract under the same accepted lineage", async () => {
		const acceptedContract = designedLookupContract();
		const lineage = await seedAcceptedRevision(acceptedContract);
		const differentContract = structuredClone(acceptedContract);
		const table = differentContract.lookupTables[0];
		if (table?.kind !== "create") throw new Error("Expected a create intent.");
		table.name = "Unreviewed replacement";

		await expect(materialize(lineage, differentContract)).rejects.toThrow(
			"exact persisted accepted Design Contract",
		);
		expect((await getAllLookupDefinitions(scope)).definitions).toEqual([]);
	});

	it("atomically mints stable UUIDs and converges after a lost response", async () => {
		const lineage = await seedAcceptedRevision();
		const first = await materialize(lineage);
		if (first === null) throw new Error("Expected a lookup receipt.");
		expect(first.payload.projectRevision).toBe("1");
		expect(first.payload.bindings.map(({ kind }) => kind)).toEqual([
			"lookup-table",
			"lookup-column",
			"lookup-column",
			"lookup-row",
			"lookup-row",
		]);
		const table = first.payload.bindings.find(
			(binding) => binding.kind === "lookup-table",
		);
		const value = first.payload.bindings.find(
			(binding) => binding.designId === ids.lookupRiskValue,
		);
		const label = first.payload.bindings.find(
			(binding) => binding.designId === ids.lookupRiskLabel,
		);
		if (
			table?.kind !== "lookup-table" ||
			value?.kind !== "lookup-column" ||
			label?.kind !== "lookup-column"
		)
			throw new Error("Missing actual lookup identities");
		expect(
			await h
				.db()
				.selectFrom("lookup_tables")
				.select(["id", "name", "tag", "project_id"])
				.where("project_id", "=", PROJECT)
				.execute(),
		).toEqual([
			{
				id: table.lookupId,
				name: "Risk levels",
				tag: "risk_levels",
				project_id: PROJECT,
			},
		]);
		expect(
			await h
				.db()
				.selectFrom("lookup_columns")
				.select(["id", "wire_name", "label", "data_type"])
				.where("table_id", "=", table.lookupId)
				.orderBy("order_key")
				.execute(),
		).toEqual([
			{
				id: value.lookupId,
				wire_name: "value",
				label: "Value",
				data_type: "text",
			},
			{
				id: label.lookupId,
				wire_name: "label",
				label: "Label",
				data_type: "text",
			},
		]);
		expect(
			await h
				.db()
				.selectFrom("lookup_rows")
				.select(["id", "values"])
				.where("table_id", "=", table.lookupId)
				.orderBy("order_key")
				.execute(),
		).toEqual([
			{
				id: first.payload.bindings.find(
					(binding) => binding.designId === ids.lookupRiskRoutine,
				)?.lookupId,
				values: { [value.lookupId]: "routine", [label.lookupId]: "Routine" },
			},
			{
				id: first.payload.bindings.find(
					(binding) => binding.designId === ids.lookupRiskPriority,
				)?.lookupId,
				values: { [value.lookupId]: "priority", [label.lookupId]: "Priority" },
			},
		]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("materialization_id", "=", first.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "3" });

		const recovered = await materialize(lineage);
		expect(recovered?.id).toBe(first.id);
		expect(recovered?.resultDigest).toBe(first.resultDigest);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("materialization_id", "=", first.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "3" });
		expect((await getAllLookupDefinitions(scope)).projectRevision).toBe("1");
	});

	it("converges competing materializers through actual PostgreSQL lock waits", async () => {
		const lineage = await seedAcceptedRevision();
		const results = await whileBlocked(
			h,
			(pg) =>
				pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
					lineage.designSessionId,
				]),
			() => Promise.allSettled([materialize(lineage), materialize(lineage)]),
			async (settled, pg) => {
				expect(settled).toBe(false);
				const deadline = Date.now() + 2_000;
				for (;;) {
					await pg.query("SELECT pg_stat_clear_snapshot()");
					const waiters = await pg.query<{ n: number }>(
						"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
					);
					if (waiters.rows[0].n >= 2) break;
					if (Date.now() > deadline)
						throw new Error("Both materializers did not reach SQL lock waits");
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			},
		);
		const receipts = results.map((result) => {
			if (result.status === "rejected") throw result.reason;
			if (result.value === null) throw new Error("Expected a lookup receipt");
			return result.value;
		});
		expect(receipts[0].id).toBe(receipts[1].id);
		expect(receipts[0].payload).toEqual(receipts[1].payload);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_materializations")
				.select("id")
				.execute(),
		).toEqual([{ id: receipts[0].id }]);
		expect((await getAllLookupDefinitions(scope)).projectRevision).toBe("1");
	});

	it("rolls back created rows and revisions when the final protection insert fails", async () => {
		const lineage = await seedAcceptedRevision();
		await sql`CREATE FUNCTION reject_lookup_protection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected final protection failure'; END $$`.execute(
			h.db(),
		);
		await sql`CREATE TRIGGER reject_lookup_protection BEFORE INSERT ON design_lookup_protections FOR EACH ROW EXECUTE FUNCTION reject_lookup_protection()`.execute(
			h.db(),
		);
		try {
			await expect(materialize(lineage)).rejects.toThrow(
				"injected final protection failure",
			);
			for (const table of [
				"lookup_tables",
				"lookup_columns",
				"lookup_rows",
				"design_lookup_materializations",
				"design_lookup_protections",
			] as const) {
				expect(await h.db().selectFrom(table).select("id").execute()).toEqual(
					[],
				);
			}
			expect((await getAllLookupDefinitions(scope)).projectRevision).toBe("0");
		} finally {
			await sql`DROP TRIGGER reject_lookup_protection ON design_lookup_protections`.execute(
				h.db(),
			);
			await sql`DROP FUNCTION reject_lookup_protection()`.execute(h.db());
		}
		expect((await materialize(lineage))?.payload.projectRevision).toBe("1");
	});

	it("binds a recovered receipt to its stored revision metadata", async () => {
		const lineage = await seedAcceptedRevision();
		const receipt = await materialize(lineage);
		if (receipt === null) throw new Error("Expected a lookup receipt");
		const forged = {
			...receipt.payload,
			designRevisionId: crypto.randomUUID(),
		};
		await h
			.db()
			.updateTable("design_lookup_materializations")
			.set({
				mapping: JSON.stringify(forged),
				result_digest: canonicalJsonDigest(forged),
			})
			.where("id", "=", receipt.id)
			.execute();
		await expect(materialize(lineage)).rejects.toThrow("stored lineage");
	});

	it("refuses genesis revalidation for a different design session", async () => {
		const lineage = await seedAcceptedRevision();
		await materialize(lineage);
		await expect(
			h
				.db()
				.transaction()
				.execute((tx) =>
					assertDesignLookupMaterializationCurrentInTransaction(tx, {
						...lineage,
						designSessionId: crypto.randomUUID(),
						projectId: PROJECT,
					}),
				),
		).rejects.toThrow("stored lineage");
	});

	it("releases only superseded revision protections, including a no-lookup successor", async () => {
		const firstLineage = await seedAcceptedRevision();
		const first = await materialize(firstLineage);
		if (first === null) throw new Error("Expected the first lookup receipt.");

		const successorContract = designedLookupContract();
		const successorTable = successorContract.lookupTables[0];
		if (successorTable?.kind !== "create")
			throw new Error("Expected a successor create intent.");
		successorTable.name = "Second risk levels";
		successorTable.tag = "risk_levels_2";
		const secondLineage = await seedSuccessorAcceptedRevision(
			firstLineage,
			successorContract,
		);
		const second = await materialize(secondLineage, successorContract);
		if (second === null) throw new Error("Expected the second lookup receipt.");
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("materialization_id")
				.where("materialization_id", "in", [first.id, second.id])
				.orderBy("materialization_id")
				.execute(),
		).toEqual([
			expect.objectContaining({ materialization_id: second.id }),
			expect.objectContaining({ materialization_id: second.id }),
			expect.objectContaining({ materialization_id: second.id }),
		]);

		const noLookupContract = appDesignContractBaseSchema.parse(makeContract());
		const thirdLineage = await seedSuccessorAcceptedRevision(
			secondLineage,
			noLookupContract,
		);
		expect(await materialize(thirdLineage, noLookupContract)).toBeNull();
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("id")
				.where(
					"materialization_id",
					"in",
					h
						.db()
						.selectFrom("design_lookup_materializations")
						.select("id")
						.where("design_session_id", "=", firstLineage.designSessionId),
				)
				.execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_materializations")
				.select(({ fn }) => fn.countAll<string>().as("n"))
				.where("design_session_id", "=", firstLineage.designSessionId)
				.executeTakeFirstOrThrow(),
		).toEqual({ n: "2" });
	});

	it("refuses receipt reuse after the reviewed table state drifts", async () => {
		const lineage = await seedAcceptedRevision();
		const receipt = await materialize(lineage);
		if (receipt === null) throw new Error("Expected a lookup receipt.");
		const tableBinding = receipt.payload.bindings.find(
			(binding) => binding.kind === "lookup-table",
		);
		const rowBinding = receipt.payload.bindings.find(
			(binding) => binding.kind === "lookup-row",
		);
		const valueBinding = receipt.payload.bindings.find(
			(binding) =>
				binding.kind === "lookup-column" &&
				binding.designId === ids.lookupRiskValue,
		);
		if (
			tableBinding?.kind !== "lookup-table" ||
			rowBinding?.kind !== "lookup-row" ||
			valueBinding?.kind !== "lookup-column"
		) {
			throw new Error("Materialization omitted an expected identity.");
		}
		const snapshot = await getLookupTable(scope, tableBinding.lookupId);
		await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					updateTables: [
						{
							tableId: tableBinding.lookupId,
							expectedTableRevision: snapshot.tableRevision,
							rowOperations: [
								{
									kind: "update",
									rowId: rowBinding.lookupId,
									cells: [
										{
											columnId: valueBinding.lookupId,
											value: "changed",
										},
									],
								},
							],
						},
					],
				}),
			);

		await expect(materialize(lineage)).rejects.toThrow(
			"Project data changed after this design was accepted",
		);
	});

	it("hands temporary protections off only after exact genesis revalidation", async () => {
		const lineage = await seedAcceptedRevision();
		const receipt = await materialize(lineage);
		if (receipt === null) throw new Error("Expected a lookup receipt.");
		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await assertDesignLookupMaterializationCurrentInTransaction(tx, {
					designSessionId: lineage.designSessionId,
					designRevisionId: lineage.designRevisionId,
					designRevisionDigest: lineage.designRevisionDigest,
					projectId: PROJECT,
				});
				await releaseDesignLookupProtectionsInTransaction(
					tx,
					lineage.designSessionId,
				);
			});
		expect(
			await h
				.db()
				.selectFrom("design_lookup_protections")
				.select("id")
				.where("materialization_id", "=", receipt.id)
				.execute(),
		).toEqual([]);
		expect(
			await h
				.db()
				.selectFrom("design_lookup_materializations")
				.select("id")
				.where("id", "=", receipt.id)
				.executeTakeFirst(),
		).toEqual({ id: receipt.id });
	});

	it("rolls back every proposed table when an existing-table revision conflicts", async () => {
		const existing = await h
			.db()
			.transaction()
			.execute((tx) =>
				applyLookupAuthoringBatchInTransaction(tx, scope, {
					createTables: [
						{
							key: "existing",
							name: "Existing",
							tag: "existing",
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
		const contract = designedLookupContract();
		const existingColumnId = existing.tables[0]?.columnIds[0]?.id;
		const workflow = contract.workflows[0];
		if (existingColumnId === undefined || workflow === undefined) {
			throw new Error("Existing lookup fixture is incomplete.");
		}
		workflow.inputs.push({
			handle: "existing_category",
			name: "Existing category",
			purpose: "Exercise an accepted change to a table used by this app.",
			dataShape: "single-choice",
			choiceSource: {
				kind: "existing-project-lookup",
				tableId: existing.tables[0].tableId,
				valueColumnId: existingColumnId,
				labelColumnId: existingColumnId,
				inspection: computeLookupChoiceProjectionAttestation({
					tableRevision: "0" as never,
					tableName: "Existing",
					valueColumnLabel: "Value",
					labelColumnLabel: "Value",
					rows: [],
				}),
			},
		});
		const form = contract.formCompositions.find(
			(composition) => composition.workflowId === workflow.id,
		);
		if (form?.layout.kind !== "sectioned") {
			throw new Error("Registration form fixture is incomplete.");
		}
		form.layout.sections[0]?.items.push({
			kind: "input",
			id: did(197),
			inputHandle: "existing_category",
			labelMarkdown: "Existing category",
		});
		contract.lookupTables.push({
			kind: "modify-existing",
			id: did(196),
			tableId: existing.tables[0].tableId,
			expectedTableRevision: "0" as never,
			purpose: "Apply an explicitly requested shared label correction.",
			authorization: {
				kind: "direct-user-request",
				sourceRefs: [messageRef()],
				impactSummary: "Rename the existing shared table.",
			},
			operations: [{ kind: "update-table", name: "Renamed" }],
		});
		const lineage = await seedAcceptedRevision(contract);

		await expect(materialize(lineage, contract)).rejects.toMatchObject({
			code: "conflict",
		});
		const catalog = await getAllLookupDefinitions(scope);
		expect(catalog.projectRevision).toBe("1");
		expect(catalog.definitions.map(({ tag }) => tag)).toEqual(["existing"]);
	});
});
