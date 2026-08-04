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
const CUSTOM_HOST_ID = "01890f45-0000-7000-8000-000000000120";
const CANONICAL_EXTENSION_ID = "01890f45-0000-7000-8000-000000000121";
const CUSTOM_EXTENSION_ID = "01890f45-0000-7000-8000-000000000122";
const MULTI_EXTENSION_ID = "01890f45-0000-7000-8000-000000000123";

const h = setupPerTestDatabase({ databaseNamePrefix: "automation_match_" });

const schemas = new Map<string, CaseType>([
	[
		"household",
		{
			name: "household",
			properties: [
				{
					name: "marker",
					label: proseText("Marker"),
					data_type: "text",
				},
			],
		},
	],
	[
		"visit",
		{
			name: "visit",
			parent_type: "household",
			relationship: "child",
			properties: [
				{
					name: "code",
					label: proseText("Code"),
					data_type: "text",
				},
				{
					name: "active_flag",
					label: proseText("Active flag"),
					data_type: "text",
				},
				{
					name: "attempts",
					label: proseText("Attempts"),
					data_type: "int",
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
		  'closed', now(), '{"marker":"present"}'::jsonb),
		 ('01890f45-0000-7000-8000-000000000102', $2, $3, 'facility-a',
		  'visit', 'Matches everything', 'open', null,
		  '{"code":"ABC-123","attempts":5,"active_flag":true}'::jsonb),
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
		 ('01890f45-0000-7000-8000-000000000104', 'parent', 'child', $1, 1),
		 ('01890f45-0000-7000-8000-000000000107', 'host', 'extension', $1, 1)`,
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

async function insertExtensionFixtures(): Promise<void> {
	await h.pool.query(
		`INSERT INTO cases
		 (case_id, app_id, project_id, owner_id, case_type, case_name,
		  status, closed_on, parent_case_id, properties)
		 VALUES
		 ($1, $2, $3, 'facility-a', 'household', 'Custom host',
		  'open', null, null, '{"marker":"custom"}'::jsonb),
		 ($4, $2, $3, 'facility-a', 'visit', 'Canonical extension',
		  'open', null, $5, '{"code":"canonical"}'::jsonb),
		 ($6, $2, $3, 'facility-a', 'visit', 'Custom extension',
		  'open', null, null, '{"code":"custom"}'::jsonb),
		 ($7, $2, $3, 'facility-a', 'visit', 'Multiple extensions',
		  'open', null, $5, '{"code":"multiple"}'::jsonb)`,
		[
			CUSTOM_HOST_ID,
			APP_ID,
			PROJECT_ID,
			CANONICAL_EXTENSION_ID,
			PARENT_ID,
			CUSTOM_EXTENSION_ID,
			MULTI_EXTENSION_ID,
		],
	);
	await h.pool.query(
		`INSERT INTO case_indices
		 (case_id, identifier, relationship, ancestor_id, depth)
		 VALUES
		 ($1, 'parent', 'extension', $2, 1),
		 ($3, 'facility_host', 'extension', $4, 1),
		 ($5, 'parent', 'extension', $2, 1),
		 ($5, 'aaa_custom_host', 'extension', $4, 1)`,
		[
			CANONICAL_EXTENSION_ID,
			PARENT_ID,
			CUSTOM_EXTENSION_ID,
			CUSTOM_HOST_ID,
			MULTI_EXTENSION_ID,
		],
	);
}

describe("automation criteria SQL", () => {
	it("preserves HQ's all/any identity for an empty criteria group", async () => {
		const caseStore = store();
		const count = (operator: "all" | "any") =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					operator,
					comparisons: [],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		await expect(count("all")).resolves.toBe(4);
		await expect(count("any")).resolves.toBe(0);
	});

	it("matches each location criterion as one exact owner-identity set", async () => {
		const caseStore = store();
		const count = (locationOwnerSets: readonly (readonly string[])[]) =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					operator: "all",
					comparisons: [],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets,
				},
			});

		await expect(count([["facility-a"]])).resolves.toBe(4);
		await expect(count([["facility-a", "another-owner"]])).resolves.toBe(4);
		await expect(count([["another-owner"]])).resolves.toBe(0);
		await expect(count([[]])).resolves.toBe(0);
	});

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
					comparisons: [],
					regexes: [{ property: "code", pattern: "ABC-[0-9]+" }],
					blankness: [],
					closedParents: [
						{
							identifier: "parent",
							relationship: "child",
						},
					],
					locationOwnerSets: [],
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
					comparisons: [],
					regexes: [{ property: "code", pattern: "never" }],
					blankness: [],
					closedParents: [
						{
							identifier: "parent",
							relationship: "child",
						},
					],
					locationOwnerSets: [],
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
					comparisons: [],
					regexes: [],
					blankness: [
						{ property: "code", hasValue: false, scope: "case" as const },
					],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(1);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					comparisons: [],
					regexes: [],
					blankness: [
						{ property: "code", hasValue: true, scope: "case" as const },
					],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(3);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					comparisons: [],
					regexes: [{ property: "code", pattern: "[0-9]+" }],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(0);
	});

	it("matches parent and host blankness with HQ missing-relation semantics", async () => {
		await insertExtensionFixtures();
		const caseStore = store();
		const base = {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas,
			predicate: eq(prop("visit", "status"), literal("open")),
		} as const;
		const count = (scope: "parent" | "host", hasValue: boolean) =>
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					comparisons: [],
					regexes: [],
					blankness: [{ property: "marker", hasValue, scope }],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		await expect(count("parent", true)).resolves.toBe(4);
		await expect(count("parent", false)).resolves.toBe(3);
		await expect(count("host", true)).resolves.toBe(4);
		await expect(count("host", false)).resolves.toBe(3);
	});

	it("compares only stored strings without coercion and requires a related case", async () => {
		await insertExtensionFixtures();
		const caseStore = store();
		const base = {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas,
			predicate: eq(prop("visit", "status"), literal("open")),
		} as const;
		const count = (comparison: {
			property: string;
			value: string;
			equal: boolean;
			scope: "case" | "parent" | "host";
		}) =>
			caseStore.count({
				...base,
				automationCriteria: {
					operator: "all" as const,
					comparisons: [comparison],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		await expect(
			count({ property: "attempts", value: "5", equal: true, scope: "case" }),
		).resolves.toBe(0);
		await expect(
			count({ property: "code", value: "ABC-123", equal: true, scope: "case" }),
		).resolves.toBe(1);
		await expect(
			count({ property: "code", value: "123", equal: true, scope: "case" }),
		).resolves.toBe(0);
		await expect(
			count({
				property: "active_flag",
				value: "true",
				equal: true,
				scope: "case",
			}),
		).resolves.toBe(0);
		await expect(
			count({
				property: "attempts",
				value: "5",
				equal: false,
				scope: "case",
			}),
		).resolves.toBe(7);
		await expect(
			count({
				property: "active_flag",
				value: "true",
				equal: false,
				scope: "case",
			}),
		).resolves.toBe(7);
		await expect(
			count({ property: "attempts", value: "05", equal: true, scope: "case" }),
		).resolves.toBe(0);
		await expect(
			count({
				property: "attempts",
				value: "not-an-integer",
				equal: true,
				scope: "case",
			}),
		).resolves.toBe(0);
		await expect(
			count({
				property: "marker",
				value: "other",
				equal: false,
				scope: "parent",
			}),
		).resolves.toBe(4);
		await expect(
			count({
				property: "marker",
				value: "present",
				equal: false,
				scope: "parent",
			}),
		).resolves.toBe(0);
		await expect(
			count({
				property: "marker",
				value: "other",
				equal: false,
				scope: "host",
			}),
		).resolves.toBe(4);
		await expect(
			count({
				property: "marker",
				value: "present",
				equal: true,
				scope: "parent",
			}),
		).resolves.toBe(4);
		await expect(
			count({
				property: "marker",
				value: "present",
				equal: true,
				scope: "host",
			}),
		).resolves.toBe(3);
		await expect(
			count({
				property: "marker",
				value: "custom",
				equal: true,
				scope: "host",
			}),
		).resolves.toBe(1);
	});
});
