import { type Kysely, sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	buildCaseTypeMap,
	withProjectContext,
	withSchemaContext,
} from "@/lib/case-store";
import type { Database } from "@/lib/case-store/sql/database";
import { commitGuardedBatchProposal } from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";

const OWNER = "cleanup-owner";
const PROJECT = "cleanup-project";
const h = setupAppStateTestDb("property_removal_", { poolMax: 4 });

async function fixture() {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "item",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "unused", label: "Unused", data_type: "text" },
					{ name: "keep", label: "Keep", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Items",
				caseType: "item",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Add item",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "item", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	const appId = await h.seedAppWithBlueprint(doc, {
		owner: OWNER,
		projectId: PROJECT,
	});
	await (await withSchemaContext()).applySchemaChange({
		appId,
		caseType: "item",
		caseTypeSchemas: buildCaseTypeMap(doc),
		syncedSeq: 0,
	});
	const store = await withProjectContext(PROJECT, OWNER, OWNER);
	const db = h.db() as unknown as Kysely<Database>;
	const remove = (
		hooks: Parameters<typeof commitGuardedBatchProposal>[1] = {},
	) =>
		commitGuardedBatchProposal(
			{
				appId,
				expectedProjectId: PROJECT,
				actorUserId: OWNER,
				batchId: crypto.randomUUID(),
				kind: "autosave",
				mutations: [
					{ kind: "removeCaseProperty", caseType: "item", property: "unused" },
				],
			},
			hooks,
		);
	const insert = (properties: Record<string, string>) =>
		store.insert({
			appId,
			row: {
				case_id: "item-one",
				case_type: "item",
				case_name: "Item",
				status: "closed",
				properties,
			},
		});
	return { appId, db, remove, insert };
}

describe("unused property removal at the canonical transaction", () => {
	it("removes an empty definition and its storage contract while preserving other saved values", async () => {
		const x = await fixture();
		await x.insert({ keep: "Collected value" });
		const result = await x.remove();
		expect(
			result.committedDoc.caseTypes
				?.find((type) => type.name === "item")
				?.properties.map((property) => property.name),
		).not.toContain("unused");
		const schema = await x.db
			.selectFrom("case_type_schemas")
			.select("schema")
			.where("app_id", "=", x.appId)
			.where("case_type", "=", "item")
			.executeTakeFirstOrThrow();
		expect(schema.schema).not.toHaveProperty("properties.unused");
		expect(
			(
				await x.db
					.selectFrom("cases")
					.select("properties")
					.where("app_id", "=", x.appId)
					.executeTakeFirstOrThrow()
			).properties,
		).toEqual({ keep: "Collected value" });
	});

	it("rolls the storage contract back when a later canonical write fails", async () => {
		const x = await fixture();
		const before = await x.db
			.selectFrom("case_type_schemas")
			.selectAll()
			.where("app_id", "=", x.appId)
			.execute();
		await expect(
			x.remove({
				beforeWrite: async () => {
					throw new Error("Controlled later failure");
				},
			}),
		).rejects.toThrow("Controlled later failure");
		expect(
			await x.db
				.selectFrom("case_type_schemas")
				.selectAll()
				.where("app_id", "=", x.appId)
				.execute(),
		).toEqual(before);
		await x.insert({ unused: "Still accepted after rollback" });
	});

	it.each(["live", "parked"] as const)(
		"refuses %s values without changing the document, schema, history or records",
		async (carrier) => {
			const x = await fixture();
			await x.insert(
				carrier === "live"
					? { unused: "", keep: "Collected value" }
					: { keep: "Collected value" },
			);
			if (carrier === "parked")
				await x.db
					.insertInto("parked_case_values")
					.values({
						id: crypto.randomUUID(),
						app_id: x.appId,
						case_id: "item-one",
						case_type: "item",
						property: "unused",
						original_value: JSON.stringify("Prior value"),
						reason: "type conversion",
						from_type: "text",
						to_type: "int",
						dismissed_at: new Date(),
						created_at: new Date(),
					})
					.execute();
			const before = await x.db
				.selectFrom("case_type_schemas")
				.selectAll()
				.where("app_id", "=", x.appId)
				.execute();
			const appBefore = await h
				.db()
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", x.appId)
				.executeTakeFirstOrThrow();
			await expect(x.remove()).rejects.toThrow("saved or set-aside values");
			expect(
				await x.db
					.selectFrom("case_type_schemas")
					.selectAll()
					.where("app_id", "=", x.appId)
					.execute(),
			).toEqual(before);
			expect(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", x.appId)
					.executeTakeFirstOrThrow(),
			).toEqual(appBefore);
			expect(
				(
					await x.db
						.selectFrom("cases")
						.select("properties")
						.where("app_id", "=", x.appId)
						.executeTakeFirstOrThrow()
				).properties,
			).toEqual(
				carrier === "live"
					? { unused: "", keep: "Collected value" }
					: { keep: "Collected value" },
			);
		},
	);

	it("waits for an in-flight production writer and refuses its newly collected value", async () => {
		const x = await fixture();
		const gate = await h.pool().connect();
		let write: Promise<unknown> | undefined;
		let remove: Promise<unknown> | undefined;
		try {
			await gate.query("SELECT pg_advisory_lock(742310)");
			await sql`CREATE FUNCTION pause_property_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(742310); RETURN NEW; END $$`.execute(
				x.db,
			);
			await sql`CREATE TRIGGER pause_property_test_insert BEFORE INSERT ON cases FOR EACH ROW EXECUTE FUNCTION pause_property_test_insert()`.execute(
				x.db,
			);
			write = x.insert({ unused: "Concurrent value" });
			const observedWrite = write.then(
				() => ({ ok: true }),
				(error) => ({ error }),
			);
			await expect
				.poll(async () =>
					Number(
						(
							await gate.query(
								"SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 742310 AND NOT granted",
							)
						).rows[0]?.count,
					),
				)
				.toBe(1);
			remove = x.remove();
			const observedRemoval = remove.then(
				() => ({ ok: true }),
				(error: Error) => ({ error: error.message }),
			);
			await expect
				.poll(async () =>
					Number(
						(
							await gate.query(
								"SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted",
							)
						).rows[0]?.count,
					),
				)
				.toBeGreaterThanOrEqual(2);
			await gate.query("SELECT pg_advisory_unlock(742310)");
			expect(await observedWrite).toEqual({ ok: true });
			expect(await observedRemoval).toEqual({
				error: expect.stringContaining("saved or set-aside values"),
			});
			expect(
				(
					await x.db
						.selectFrom("cases")
						.select("properties")
						.where("app_id", "=", x.appId)
						.executeTakeFirstOrThrow()
				).properties,
			).toEqual({ unused: "Concurrent value" });
		} finally {
			await gate.query("SELECT pg_advisory_unlock(742310)");
			await Promise.allSettled(
				[write, remove].filter((promise) => promise !== undefined),
			);
			gate.release();
		}
	});
});
