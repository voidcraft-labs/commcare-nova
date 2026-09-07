import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { caseTypeSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { CasePropertiesValidationError } from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const handle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "finite_props_",
});
const APP = "finite-properties";

async function initializedStore() {
	await handle.pool.query(
		"INSERT INTO apps (id, owner, project_id, app_name, app_name_lower) VALUES ($1, 'owner-a', 'owner-a', 'Finite properties', 'finite properties')",
		[APP],
	);
	const store = new PostgresCaseStore({
		projectId: "owner-a",
		actorUserId: "owner-a",
		ownerId: "owner-a",
		db: handle.db as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
	const caseType = caseTypeSchema.parse({
		name: "reading",
		properties: [
			{ name: "value", label: proseText("Value"), data_type: "decimal" },
		],
	});
	await store.applySchemaChange({
		appId: APP,
		caseType: "reading",
		caseTypeSchemas: new Map([[caseType.name, caseType]]),
	});
	return store;
}

async function rows() {
	return (
		await handle.pool.query(
			"SELECT case_id, case_name, properties, modified_on FROM cases WHERE app_id = $1 ORDER BY case_id",
			[APP],
		)
	).rows;
}

describe("PostgresCaseStore finite property admission", () => {
	it.each([Number.NaN, Infinity, -Infinity])(
		"rejects insert of %s before it can serialize to null",
		async (value) => {
			const store = await initializedStore();
			await store.insert({
				appId: APP,
				row: {
					case_id: "existing",
					case_type: "reading",
					case_name: "Existing",
					properties: { value: 1.5 },
				},
			});
			const before = await rows();
			await expect(
				store.insert({
					appId: APP,
					row: {
						case_id: "invalid",
						case_type: "reading",
						case_name: "Invalid",
						properties: { value },
					},
				}),
			).rejects.toBeInstanceOf(CasePropertiesValidationError);
			expect(await rows()).toEqual(before);
		},
	);
	it.each([Number.NaN, Infinity, -Infinity])(
		"rejects update of %s and preserves the complete prior row",
		async (value) => {
			const store = await initializedStore();
			await store.insert({
				appId: APP,
				row: {
					case_id: "existing",
					case_type: "reading",
					case_name: "Existing",
					properties: { value: 1.5 },
				},
			});
			const before = await rows();
			await expect(
				store.update({
					appId: APP,
					caseId: "existing",
					patch: { case_name: "Should not commit", properties: { value } },
				}),
			).rejects.toBeInstanceOf(CasePropertiesValidationError);
			expect(await rows()).toEqual(before);
		},
	);
	it.each(["1e400", "-1e400"])(
		"rejects overflowing JSON number %s at both write boundaries",
		async (token) => {
			const store = await initializedStore();
			await store.insert({
				appId: APP,
				row: {
					case_id: "existing",
					case_type: "reading",
					case_name: "Existing",
					properties: { value: 1.5 },
				},
			});
			const before = await rows();
			const properties = `{"value":${token}}`;
			await expect(
				store.insert({
					appId: APP,
					row: {
						case_id: "invalid",
						case_type: "reading",
						case_name: "Invalid",
						properties,
					},
				}),
			).rejects.toBeInstanceOf(CasePropertiesValidationError);
			await expect(
				store.update({ appId: APP, caseId: "existing", patch: { properties } }),
			).rejects.toBeInstanceOf(CasePropertiesValidationError);
			expect(await rows()).toEqual(before);
		},
	);
	it("retains finite numbers through object and JSON input, insert and update", async () => {
		const store = await initializedStore();
		for (const [index, value] of [0, -1.5, Number.MAX_VALUE].entries()) {
			const caseId = `finite-${index}`;
			await store.insert({
				appId: APP,
				row: {
					case_id: caseId,
					case_type: "reading",
					case_name: "Finite",
					properties: { value },
				},
			});
			await store.update({
				appId: APP,
				caseId,
				patch: { properties: JSON.stringify({ value: value / 2 }) },
			});
		}
		expect((await rows()).map((row) => row.properties)).toEqual([
			{ value: 0 },
			{ value: -0.75 },
			{ value: Number.MAX_VALUE / 2 },
		]);
	});
});
