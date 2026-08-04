import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { and, eq, isIn, literal, prop } from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { runCaseStoreMigrations } from "../../migrate";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const APP_ID = "automation-matching";
const PROJECT_ID = "project-automation";
const OTHER_PROJECT = "project-other";
const PARENT_ID = "01890f45-0000-7000-8000-000000000101";

const h = setupPerTestDatabase({ databaseNamePrefix: "automation_match_" });

const schemas = new Map<string, CaseType>([
	[
		"household",
		{
			name: "household",
			properties: [],
		},
	],
	[
		"visit",
		{
			name: "visit",
			properties: [
				{
					name: "code",
					label: proseText("Code"),
					data_type: "text",
				},
			],
		},
	],
]);

beforeEach(async () => {
	await runCaseStoreMigrations(h.db);
	await h.pool.query(
		`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		 VALUES
		 ($1, 'member', $2, 'Automations', 'automations'),
		 ('automation-foreign', 'other', $3, 'Foreign', 'foreign')`,
		[APP_ID, PROJECT_ID, OTHER_PROJECT],
	);
	await h.pool.query(
		`INSERT INTO cases
		 (case_id, app_id, project_id, owner_id, case_type, case_name,
		  status, closed_on, properties)
		 VALUES
		 ($1, $2, $3, 'facility-a', 'household', 'Closed parent',
		  'closed', now(), '{}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000102', $2, $3, 'facility-a',
		  'visit', 'Matches everything', 'open', null,
		  '{"code":"ABC-123"}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000103', $2, $3, 'facility-a',
		  'visit', 'Regex is not anchored', 'open', null,
		  '{"code":"XABC-123"}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000104', $2, $3, 'facility-a',
		  'visit', 'Closed child', 'closed', now(),
		  '{"code":"ABC-999"}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000106', $2, $3, 'facility-a',
		  'visit', 'Whitespace code', 'open', null,
		  '{"code":" \\t\\n"}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000107', $2, $3, 'facility-a',
		  'visit', 'Numeric code', 'open', null,
		  '{"code":123}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000105', 'automation-foreign', $4,
		  'facility-a', 'visit', 'Other tenant', 'open', null,
		  '{"code":"ABC-777"}'::jsonb)`,
		[PARENT_ID, APP_ID, PROJECT_ID, OTHER_PROJECT],
	);
	await h.pool.query(
		`INSERT INTO case_indices
		 (case_id, identifier, relationship, ancestor_id, depth)
		 VALUES
		 ('01890f45-0000-7000-8000-000000000102', 'parent', 'child', $1, 1),
		 ('01890f45-0000-7000-8000-000000000103', 'parent', 'child', $1, 1),
		 ('01890f45-0000-7000-8000-000000000104', 'parent', 'child', $1, 1)`,
		[PARENT_ID],
	);
});

function store() {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "member",
		ownerId: "member",
		db: h.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

describe("automation criteria SQL", () => {
	it("composes ALL/ANY, Python-style anchored regex, closed parent, status, and tenancy in one count", async () => {
		const caseStore = store();
		const openAtFacility = and(
			eq(prop("visit", "status"), literal("open")),
			isIn(prop("visit", "owner_id"), literal("facility-a")),
		);

		await expect(
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: openAtFacility,
				automationCriteria: {
					operator: "all" as const,
					regexes: [{ property: "code", pattern: "ABC-[0-9]+" }],
					blankness: [],
					closedParents: [
						{
							identifier: "parent",
							relationship: "child",
						},
					],
				},
			}),
		).resolves.toBe(1);

		await expect(
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					operator: "any",
					regexes: [{ property: "code", pattern: "never" }],
					blankness: [],
					closedParents: [
						{
							identifier: "parent",
							relationship: "child",
						},
					],
				},
			}),
		).resolves.toBe(2);
	});

	it("matches HQ whitespace blankness and runs regex only on strings", async () => {
		const caseStore = store();
		const base = {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas,
			predicate: eq(prop("visit", "status"), literal("open")),
		} as const;

		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					regexes: [],
					blankness: [{ property: "code", hasValue: false }],
					closedParents: [],
				},
			}),
		).resolves.toBe(1);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					regexes: [],
					blankness: [{ property: "code", hasValue: true }],
					closedParents: [],
				},
			}),
		).resolves.toBe(3);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					regexes: [{ property: "code", pattern: "[0-9]+" }],
					blankness: [],
					closedParents: [],
				},
			}),
		).resolves.toBe(0);
	});
});
