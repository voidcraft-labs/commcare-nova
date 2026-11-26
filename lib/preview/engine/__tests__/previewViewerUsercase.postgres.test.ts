/** A Project viewer's Preview reads the worker's record and never writes it.
 * Real app birth, real committed personas and the real case store with its
 * edit-capability fence; only the authenticated request session is supplied
 * at its external boundary. */
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { withProjectContext, withSchemaContext } from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import { applyBlueprintChangeProposal } from "@/lib/db/__tests__/admittedWriterTestHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import type { CaseType } from "@/lib/domain";
import {
	eq,
	ifExpr,
	literal,
	prop,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";
import { log } from "@/lib/logger";
import {
	createLookupTable,
	getLookupDefinitions,
	replaceLookupRows,
} from "@/lib/lookup/service";
import { assertAdmittedPreviewDoc } from "../../__tests__/fixtures/admittedDoc";
import { loadCasesAction } from "../caseDataBinding";
import { resolveAuthorizedPreviewContext } from "../previewAuthorization";

const OWNER = "viewer-usercase-owner";
const VIEWER = "viewer-usercase-viewer";
const PROJECT = "viewer-usercase-project";
const PERSONA = testUuid("viewer-usercase-persona");
const CADRE = testUuid("viewer-usercase-cadre");

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth-utils")>()),
	getSession: async () => ({
		user: {
			id: session.userId,
			name: session.userId,
			email: `${session.userId}@dimagi.com`,
		},
		session: { id: `${session.userId}-session` },
	}),
}));

