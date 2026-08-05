import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	expect,
	makeCaseRow,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import type { PersistableDoc } from "@/lib/domain";
import {
	findCaseParentRelationshipFindings,
	repairCaseParentRelationships,
} from "../lib/caseParentRelationshipRepair";

const APP_ID = "app-test";
const PROJECT_ID = "project-test";
const PARENT_ID = "parent-case";
const CLEAN_ID = "clean-extension";
const REPAIRABLE_ID = "repairable-extension";
const UNKNOWN_ID = "unknown-extension";
const TOUCHED_ID = "operation-touched-extension";

const blueprint: PersistableDoc = {
	appId: APP_ID,
	appName: "Relationship repair",
	connectType: null,
	caseTypes: [
		{ name: "household", properties: [] },
		{
			name: "visit",
			parent_type: "household",
			relationship: "extension",
			properties: [],
		},
	],
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
};

async function seedReceipt(
	db: DatabaseFixture,
	args: {
		entryKey: string;
		createdAt: Date;
		childCaseIds?: readonly string[];
		operationCaseId?: string;
	},
): Promise<void> {
	await db
		.insertInto("form_submission_intents")
		.values({
			app_id: APP_ID,
			project_id: PROJECT_ID,
			created_by: "owner-test",
			entry_key: args.entryKey,
			form_uuid: testUuid("case-parent-repair-form"),
			app_mutation_seq: 1,
			request_digest: `digest-${args.entryKey}`,
			result: JSON.stringify({
				childCaseIds: args.childCaseIds ?? [],
				operations:
					args.operationCaseId === undefined
						? []
						: [
								{
									operationUuid: "00000000-0000-4000-8000-000000000002",
									iteration: 0,
									action: "update",
									caseId: args.operationCaseId,
									executed: true,
								},
							],
			}),
			created_at: args.createdAt,
		})
		.execute();
}

type DatabaseFixture = Parameters<typeof findCaseParentRelationshipFindings>[0];

describe("case parent relationship scan-then-migrate", () => {
	test("repairs only receipt-proven ordinary extension edges", async ({
		db,
	}) => {
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({
					case_id: PARENT_ID,
					case_type: "household",
				}),
				...[CLEAN_ID, REPAIRABLE_ID, UNKNOWN_ID, TOUCHED_ID].map((caseId) =>
					makeCaseRow({
						case_id: caseId,
						case_type: "visit",
						parent_case_id: PARENT_ID,
					}),
				),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values(
				[CLEAN_ID, REPAIRABLE_ID, UNKNOWN_ID, TOUCHED_ID].map((caseId) => ({
					case_id: caseId,
					ancestor_id: PARENT_ID,
					identifier: "parent",
					relationship: caseId === CLEAN_ID ? "extension" : "child",
					depth: 1,
				})),
			)
			.execute();
		await seedReceipt(db, {
			entryKey: "ordinary-repairable",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			childCaseIds: [REPAIRABLE_ID],
		});
		await seedReceipt(db, {
			entryKey: "ordinary-touched",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			childCaseIds: [TOUCHED_ID],
		});
		await seedReceipt(db, {
			entryKey: "same-timestamp-operation",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			operationCaseId: TOUCHED_ID,
		});

		const findings = await findCaseParentRelationshipFindings(db, {
			appId: APP_ID,
			projectId: PROJECT_ID,
			blueprint,
		});
		expect(
			Object.fromEntries(
				findings.map((finding) => [finding.caseId, finding.standing]),
			),
		).toEqual({
			[CLEAN_ID]: "clean",
			[REPAIRABLE_ID]: "repairable-ordinary",
			[TOUCHED_ID]: "operation-touched",
			[UNKNOWN_ID]: "unknown-origin",
		});

		expect(
			await repairCaseParentRelationships(db, {
				appId: APP_ID,
				projectId: PROJECT_ID,
				caseType: "visit",
				parentType: "household",
				caseIds: [REPAIRABLE_ID],
			}),
		).toEqual([REPAIRABLE_ID]);
		expect(
			await repairCaseParentRelationships(db, {
				appId: APP_ID,
				projectId: PROJECT_ID,
				caseType: "visit",
				parentType: "household",
				caseIds: [REPAIRABLE_ID],
			}),
		).toEqual([]);
		const relationships = await db
			.selectFrom("case_indices")
			.select(["case_id", "relationship"])
			.where("case_id", "in", [REPAIRABLE_ID, UNKNOWN_ID, TOUCHED_ID])
			.orderBy("case_id")
			.execute();
		expect(relationships).toEqual([
			{ case_id: TOUCHED_ID, relationship: "child" },
			{ case_id: REPAIRABLE_ID, relationship: "extension" },
			{ case_id: UNKNOWN_ID, relationship: "child" },
		]);
	});
});
