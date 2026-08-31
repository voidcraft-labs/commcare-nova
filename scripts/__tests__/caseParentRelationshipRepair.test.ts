import type { Transaction } from "kysely";
import { describe } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	expect,
	makeCaseRow,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import type { AppDatabase } from "@/lib/db/pg";
import type { PersistableDoc } from "@/lib/domain";
import {
	classifyCaseParentRelationshipsInSnapshot,
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
		createdChildren?: readonly {
			readonly authoredChildIndex: number;
			readonly parentCaseId: string;
			readonly caseId: string;
		}[];
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
				...(args.createdChildren === undefined
					? { childCaseIds: args.childCaseIds ?? [] }
					: { createdChildren: args.createdChildren }),
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
					target_case_type: "test",
					identifier: "parent",
					relationship: caseId === CLEAN_ID ? "extension" : "child",
					depth: 1,
				})),
			)
			.execute();
		await seedReceipt(db, {
			entryKey: "ordinary-repairable",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			createdChildren: [
				{
					authoredChildIndex: 0,
					parentCaseId: PARENT_ID,
					caseId: REPAIRABLE_ID,
				},
			],
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

	test("loads Project placement from the classification snapshot instead of stale enumeration", async ({
		db,
	}) => {
		await db
			.updateTable("apps")
			.set({ case_types: JSON.stringify(blueprint.caseTypes) })
			.where("id", "=", APP_ID)
			.executeTakeFirstOrThrow();
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({ case_id: PARENT_ID, case_type: "household" }),
				makeCaseRow({
					case_id: REPAIRABLE_ID,
					case_type: "visit",
					parent_case_id: PARENT_ID,
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: REPAIRABLE_ID,
				ancestor_id: PARENT_ID,
				target_case_type: "test",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();
		await seedReceipt(db, {
			entryKey: "ordinary-after-project-move",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			childCaseIds: [REPAIRABLE_ID],
		});

		// This is the false-clean result the pre-snapshot enumerated Project
		// produced after an app move committed before classification began.
		expect(
			await findCaseParentRelationshipFindings(db, {
				appId: APP_ID,
				projectId: "project-before-move",
				blueprint,
			}),
		).toEqual([]);

		const snapshot = await classifyCaseParentRelationshipsInSnapshot(
			db as unknown as Transaction<AppDatabase>,
			APP_ID,
		);
		expect(snapshot).toEqual({
			appId: APP_ID,
			appName: APP_ID,
			projectId: PROJECT_ID,
			findings: [
				expect.objectContaining({
					caseId: REPAIRABLE_ID,
					standing: "repairable-ordinary",
				}),
			],
		});
	});

	test("refuses a receipt-proven row after a historical whole-catalog replacement", async ({
		db,
		pgClient,
	}) => {
		const historicalCatalogId = "historical-catalog-extension";
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({ case_id: PARENT_ID, case_type: "household" }),
				makeCaseRow({
					case_id: historicalCatalogId,
					case_type: "visit",
					parent_case_id: PARENT_ID,
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: historicalCatalogId,
				ancestor_id: PARENT_ID,
				target_case_type: "test",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();
		await seedReceipt(db, {
			entryKey: "ordinary-before-legacy-catalog",
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			childCaseIds: [historicalCatalogId],
		});

		// The fixture's app genesis is sequence 1, which is the exact sequence
		// recorded by the completed receipt above. Insert the historical mutation
		// shape directly into the real permanent log at N + 1: it is intentionally
		// absent from the current Mutation type but remains valid stored history.
		await pgClient.query(
			`
				INSERT INTO app_changes (
					app_id,
					seq,
					batch_id,
					run_id,
					actor_id,
					kind,
					mutations,
					from_project_id,
					to_project_id,
					ts
				)
				VALUES ($1, 2, $2, NULL, $3, 'autosave', $4::jsonb, NULL, NULL, $5)
			`,
			[
				APP_ID,
				"historical-set-case-types",
				"historical-editor",
				JSON.stringify([
					{
						kind: "setCaseTypes",
						caseTypes: blueprint.caseTypes,
					},
				]),
				new Date("2026-08-01T00:00:01.000Z"),
			],
		);

		const findings = await findCaseParentRelationshipFindings(db, {
			appId: APP_ID,
			projectId: PROJECT_ID,
			blueprint,
		});
		expect(findings).toEqual([
			expect.objectContaining({
				caseId: historicalCatalogId,
				standing: "catalog-changed",
			}),
		]);

		const candidates = findings.filter(
			(finding) => finding.standing === "repairable-ordinary",
		);
		expect(
			await repairCaseParentRelationships(db, {
				appId: APP_ID,
				projectId: PROJECT_ID,
				caseType: "visit",
				parentType: "household",
				caseIds: candidates.map((candidate) => candidate.caseId),
			}),
		).toEqual([]);
		expect(
			await db
				.selectFrom("case_indices")
				.select("relationship")
				.where("case_id", "=", historicalCatalogId)
				.executeTakeFirstOrThrow(),
		).toEqual({ relationship: "child" });
	});

	test("uses one text-array bind for candidate lists beyond PostgreSQL's parameter ceiling", async ({
		db,
	}) => {
		const candidateId = "large-list-extension";
		await db
			.insertInto("cases")
			.values([
				makeCaseRow({ case_id: PARENT_ID, case_type: "household" }),
				makeCaseRow({
					case_id: candidateId,
					case_type: "visit",
					parent_case_id: PARENT_ID,
				}),
			])
			.execute();
		await db
			.insertInto("case_indices")
			.values({
				case_id: candidateId,
				ancestor_id: PARENT_ID,
				target_case_type: "test",
				identifier: "parent",
				relationship: "child",
				depth: 1,
			})
			.execute();

		const moreThanProtocolAllows = Array.from(
			{ length: 70_000 },
			(_, index) => `not-present-${index}`,
		);
		expect(
			await repairCaseParentRelationships(db, {
				appId: APP_ID,
				projectId: PROJECT_ID,
				caseType: "visit",
				parentType: "household",
				caseIds: [candidateId, ...moreThanProtocolAllows],
			}),
		).toEqual([candidateId]);
	});
});