const h = setupAppStateTestDb("preview_viewer_usercase_", {
	authSchema: "migrated",
	poolMax: 4,
});
beforeEach(async () => {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	await h.seedProjectMember(VIEWER, PROJECT, "viewer");
	// Each person's live browser session, which Project data reads lock.
	for (const userId of [OWNER, VIEWER])
		await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt")
			VALUES (${`${userId}-session`},${`${userId}-token`},${userId},now()+interval '1 hour',now(),now())
			ON CONFLICT (id) DO NOTHING`.execute(h.db());
});
afterEach(() => {
	vi.restoreAllMocks();
});

async function workerRows(appId: string, workerId: string) {
	const result = await h
		.pool()
		.query(
			"SELECT case_id, properties FROM cases WHERE app_id = $1 AND case_type = 'commcare-user' AND properties->>'hq_user_id' = $2",
			[appId, workerId],
		);
	return result.rows as Array<{
		case_id: string;
		properties: Record<string, unknown>;
	}>;
}

async function appWithPersona(): Promise<string> {
	const birth = await createExplicitBlankApp(
		OWNER,
		PROJECT,
		crypto.randomUUID(),
	);
	await applyBlueprintChangeProposal({
		appId: birth.appId,
		userId: OWNER,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: {
			mutations: [
				{
					kind: "addUserProperty",
					property: { uuid: CADRE, slug: "cadre", label: "Cadre" },
				},
				{
					kind: "addPersona",
					persona: {
						uuid: PERSONA,
						name: "Amara",
						values: { [CADRE]: "nurse" },
					},
				},
			],
		},
	});
	return birth.appId;
}

it("previews a viewer as themselves off the derived record, attempting no write", async () => {
	const appId = await appWithPersona();
	const warn = vi.spyOn(log, "warn");
	session.userId = VIEWER;
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "view",
		loadBlueprint: true,
	});
	if (context.kind !== "ready")
		throw new Error(`Preview refused: ${context.kind}`);
	expect(context.identity.ownerId).toBe(VIEWER);
	expect(context.identity.usercase.hq_user_id).toBe(VIEWER);
	expect(await workerRows(appId, VIEWER)).toEqual([]);
	expect(warn).not.toHaveBeenCalled();
});

it("previews a viewer as a persona off the stored row, a form's write included", async () => {
	const appId = await appWithPersona();
	const [row] = await workerRows(appId, PERSONA);
	if (row === undefined) throw new Error("The commit made no worker row.");
	// What a form's worker-record write leaves on the row, which the derived
	// record does not know.
	const writer = await withProjectContext(PROJECT, OWNER, PERSONA);
	await writer.update({
		appId,
		caseId: row.case_id,
		patch: { properties: { cadre: "midwife" } },
	});
	const warn = vi.spyOn(log, "warn");
	session.userId = VIEWER;
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "view",
		personaUuid: PERSONA,
	});
	if (context.kind !== "ready")
		throw new Error(`Preview refused: ${context.kind}`);
	expect(context.identity.usercase.cadre).toBe("midwife");
	expect(warn).not.toHaveBeenCalled();
});

it("still creates the record for an editor previewing as themselves", async () => {
	const appId = await appWithPersona();
	session.userId = OWNER;
	const context = await resolveAuthorizedPreviewContext({
		appId,
		required: "view",
		loadBlueprint: true,
	});
	if (context.kind !== "ready")
		throw new Error(`Preview refused: ${context.kind}`);
	expect(await workerRows(appId, OWNER)).toHaveLength(1);
});

const PATIENT: CaseType = {
	name: "patient",
	properties: [{ name: "assigned_to", label: proseText("Assigned to") }],
};

it("reads a viewer's own worker record in a list as a form reads it, with no row stored", async () => {
	const appId = await appWithPersona();
	const store = await withSchemaContext();
	await store.applySchemaChange({
		appId,
		caseType: PATIENT.name,
		caseTypeSchemas: buildCaseTypeMap(buildSimpleBlueprint([PATIENT], appId)),
	});
	// The viewer's own cases, written by the owner as the viewer's worker.
	const writer = await withProjectContext(PROJECT, OWNER, VIEWER);
	for (const [name, assignedTo] of [
		["Mine", VIEWER],
		["Someone else's", OWNER],
	] as const)
		await writer.insert({
			appId,
			row: {
				case_type: PATIENT.name,
				case_name: name,
				status: "open",
				properties: { assigned_to: assignedTo },
			},
		});
	// The live list: cases assigned to the worker the record names.
	const config = {
		...caseListConfig([{ field: "case_name", header: "Name" }]),
		filter: eq(
			prop(PATIENT.name, "assigned_to"),
			term({
				kind: "session-user",
				field: "hq_user_id",
				source: "worker-record",
			}),
		),
	};
	const blueprint = assertAdmittedPreviewDoc(
		buildDoc({
			appId,
			caseTypes: [PATIENT],
			modules: [
				{
					name: "Patients",
					caseType: PATIENT.name,
					caseListMenuItem: {},
					caseListConfig: config,
					forms: [],
				},
			],
		}),
	);
	const [moduleUuid] = blueprint.moduleOrder;
	const warn = vi.spyOn(log, "warn");
	session.userId = VIEWER;
	const result = await loadCasesAction({
		appId,
		caseType: PATIENT.name,
		blueprint,
		moduleUuid,
		caseListConfig: config,
		page: { offset: 0, limit: 10 },
	});
	// The record the form side prints (`previewWorkerPropertyBinding`) names
	// the viewer, so the list reads the same worker and keeps their case.
	if (result.kind !== "rows")
		throw new Error(`The list did not read: ${JSON.stringify(result)}`);
	expect(result.rows.map((row) => row.case_name)).toEqual(["Mine"]);
	expect(await workerRows(appId, VIEWER)).toEqual([]);
	expect(warn).not.toHaveBeenCalled();
});

it("orders a viewer’s rows by a calculation that alone uses a Project table", async () => {
	const appId = await appWithPersona();
	const scope = { projectId: PROJECT, actorId: OWNER, role: "owner" as const };
	const table = await createLookupTable(scope, {
		name: "Visit rules",
		tag: "visit_rules",
		columns: [{ wireName: "preferred", label: "Preferred", dataType: "text" }],
	});
	const [preferred] = table.columns;
	if (!preferred) throw new Error("The visit rules table needs its column.");
	await replaceLookupRows(scope, {
		tableId: table.id,
		expectedTableRevision: table.tableRevision,
		rows: [{ [preferred.id]: "West" }],
	});
	const config = {
		...caseListConfig([{ field: "case_name", header: "Name" }]),
		calculatedSorts: [
			{
				uuid: testUuid("preferred-appointments"),
				label: "Preferred clinic first",
				expression: ifExpr(
					eq(
						prop(PATIENT.name, "assigned_to"),
						tableLookup(
							table.id,
							preferred.id,
							eq(tableColumn(table.id, preferred.id), literal("West")),
						),
					),
					term(literal(0)),
					term(literal(1)),
				),
				direction: "asc" as const,
				priority: 0,
				blanks: "last" as const,
			},
		],
	};
	const blueprint = assertAdmittedPreviewDoc(
		buildDoc({
			appId,
			caseTypes: [PATIENT],
			modules: [
				{
					name: "Patients",
					caseType: PATIENT.name,
					caseListMenuItem: {},
					caseListConfig: config,
					forms: [],
				},
			],
		}),
		{ kind: "available", ...(await getLookupDefinitions(scope, [table.id])) },
	);
	const schema = await withSchemaContext();
	await schema.applySchemaChange({
		appId,
		caseType: PATIENT.name,
		caseTypeSchemas: buildCaseTypeMap(blueprint),
	});
	const writer = await withProjectContext(PROJECT, OWNER, VIEWER);
	for (const [id, name, clinic] of [
		["a", "Ana", "East"],
		["z", "Zuri", "West"],
	]) {
		await writer.insert({
			appId,
			row: {
				case_id: id,
				case_name: name,
				case_type: PATIENT.name,
				status: "open",
				properties: { assigned_to: clinic },
			},
		});
	}
	session.userId = VIEWER;
	const result = await loadCasesAction({
		appId,
		caseType: PATIENT.name,
		blueprint,
		moduleUuid: blueprint.moduleOrder[0],
		caseListConfig: config,
		page: { offset: 0, limit: 10 },
	});
	if (result.kind !== "rows")
		throw new Error(
			`The viewer’s case list returned ${JSON.stringify(result)}.`,
		);
	expect(result.rows.map((row) => row.case_name)).toEqual(["Zuri", "Ana"]);
});
