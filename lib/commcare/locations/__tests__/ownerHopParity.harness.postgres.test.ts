import { describe, expect, it } from "vitest";
import { compileTerm } from "@/lib/case-store/sql/compileTerm";
import type { Database } from "@/lib/case-store/sql/database";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { createLocation, readOrganization } from "@/lib/organization/service";
import { LOCATION_LEVELS, locationOwnerFixture } from "./locationOwnerFixture";

const h = setupAppStateTestDb("location_owner_native_", {
	authSchema: "migrated",
	poolMax: 2,
});
const scope = {
	appId: "location-owner-app",
	projectId: "location-owner-project",
	actorUserId: "location-owner-actor",
	role: "owner",
};
const input = { externalId: null, latitude: null, longitude: null, values: {} };

describe("owner SQL over service-admitted organization rows", () => {
	it.each(["direct", "multirung"] as const)(
		"%s resolves the expected branch and refuses an ambiguous write",
		async (scenario) => {
			const doc = locationOwnerFixture(scenario);
			await h.seedAppWithBlueprint(doc, {
				id: scope.appId,
				owner: scope.actorUserId,
				projectId: scope.projectId,
			});
			async function branch(name: string) {
				const result = await createLocation(scope, {
					...input,
					levelUuid: LOCATION_LEVELS[0].uuid,
					parentId: null,
					name,
					descendants: [
						{
							...input,
							levelUuid: LOCATION_LEVELS[1].uuid,
							name: `${name} district`,
							descendants: [
								{
									...input,
									levelUuid: LOCATION_LEVELS[2].uuid,
									name: `${name} clinic`,
								},
							],
						},
					],
				});
				return {
					region: result.location.id,
					district: result.descendants[0].locationUuid,
					clinic: result.descendants[0].descendants[0].locationUuid,
				};
			}
			const first = await branch("North"),
				second = await branch("South");
			const db = h
				.db()
				.withTables<{ [Table in keyof Database]: Database[Table] }>();
			await db
				.insertInto("cases")
				.values({
					case_id: "patient-1",
					app_id: scope.appId,
					project_id: scope.projectId,
					case_type: "patient",
					owner_id: first.region,
					status: "open",
					case_name: "Patient",
					properties: JSON.stringify({}),
					opened_on: new Date(),
					modified_on: new Date(),
					closed_on: null,
				})
				.execute();
			const expression = compileTerm(
				{
					kind: "owner-location-at-level",
					levelUuid: LOCATION_LEVELS[2].uuid,
					ownerCaseType: "patient",
				},
				{
					db,
					appId: scope.appId,
					projectId: scope.projectId,
					anchorAlias: "c",
					currentCaseType: "patient",
					caseTypeSchemas: new Map(
						(doc.caseTypes ?? []).map((caseType) => [caseType.name, caseType]),
					),
					organizationLevels: doc.organizationLevels,
					bindings: {},
				},
			);
			for (const row of [first, second]) {
				await db
					.updateTable("cases")
					.set({ owner_id: scenario === "direct" ? row.district : row.region })
					.where("case_id", "=", "patient-1")
					.execute();
				const result = await db
					.selectFrom("cases as c")
					.select(expression.as("destination"))
					.where("c.case_id", "=", "patient-1")
					.executeTakeFirstOrThrow();
				expect(result.destination).toBe(row.clinic);
			}
			await db
				.updateTable("cases")
				.set({ owner_id: "unassigned-worker" })
				.where("case_id", "=", "patient-1")
				.execute();
			expect(
				(
					await db
						.selectFrom("cases as c")
						.select(expression.as("destination"))
						.where("c.case_id", "=", "patient-1")
						.executeTakeFirstOrThrow()
				).destination,
			).toBeNull();
			const before = await readOrganization(scope);
			await expect(
				createLocation(scope, {
					...input,
					levelUuid: LOCATION_LEVELS[2].uuid,
					parentId: first.district,
					name: "Ambiguous clinic",
				}),
			).rejects.toThrow(BlueprintCommitRejectedError);
			expect(await readOrganization(scope)).toEqual(before);
		},
	);
});
