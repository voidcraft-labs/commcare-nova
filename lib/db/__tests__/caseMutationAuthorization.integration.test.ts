/** Actor case writes reauthorize against fresh app + membership state. */

import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database as CaseDatabase } from "@/lib/case-store/sql/database";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { authorizeCaseMutationInTransaction } from "../caseMutationAuthorization";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("case_mutation_auth_");

const USER = "case-writer";
const PROJECT = "case-project";
const OTHER_PROJECT = "case-project-other";
const CASE_TYPE = "patient";

function caseDb(): Kysely<CaseDatabase> {
	return h.db() as unknown as Kysely<CaseDatabase>;
}

function store(projectId = PROJECT): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId,
		actorUserId: USER,
		db: caseDb(),
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeMutation: authorizeCaseMutationInTransaction,
	});
}

async function seedAuthorizedApp(): Promise<string> {
	const appId = `case-app-${crypto.randomUUID()}`;
	await h.seedApp({ id: appId, owner: USER, project_id: PROJECT });
	await h.seedProjectMember(USER, PROJECT, "editor");
	await caseDb()
		.insertInto("case_type_schemas")
		.values({
			app_id: appId,
			case_type: CASE_TYPE,
			schema: JSON.stringify(
				caseTypeToJsonSchema({
					name: CASE_TYPE,
					properties: [{ name: "name", label: "Name", data_type: "text" }],
				}),
			),
		})
		.execute();
	return appId;
}

async function insertPatient(appId: string): Promise<string> {
	const result = await store().insert({
		appId,
		row: {
			case_type: CASE_TYPE,
			case_name: "Ada",
			status: "open",
			properties: { name: "Ada" },
		},
	});
	return result.caseId;
}

describe("case mutation authorization", () => {
	it("rejects a stale store binding after the app changes Projects", async () => {
		const appId = await seedAuthorizedApp();
		const caseId = await insertPatient(appId);
		await h.seedProjectMember(USER, OTHER_PROJECT, "editor");
		await h
			.db()
			.updateTable("apps")
			.set({ project_id: OTHER_PROJECT })
			.where("id", "=", appId)
			.execute();

		await expect(store().close({ appId, caseId })).rejects.toMatchObject({
			name: "AppAccessError",
			reason: "not_found",
		});
		const row = await caseDb()
			.selectFrom("cases")
			.select(["status", "project_id"])
			.where("case_id", "=", caseId)
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ status: "open", project_id: PROJECT });
	});

	it("rejects every write after the actor loses edit capability", async () => {
		const appId = await seedAuthorizedApp();
		await h.seedProjectMember(USER, PROJECT, "viewer");

		await expect(
			store().insert({
				appId,
				row: {
					case_type: CASE_TYPE,
					case_name: "Denied",
					status: "open",
					properties: { name: "Denied" },
				},
			}),
		).rejects.toMatchObject({
			name: "AppAccessError",
			reason: "insufficient_role",
		});
		const count = await caseDb()
			.selectFrom("cases")
			.select((eb) => eb.fn.countAll<string>().as("total"))
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow();
		expect(Number(count.total)).toBe(0);
	});

	it("replaces a parked value and archives it atomically", async () => {
		const appId = await seedAuthorizedApp();
		const caseId = await insertPatient(appId);
		const parked = await caseDb()
			.insertInto("parked_case_values")
			.values({
				app_id: appId,
				case_id: caseId,
				case_type: CASE_TYPE,
				property: "name",
				original_value: JSON.stringify("Old Ada"),
				reason: "test",
				from_type: "text",
				to_type: "text",
			})
			.returning("id")
			.executeTakeFirstOrThrow();

		await expect(
			store().replaceParkedValue({ appId, id: parked.id, value: 42 }),
		).rejects.toMatchObject({ name: "CasePropertiesValidationError" });
		let entry = await caseDb()
			.selectFrom("parked_case_values")
			.select("dismissed_at")
			.where("id", "=", parked.id)
			.executeTakeFirstOrThrow();
		expect(entry.dismissed_at).toBeNull();

		await store().replaceParkedValue({
			appId,
			id: parked.id,
			value: "New Ada",
		});
		entry = await caseDb()
			.selectFrom("parked_case_values")
			.select("dismissed_at")
			.where("id", "=", parked.id)
			.executeTakeFirstOrThrow();
		const row = await caseDb()
			.selectFrom("cases")
			.select("properties")
			.where("case_id", "=", caseId)
			.executeTakeFirstOrThrow();
		expect(entry.dismissed_at).not.toBeNull();
		expect(row.properties).toEqual({ name: "New Ada" });
	});
});
