import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { and, eq, isIn, literal, prop } from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import type { AutomationHostAmbiguityError } from "../../errors";
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
const CHILD_IDENTIFIER_HOST_ID = "01890f45-0000-7000-8000-000000000124";
const PYTHON_STRIP_WHITESPACE_FIXTURE = String.fromCodePoint(
	0x0009,
	0x000a,
	0x000b,
	0x000c,
	0x000d,
	0x001c,
	0x001d,
	0x001e,
	0x001f,
	0x0020,
	0x0085,
	0x00a0,
	0x1680,
	0x2000,
	0x2001,
	0x2002,
	0x2003,
	0x2004,
	0x2005,
	0x2006,
	0x2007,
	0x2008,
	0x2009,
	0x200a,
	0x2028,
	0x2029,
	0x202f,
	0x205f,
	0x3000,
);

const h = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "automation_match_",
});

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
				{
					name: "due_at",
					label: proseText("Due at"),
					data_type: "datetime",
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
				{
					name: "due_at",
					label: proseText("Due at"),
					data_type: "datetime",
				},
			],
		},
	],
]);

beforeEach(async () => {
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
		 (case_id, identifier, relationship, ancestor_id, target_case_type, depth)
		 VALUES
		 ('01890f45-0000-7000-8000-000000000102', 'parent', 'child', $1, 'household', 1),
		 ('01890f45-0000-7000-8000-000000000103', 'parent', 'child', $1, 'household', 1),
		 ('01890f45-0000-7000-8000-000000000104', 'parent', 'child', $1, 'household', 1),
		 ('01890f45-0000-7000-8000-000000000107', 'host', 'extension', $1, 'household', 1)`,
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
		 (case_id, identifier, relationship, ancestor_id, target_case_type, depth)
		 VALUES
		 ($1, 'parent', 'extension', $2, 'household', 1),
		 ($3, 'facility_host', 'extension', $4, 'household', 1),
		 ($5, 'parent', 'extension', $2, 'household', 1)`,
		[
			CANONICAL_EXTENSION_ID,
			PARENT_ID,
			CUSTOM_EXTENSION_ID,
			CUSTOM_HOST_ID,
			MULTI_EXTENSION_ID,
		],
	);
}

async function retainSecondaryExtension(): Promise<void> {
	await h.pool.query(
		`INSERT INTO case_indices
		 (case_id, identifier, relationship, ancestor_id, target_case_type, depth)
		 VALUES ($1, 'aaa_custom_host', 'extension', $2, 'household', 1)`,
		[MULTI_EXTENSION_ID, CUSTOM_HOST_ID],
	);
}

describe("automation criteria SQL", () => {
	it("sees a case whose status was never written when deciding host ambiguity", async () => {
		await insertExtensionFixtures();
		await retainSecondaryExtension();
		// `cases.status` is nullable with no database default and optional on
		// insert, so a great many rows carry NULL — and NULL means OPEN
		// everywhere else a case's lifecycle is read. Written `= 'open'`, this
		// probe would not see the row at all, and the refusal it exists to
		// raise would silently not happen: the count would run against a
		// population whose host resolution is ambiguous and report a number
		// nobody can trust. A probe whose whole job is to refuse has to fail
		// closed.
		await h.pool.query(`UPDATE cases SET status = null WHERE case_id = $1`, [
			MULTI_EXTENSION_ID,
		]);

		await expect(
			store().count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				automationCriteria: {
					requiresUnambiguousHost: true,
					operator: "all",
					dates: [],
					comparisons: [
						{
							property: "marker",
							value: "present",
							equal: true,
							scope: "host",
						},
					],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).rejects.toEqual(
			expect.objectContaining<Partial<AutomationHostAmbiguityError>>({
				name: "AutomationHostAmbiguityError",
				ambiguousOpenCaseCount: 1,
			}),
		);
	});

	it("counts a host-scoped criterion when every open case has at most one host", async () => {
		await insertExtensionFixtures();

		await expect(
			store().count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: true,
					operator: "all",
					dates: [],
					comparisons: [
						{
							property: "marker",
							value: "present",
							equal: true,
							scope: "host",
						},
					],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(3);
	});

	it("refuses host-scoped counts for a retained second host in the same snapshot", async () => {
		await insertExtensionFixtures();
		const caseStore = store();
		const count = (scope: "case" | "parent" | "host") =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: scope === "host",
					operator: "all",
					dates: [],
					comparisons: [
						{
							property: "marker",
							value: "present",
							equal: true,
							scope,
						},
					],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		// Relations attached to an out-of-Project case cannot turn the count into
		// an existence oracle for another tenant.
		await h.pool.query(
			`INSERT INTO case_indices
			 (case_id, identifier, relationship, ancestor_id, target_case_type, depth)
			 VALUES
			 ('01890f45-0000-7000-8000-000000000105', 'first', 'extension', $1, 'household', 1),
			 ('01890f45-0000-7000-8000-000000000105', 'second', 'extension', $2, 'household', 1)`,
			[PARENT_ID, CUSTOM_HOST_ID],
		);
		await expect(count("host")).resolves.toBe(3);

		// Model a historical operation-created edge retained after that operation
		// disappeared from the current Blueprint. HQ's `case.host` chooses the
		// first live extension without defining its order.
		await retainSecondaryExtension();
		await expect(count("host")).rejects.toEqual(
			expect.objectContaining<Partial<AutomationHostAmbiguityError>>({
				name: "AutomationHostAmbiguityError",
				ambiguousOpenCaseCount: 1,
			}),
		);

		// The retained row does not affect criteria that never resolve `host/...`.
		await expect(count("case")).resolves.toBe(0);
		await expect(count("parent")).resolves.toBe(4);

		// Automatic rules skip closed target cases before criteria evaluation, so
		// a closed ambiguous row cannot make the open-case count unavailable.
		await h.pool.query(
			`UPDATE cases
			 SET status = 'closed', closed_on = now()
			 WHERE case_id = $1`,
			[MULTI_EXTENSION_ID],
		);
		await expect(count("host")).resolves.toBe(2);
	});

	it("preserves HQ's all/any identity for an empty criteria group", async () => {
		const caseStore = store();
		const count = (operator: "all" | "any") =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator,
					dates: [],
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

	it("matches implicit case identity and type metadata without catalog entries", async () => {
		const caseStore = store();
		const base = {
			appId: APP_ID,
			caseType: "visit",
			caseTypeSchemas: schemas,
			predicate: eq(prop("visit", "status"), literal("open")),
		} as const;
		const count = (property: "case_id" | "case_type", value: string) =>
			caseStore.count({
				...base,
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [
						{ property, value, equal: true, scope: "case" as const },
					],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		await expect(count("case_type", "visit")).resolves.toBe(4);
		await expect(
			count("case_id", "01890f45-0000-7000-8000-000000000102"),
		).resolves.toBe(1);
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
					requiresUnambiguousHost: false,
					operator: "all",
					dates: [],
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
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
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
					requiresUnambiguousHost: false,
					operator: "any",
					dates: [],
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
		await h.pool.query(
			`INSERT INTO cases
			 (case_id, app_id, project_id, owner_id, case_type, case_name,
			  status, closed_on, properties)
			 VALUES
			 ('01890f45-0000-7000-8000-000000000125', $1, $2, 'facility-a',
			  'visit', 'Unicode whitespace code', 'open', null, $3::jsonb),
			 ('01890f45-0000-7000-8000-000000000126', $1, $2, 'facility-a',
			  'visit', 'Unicode text code', 'open', null, $4::jsonb)`,
			[
				APP_ID,
				PROJECT_ID,
				JSON.stringify({ code: PYTHON_STRIP_WHITESPACE_FIXTURE }),
				JSON.stringify({ code: `${PYTHON_STRIP_WHITESPACE_FIXTURE}x` }),
			],
		);
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
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [],
					blankness: [
						{ property: "code", hasValue: false, scope: "case" as const },
					],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(2);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [],
					blankness: [
						{ property: "code", hasValue: true, scope: "case" as const },
					],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(4);
		await expect(
			caseStore.count({
				...base,
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [{ property: "code", pattern: "[0-9]+" }],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			}),
		).resolves.toBe(0);
	});

	it("matches Python re.match newline semantics for portable regex tokens", async () => {
		const rows = [
			["01890f45-0000-7000-8000-000000000130", "Dot newline", "p\nb"],
			["01890f45-0000-7000-8000-000000000131", "Dot character", "pxb"],
			["01890f45-0000-7000-8000-000000000132", "Dot CR", "p\rb"],
			["01890f45-0000-7000-8000-000000000133", "Negated class newline", "q\nz"],
			["01890f45-0000-7000-8000-000000000134", "Final newline", "e\n"],
			["01890f45-0000-7000-8000-000000000135", "Double final newline", "e\n\n"],
			["01890f45-0000-7000-8000-000000000136", "CRLF", "r\r\n"],
			["01890f45-0000-7000-8000-000000000137", "Escaped dot", "A.\n"],
			["01890f45-0000-7000-8000-000000000138", "Class dollar", "$\n"],
			["01890f45-0000-7000-8000-000000000139", "Alternation", "XB"],
			["01890f45-0000-7000-8000-000000000140", "Case sensitive", "ABC"],
			["01890f45-0000-7000-8000-000000000141", "Empty", ""],
			["01890f45-0000-7000-8000-000000000142", "Only newline", "\n"],
		] as const;
		for (const [caseId, caseName, code] of rows) {
			await h.pool.query(
				`INSERT INTO cases
				 (case_id, app_id, project_id, owner_id, case_type, case_name,
				  status, closed_on, properties)
				 VALUES ($1, $2, $3, 'facility-a', 'visit', $4, 'open', null, $5::jsonb)`,
				[caseId, APP_ID, PROJECT_ID, caseName, JSON.stringify({ code })],
			);
		}
		const caseStore = store();
		const count = (pattern: string) =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [{ property: "code", pattern }],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		// Python's default dot excludes LF but consumes CR.
		await expect(count("p.b")).resolves.toBe(2);
		// Python `$` succeeds just before one final LF, not before two.
		await expect(count("e$")).resolves.toBe(1);
		await expect(count("r.$")).resolves.toBe(1);
		// Unlike PostgreSQL's newline-sensitive modes, Python negated classes
		// still consume LF; the token lowering must preserve that behavior.
		await expect(count("q[^x]z")).resolves.toBe(1);
		await expect(count("A\\.$")).resolves.toBe(1);
		await expect(count("[$.]$")).resolves.toBe(1);
		// The absolute start applies to every alternative, and matching is case
		// sensitive under the pinned C collation.
		await expect(count("Y|B")).resolves.toBe(0);
		await expect(count("abc")).resolves.toBe(0);
		// A bare end anchor matches the empty string and one final LF.
		await expect(count("$")).resolves.toBe(2);
	});

	it("does not treat null standard scalars as empty regex strings", async () => {
		await h.pool.query(
			`INSERT INTO cases
			 (case_id, app_id, project_id, owner_id, case_type, case_name,
			  external_id, status, closed_on, properties)
			 VALUES
			 ('01890f45-0000-7000-8000-000000000143', $1, $2, null,
			  'visit', 'Null standard scalars', null, 'open', null, '{}'::jsonb),
			 ('01890f45-0000-7000-8000-000000000144', $1, $2, '',
			  'visit', 'Empty standard scalars', '', 'open', null, '{}'::jsonb)`,
			[APP_ID, PROJECT_ID],
		);
		const caseStore = store();
		const count = (property: "external_id" | "owner_id") =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: false,
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [{ property, pattern: "$" }],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		// HQ calls regex.match only for Python strings. SQL NULL models None,
		// while a persisted empty text scalar is an actual string and matches `$`.
		await expect(count("external_id")).resolves.toBe(1);
		await expect(count("owner_id")).resolves.toBe(1);
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
					requiresUnambiguousHost: scope === "host",
					operator: "all" as const,
					dates: [],
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

		await h.pool.query(
			`UPDATE cases
			 SET properties = jsonb_build_object('marker', $1::text)
			 WHERE case_id = ANY($2::text[])`,
			[PYTHON_STRIP_WHITESPACE_FIXTURE, [PARENT_ID, CUSTOM_HOST_ID]],
		);
		const countNamed = (
			caseName: string,
			scope: "parent" | "host",
			hasValue: boolean,
		) =>
			caseStore.count({
				...base,
				predicate: eq(prop("visit", "case_name"), literal(caseName)),
				automationCriteria: {
					requiresUnambiguousHost: scope === "host",
					operator: "all" as const,
					dates: [],
					comparisons: [],
					regexes: [],
					blankness: [{ property: "marker", hasValue, scope }],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		await expect(
			countNamed("Canonical extension", "parent", true),
		).resolves.toBe(0);
		await expect(
			countNamed("Canonical extension", "parent", false),
		).resolves.toBe(1);
		await expect(countNamed("Custom extension", "host", true)).resolves.toBe(0);
		await expect(countNamed("Custom extension", "host", false)).resolves.toBe(
			1,
		);
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
					requiresUnambiguousHost: comparison.scope === "host",
					operator: "all" as const,
					dates: [],
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

	it("matches HQ calendar-day offsets through parent and sole-host semantics", async () => {
		await insertExtensionFixtures();
		const clock = await h.pool.query<{ today: string; tomorrow: string }>(
			`SELECT
			 to_char(timezone('UTC', now())::date, 'YYYY-MM-DD') AS today,
			 to_char(timezone('UTC', now())::date + 1, 'YYYY-MM-DD') AS tomorrow`,
		);
		const today = clock.rows[0]?.today;
		const tomorrow = clock.rows[0]?.tomorrow;
		if (today === undefined || tomorrow === undefined) {
			throw new Error("missing database clock");
		}
		await h.pool.query(
			`UPDATE cases
			 SET properties = properties || jsonb_build_object('due_at', $1::text)
			 WHERE case_id = $2`,
			[`${today}T23:30:00-08:00`, PARENT_ID],
		);
		await h.pool.query(
			`UPDATE cases
			 SET properties = properties || jsonb_build_object('due_at', $1::text)
			 WHERE case_id = $2`,
			[`${tomorrow}T01:00:00+14:00`, CUSTOM_HOST_ID],
		);
		await h.pool.query(
			`UPDATE cases
			 SET properties = properties || jsonb_build_object('due_at', $1::text)
			 WHERE case_id = '01890f45-0000-7000-8000-000000000102'`,
			[`${today}T23:30:00-08:00`],
		);
		await h.pool.query(
			`INSERT INTO cases
			 (case_id, app_id, project_id, owner_id, case_type, case_name,
			  status, closed_on, properties)
			 VALUES
			 ($1, $2, $3, 'facility-a', 'visit', 'Child link named host',
			  'open', null, '{}'::jsonb)`,
			[CHILD_IDENTIFIER_HOST_ID, APP_ID, PROJECT_ID],
		);
		await h.pool.query(
			`INSERT INTO case_indices
			 (case_id, identifier, relationship, ancestor_id, target_case_type, depth)
			 VALUES ($1, 'host', 'child', $2, 'household', 1)`,
			[CHILD_IDENTIFIER_HOST_ID, CUSTOM_HOST_ID],
		);

		const caseStore = store();
		const count = (
			scope: "case" | "parent" | "host",
			matchType:
				| "date-days-before"
				| "date-days-lte"
				| "date-days-gt"
				| "date-days",
		) =>
			caseStore.count({
				appId: APP_ID,
				caseType: "visit",
				caseTypeSchemas: schemas,
				predicate: eq(prop("visit", "status"), literal("open")),
				automationCriteria: {
					requiresUnambiguousHost: scope === "host",
					operator: "all",
					dates: [
						{
							property: "due_at",
							days: 0,
							matchType,
							scope,
						},
					],
					comparisons: [],
					regexes: [],
					blankness: [],
					closedParents: [],
					locationOwnerSets: [],
				},
			});

		for (const [matchType, expected] of [
			["date-days-before", 0],
			["date-days-lte", 1],
			["date-days-gt", 0],
			["date-days", 1],
		] as const) {
			await expect(count("case", matchType)).resolves.toBe(expected);
		}
		for (const [matchType, expected] of [
			["date-days-before", 0],
			["date-days-lte", 4],
			["date-days-gt", 0],
			["date-days", 4],
		] as const) {
			await expect(count("parent", matchType)).resolves.toBe(expected);
		}
		for (const [matchType, expected] of [
			["date-days-before", 1],
			["date-days-lte", 4],
			["date-days-gt", 0],
			["date-days", 3],
		] as const) {
			await expect(count("host", matchType)).resolves.toBe(expected);
		}
	});
});
