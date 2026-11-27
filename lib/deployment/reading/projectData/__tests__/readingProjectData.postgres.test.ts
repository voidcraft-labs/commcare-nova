/**
 * The read of a bring-in's project data over real Postgres, with CommCare HQ
 * answering through a controlled peer from its own retained answers, and the
 * two birth writers run in the order and at the point a birth runs them.
 *
 * It would catch: the read and the create naming two ids for one table; a
 * read that leaves a row; a failed read worded as another read's; places read
 * past Nova's limit or across a change in CommCare HQ; a table found after
 * the gate looked for it; and an app born on a Project table that changed
 * after its offer was judged.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	retainedSourceBody,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { claimsUnder, mintingResolver } from "@/lib/commcare/reader/identity";
import { levelsFromHq } from "@/lib/commcare/reader/worldEntities";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { lookupContextForAuthoritativeWrite } from "@/lib/db/canonicalCommitKernel";
import { AppHeadMovedError } from "@/lib/db/commitGuard";
import { replaceLookupReferenceEdges } from "@/lib/db/lookupReferenceEdges";
import { withAppTx } from "@/lib/db/pg";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import {
	type LookupColumnId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import {
	createManagedLookupTablesInTransaction,
	LookupReviewMovedError,
	readKeptLookupColumnIds,
	refreshManagedLookupTableInTransaction,
} from "@/lib/lookup/managed";
import {
	createLookupTable,
	getLookupManifest,
	getLookupTable,
	replaceLookupRows,
	updateLookupColumnLabel,
} from "@/lib/lookup/service";
import type {
	LookupRevision,
	LookupScope,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import {
	type ReaderProjectDataReads,
	type ReadingProjectData,
	readingProjectDataFindingsFor,
	readingProjectDataWrite,
	underTableChoices,
} from "../index";
import { broughtInLookupColumnId, broughtInLookupTableId } from "../lookupIds";
import {
	BroughtInTableChangedError,
	readHqLookupTablesForReading,
	writeBroughtInLookupTablesInTransaction,
} from "../lookupTableStore";
import {
	type LookupTableBinding,
	managedLookupContentOf,
} from "../lookupTables";
import { writeBroughtInPlacesInTransaction } from "../placeStore";
import {
	postgresProjectSide,
	type ReadingProjectSide,
	readReadingProjectData,
} from "../read";
import { projectDataReview } from "../review";

// Three: one test holds a lock on one connection while a birth waits on a
// second and the test watches for that wait on a third.
const h = setupAppStateTestDb("reading_project_data_", {
	authSchema: "migrated",
	poolMax: 3,
});

const PROJECT = "reading-project";
const ACTOR = "reading-person";
const DOMAIN = "clinic";
const SERVER = "india";
const ORIGIN = { server: SERVER, domain: DOMAIN } as const;
const APP_ID = "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d";
const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";
/** The ids of a reading: the app it is for and its own. */
interface ReadingIds {
	readonly appId: string;
	readonly readingId: string;
}
const FIRST: ReadingIds = { appId: APP_ID, readingId: READING_ID };
/** A second app brought in from the same project space, into the same Project. */
const SECOND: ReadingIds = {
	appId: "5e1d7c3a-9b2f-4c6e-8a0d-1f3b5c7e9a2b",
	readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a6c",
};
const AT = new Date("2026-11-10T09:00:00.000Z");
const SCOPE: LookupScope = {
	projectId: PROJECT,
	actorId: ACTOR,
	role: "owner",
};

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: SERVER,
} as const;
const HOST = "https://india.commcarehq.org";
const READS = path.join(process.cwd(), "proof/hq-reads");
const LIST = `/a/${DOMAIN}/api/lookup_table/v1/?limit=1000`;
const LEVELS = `/a/${DOMAIN}/api/location_type/v1/?limit=1000`;
const PLACE_DETAILS = `/a/${DOMAIN}/api/location/v1/?limit=1000`;
const PLACES = `/a/${DOMAIN}/api/location/v2/?limit=5000`;
const PLAIN_ID = "09948f8373da4c86a86b7707a0e9fbcd";
const RICH_ID = "9ea70d486f644cc4a2f22c063294e197";

function rowsPath(tableId: string): string {
	return `/a/${DOMAIN}/api/fixture/v1/?fixture_type_id=${tableId}`;
}

interface Retained {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: string;
}

function retained(relative: string): Retained {
	return JSON.parse(readFileSync(path.join(READS, relative), "utf8"));
}

function serve(peer: MockAgent, requestPath: string, answer: Retained): void {
	peer
		.get(HOST)
		.intercept({ path: requestPath, method: "GET" })
		.reply(answer.status, answer.body, { headers: answer.headers });
}

function serveJson(peer: MockAgent, requestPath: string, body: unknown): void {
	serve(peer, requestPath, {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** CommCare HQ's lookup tables, with the rows of `plain` and `rich`, which the source names. */
function serveTables(peer: MockAgent): void {
	serve(peer, LIST, retained("lookups/lookup-tables.json"));
	serve(peer, rowsPath(PLAIN_ID), retained("lookups/fixture-rows-plain.json"));
	serveRich(peer);
}

/**
 * The rows of `rich`, whose definition carries a row attribute and a field
 * property, so Nova reads them as the plan's section 1B says: the ordered
 * list, the definition, each listed row's detail
 * (`fixtures/resources/v0_1.py::LookupTableItemResource`) in two passes, and
 * the definition again. Each detail repeats what the list holds, in the
 * `field_list` form, with the row's sort key and no attribute value.
 */
function serveRich(peer: MockAgent): void {
	const list = retained("lookups/fixture-rows-rich.json");
	const rows = (
		JSON.parse(list.body) as {
			objects: { id: string; fields: Record<string, unknown> }[];
		}
	).objects;
	const definition = (
		JSON.parse(retained("lookups/lookup-tables.json").body) as {
			objects: { id: string }[];
		}
	).objects.find((table) => table.id === RICH_ID);
	for (let pass = 0; pass < 3; pass++) serve(peer, rowsPath(RICH_ID), list);
	for (let read = 0; read < 2; read++)
		serveJson(peer, `/a/${DOMAIN}/api/lookup_table/v1/${RICH_ID}/`, definition);
	for (const [index, row] of rows.entries()) {
		const fields = Object.fromEntries(
			Object.entries(row.fields).map(([name, value]) => [
				name,
				typeof value === "string"
					? { field_list: [{ field_value: value, properties: {} }] }
					: value,
			]),
		);
		for (let pass = 0; pass < 2; pass++)
			serveJson(peer, `/a/${DOMAIN}/api/lookup_table_item/v1/${row.id}/`, {
				id: row.id,
				data_type_id: RICH_ID,
				sort_key: index,
				item_attributes: {},
				fields,
			});
	}
}

/** A row in the shape `FixtureResource` serves. */
function hqRow(id: string, tag: string, fields: Record<string, string>) {
	return { id, fixture_type: tag, fields, resource_uri: "" };
}

/** A list or a page of rows in the shape tastypie serves. */
function page(objects: readonly unknown[]) {
	return {
		meta: { limit: 100, next: null, offset: 0, total_count: objects.length },
		objects,
	};
}

/** CommCare HQ's tables once `plain` gained the field `region`, with its rows. */
function serveWithRegion(peer: MockAgent): void {
	serve(peer, LIST, retained("lookups/lookup-tables-after-column-added.json"));
	serveJson(
		peer,
		rowsPath(PLAIN_ID),
		page([
			hqRow("afee9d3436974abab80b9ecd5b7f0656", "plain", {
				code: "001",
				name: "Clinic",
				region: "north",
			}),
			hqRow("098753f4f32d423f9b2f93223bb42ada", "plain", {
				code: "002",
				name: "Hospital",
				region: "south",
			}),
		]),
	);
	serveRich(peer);
}

const ZONES_ID = "3f0a5d2c7b1e4a9c8d6f0e2b4a6c8e01";
const CLINICS_ID = "3f0a5d2c7b1e4a9c8d6f0e2b4a6c8e02";

/** Two plain tables, `zones` listed first, with a row each. */
function serveTwoTables(peer: MockAgent): void {
	const table = (id: string, tag: string) => ({
		id,
		tag,
		fields: [{ field_name: "code", properties: [] }],
		is_global: true,
		item_attributes: [],
		resource_uri: "",
	});
	serveJson(
		peer,
		LIST,
		page([table(ZONES_ID, "zones"), table(CLINICS_ID, "clinics")]),
	);
	serveJson(
		peer,
		rowsPath(ZONES_ID),
		page([hqRow("3f0a5d2c7b1e4a9c8d6f0e2b4a6c8e11", "zones", { code: "z1" })]),
	);
	serveJson(
		peer,
		rowsPath(CLINICS_ID),
		page([
			hqRow("3f0a5d2c7b1e4a9c8d6f0e2b4a6c8e12", "clinics", { code: "c1" }),
		]),
	);
}

/** The level answer in the shape `LocationTypeResource` serves. */
function levelAnswer(withDistrict: boolean) {
	const region = {
		id: 1,
		name: "Region",
		code: "region",
		parent: null,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	};
	const district = {
		id: 2,
		name: "District",
		code: "district",
		parent: `/a/${DOMAIN}/api/location_type/v1/1/`,
		administrative: false,
		shares_cases: true,
		view_descendants: false,
	};
	return {
		meta: { next: null, total_count: withDistrict ? 2 : 1 },
		objects: withDistrict ? [region, district] : [region],
	};
}

function servePlaces(peer: MockAgent, withDistrict = true): void {
	serveJson(peer, LEVELS, levelAnswer(withDistrict));
	for (const [url, file] of [
		[PLACES, "locations"],
		[PLACE_DETAILS, "locations-v1"],
	]) {
		const answer = retained(`places/${file}.json`);
		serve(peer, url, {
			...answer,
			body: answer.body
				.replaceAll("nova-proof", DOMAIN)
				.replaceAll("https://www.commcarehq.org", HOST),
		});
	}
}

function calls(peer: MockAgent): readonly string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => call.fullUrl.slice(HOST.length)) ?? []
	);
}

/**
 * A source CommCare HQ served, its first form declaring the `plain` and
 * `rich` tables and reading both in a question condition.
 */
async function namingSource(
	tags: readonly string[] = ["plain", "rich"],
): Promise<HqAppSource> {
	const body = retainedSourceBody(
		"navigation-base/app-source-after-form-settings-save",
	);
	const attachments = body._attachments as Record<string, string>;
	const [first] = Object.keys(attachments).sort();
	const casedb = '<instance src="jr://instance/casedb" id="casedb"/>';
	if (!attachments[first].includes(casedb))
		throw new Error("the retained form declares no case instance");
	return sourceFromBody({
		...body,
		_attachments: {
			...attachments,
			[first]: attachments[first]
				.replace(
					casedb,
					casedb +
						tags
							.map(
								(tag) =>
									`<instance src="jr://fixture/item-list:${tag}" id="${tag}"/>`,
							)
							.join(""),
				)
				.replace(
					"<bind ",
					`<bind relevant="${tags.map((tag) => `count(instance('${tag}')/${tag}_list/${tag}) > 0`).join(" and ")}" `,
				),
		},
	});
}

function side(ids: ReadingIds = FIRST): ReadingProjectSide {
	return postgresProjectSide({
		projectId: PROJECT,
		actorUserId: ACTOR,
		appId: ids.appId,
		origin: ORIGIN,
	});
}

async function read(
	source: HqAppSource,
	places: "when-source-reads" | "always" = "when-source-reads",
	project?: ReadingProjectSide,
	ids: ReadingIds = FIRST,
) {
	return readReadingProjectData({
		creds: CREDS,
		server: SERVER,
		domain: DOMAIN,
		appId: ids.appId,
		readingId: ids.readingId,
		source,
		project: project ?? side(ids),
		places,
	});
}

async function readData(
	source: HqAppSource,
	places: "when-source-reads" | "always" = "when-source-reads",
	project?: ReadingProjectSide,
	ids: ReadingIds = FIRST,
): Promise<ReadingProjectData> {
	const answer = await read(source, places, project, ids);
	if (answer.kind !== "read")
		throw new Error(`the read failed: ${JSON.stringify(answer)}`);
	return answer.data;
}

function bindingOf(data: ReadingProjectData, tag: string): LookupTableBinding {
	const binding = data.gathered.tables.find(
		(table) => table.read.table.tag === tag,
	)?.binding;
	if (binding === undefined || binding === null)
		throw new Error(`${tag} is not bound`);
	return binding;
}

const PLAIN_READS: ReaderProjectDataReads = {
	lookupFields: { plain: ["code", "name"] },
	unreadTables: [],
	declaredTables: [],
	readsPlaces: false,
};

/** A survey whose question takes its choices from `plain`, under the levels given. */
function bornDoc(
	binding: LookupTableBinding,
	levels: readonly OrganizationLevel[] = [],
	appId: string = APP_ID,
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Clinics",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "clinic",
								label: proseText("Clinic"),
								optionsSource: {
									kind: "lookup",
									tableId: binding.tableId,
									valueColumnId: binding.columns.code,
									labelColumnId: binding.columns.name,
								},
							}),
						],
					},
				],
			},
		],
	});
	return {
		...doc,
		appId,
		organizationLevels: Object.fromEntries(
			levels.map((level) => [level.uuid, level]),
		),
		organizationLevelOrder: levels.map((level) => level.uuid),
	};
}

/** The Project's own `plain`: CommCare HQ's columns, another row. */
async function seedProjectPlain(): Promise<LookupTableSnapshot> {
	const created = await createLookupTable(SCOPE, {
		name: "Clinics",
		tag: "plain",
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = created.columns;
	await replaceLookupRows(SCOPE, {
		tableId: created.id,
		expectedTableRevision: created.tableRevision,
		rows: [{ [code.id]: "003", [name.id]: "Pharmacy" }],
	});
	return getLookupTable(SCOPE, created.id);
}

/** The Project's own `plain`, equal to CommCare HQ's columns and rows. */
async function seedEqualPlain(): Promise<LookupTableSnapshot> {
	const created = await createLookupTable(SCOPE, {
		name: "Clinics",
		tag: "plain",
		columns: [
			{ wireName: "code", label: "Code", dataType: "text" },
			{ wireName: "name", label: "Name", dataType: "text" },
		],
	});
	const [code, name] = created.columns;
	await replaceLookupRows(SCOPE, {
		tableId: created.id,
		expectedTableRevision: created.tableRevision,
		rows: [
			{ [code.id]: "001", [name.id]: "Clinic" },
			{ [code.id]: "002", [name.id]: "Hospital" },
		],
	});
	return getLookupTable(SCOPE, created.id);
}

const SIBLING_APP = "7c3e9a1b-5d2f-4e8a-9c0b-2d4f6a8c0e1f";

/**
 * Another app of the Project that publishes the Project's table to CommCare
 * HQ's `plain` in this project space: its deployment and its live mapping.
 * Answers the mapping's id.
 */
async function seedSiblingMapping(tableId: string): Promise<string> {
	await h.seedApp({ id: SIBLING_APP, owner: ACTOR, project_id: PROJECT });
	const deployment = await h
		.db()
		.insertInto("app_deployments")
		.values({
			app_id: SIBLING_APP,
			project_id: PROJECT,
			server: SERVER,
			domain: DOMAIN,
			state: "uploaded",
			phases: JSON.stringify({ upload: { status: "succeeded" } }),
			created_by: ACTOR,
			content_generation: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a7d",
			last_observed_at: new Date("2026-11-02T00:00:00.000Z"),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	const mapping = await h
		.db()
		.insertInto("app_deployment_resources")
		.values({
			deployment_id: deployment.id,
			kind: "lookup-table",
			nova_resource_id: tableId,
			remote_id: PLAIN_ID,
			pushed_identity: "plain",
			ownership: "nova-created",
			adopted_at: null,
			adopted_by: null,
			pushed_revision: null,
			pushed_at: new Date("2026-11-02T00:00:00.000Z"),
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return mapping.id;
}

async function rowCounts() {
	const tables = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM lookup_tables WHERE project_id = ${PROJECT}
	`.execute(h.db());
	const rows = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM lookup_rows WHERE project_id = ${PROJECT}
	`.execute(h.db());
	const apps = await sql<{ count: string }>`
		SELECT count(*)::text AS count FROM apps WHERE id = ${APP_ID}
	`.execute(h.db());
	return {
		tables: tables.rows[0]?.count,
		rows: rows.rows[0]?.count,
		apps: apps.rows[0]?.count,
	};
}

/** The birth's app row, inserted on the birth's own transaction. */
async function insertBornApp(
	tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
	appId: string = APP_ID,
): Promise<void> {
	await tx
		.insertInto("apps")
		.values({
			id: appId,
			owner: ACTOR,
			project_id: PROJECT,
			app_name: "Clinics",
			app_name_lower: "clinics",
			module_count: 0,
			form_count: 0,
			mutation_seq: 0,
			status: "complete",
			awaiting_input: false,
		})
		.execute();
}

/** A birth's two writers, then what the gate and the organization step read after them. */
async function birth(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
	doc: BlueprintDoc,
) {
	const { appId } = doc;
	const write = readingProjectDataWrite(
		data,
		reads,
		doc,
		mintingResolver(appId),
	);
	return withAppTx(async (tx) => {
		await insertBornApp(tx, appId);
		await writeBroughtInLookupTablesInTransaction(
			tx,
			{ projectId: PROJECT, actorUserId: ACTOR, appId },
			{
				origin: write.origin,
				tables: write.tables,
				readAt: write.tablesReadAt,
			},
		);
		await writeBroughtInPlacesInTransaction(
			tx,
			{ appId, projectId: PROJECT, actorUserId: ACTOR },
			{ origin: write.origin, places: write.places, at: AT },
		);
		const lookup = await lookupContextForAuthoritativeWrite(
			tx,
			PROJECT,
			extractLookupReferenceTargets(doc),
		);
		await applyOrganizationCommitIntegrity(tx, {
			appId,
			previousDoc: doc,
			candidateDoc: doc,
		});
		return lookup;
	});
}

describe("readReadingProjectData over Postgres", () => {
	it("names one table and its columns the same in two calls, and writes nothing in either", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const unrelated = await createLookupTable(SCOPE, {
			name: "Unrelated",
			tag: "unrelated",
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		});
		await replaceLookupRows(SCOPE, {
			tableId: unrelated.id,
			expectedTableRevision: unrelated.tableRevision,
			rows: [{ [unrelated.columns[0].id]: "1" }],
		});
		const source = await namingSource();
		const before = await rowCounts();
		const [first, second] = await withHttpPeer(async (peer) => {
			serveTables(peer);
			serveTables(peer);
			return [await readData(source), await readData(source)];
		});
		expect(bindingOf(first, "plain")).toEqual(bindingOf(second, "plain"));
		expect(bindingOf(first, "plain")).toEqual({
			tag: "plain",
			tableId: broughtInLookupTableId(APP_ID, READING_ID, "plain"),
			columns: {
				code: broughtInLookupColumnId(APP_ID, READING_ID, "plain", "code"),
				name: broughtInLookupColumnId(APP_ID, READING_ID, "plain", "name"),
			},
		});
		expect(
			first.gathered.tables.map((table) => [
				table.read.table.tag,
				table.standing?.kind ?? null,
				table.findings.length > 0,
			]),
		).toEqual([
			["plain", "new", false],
			["rich", null, true],
		]);
		expect(first.gathered.hqTags).toEqual(["plain", "rich", "long"]);
		expect(first.placesRead).toBe(false);
		expect(await rowCounts()).toEqual(before);
	});

	it("binds a choice to the Project table's id, at the revisions the read saw, which the review copies", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		const [plain] = data.gathered.tables;
		expect(plain.standing?.kind).toBe("choice");
		expect(plain.binding?.tableId).toBe(project.id);
		expect(plain.binding?.columns).toEqual({
			code: project.columns[0].id,
			name: project.columns[1].id,
		});
		const met = {
			tableId: project.id,
			definitionRevision: project.definitionRevision,
			rowsRevision: project.rowsRevision,
		};
		expect(plain.projectTable).toEqual(met);
		const review = projectDataReview(
			data,
			PLAIN_READS,
			bornDoc(bindingOf(data, "plain")),
			mintingResolver(APP_ID),
		);
		expect(review.tables.map((table) => table.projectTable)).toEqual([met]);
		expect(review.tables[0].choice?.differs).toEqual(["rows"]);
	});

	it("answers a failed read failed, classified by the read that failed", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, {
				status: 503,
				headers: { "content-type": "text/plain" },
				body: "Unavailable",
			});
			expect(await read(source)).toEqual({
				kind: "failed",
				failure: {
					kind: "hq-unavailable",
					request: "lookup-tables",
					status: 503,
				},
			});
		});
		await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serve(peer, rowsPath(PLAIN_ID), {
				status: 403,
				headers: { "content-type": "text/plain" },
				body: "Forbidden",
			});
			expect(await read(source)).toEqual({
				kind: "failed",
				failure: {
					kind: "permission",
					request: "lookup-rows",
					status: 403,
					permission: "edit-apps-and-access-apis",
				},
			});
		});
	});

	it("reads places for a source whose text names none only when asked to always", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			const data = await readData(source);
			expect(data.placesRead).toBe(false);
			expect(data.organization).toEqual({ levelCodes: [], levels: [] });
			expect(calls(peer)).not.toContain(LEVELS);
		});
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			servePlaces(peer);
			const data = await readData(source, "always");
			expect(data.placesRead).toBe(true);
			expect(data.organization.levelCodes).toEqual(["region", "district"]);
			expect(data.organization.levels).toBe(data.gathered.hqLevels);
			expect(data.gathered.hqPlaces.map((place) => place.siteCode)).toEqual([
				"north",
				"north_clinic",
				"south",
			]);
			expect(
				data.gathered.hqPlaces.every(
					(place) => place.observation !== undefined,
				),
			).toBe(true);
		});
	});

	it("reads the levels and places once more where a place names a level the list lacks, and fails where they still disagree", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			servePlaces(peer, false);
			servePlaces(peer, true);
			const data = await readData(source, "always");
			expect(data.organization.levelCodes).toEqual(["region", "district"]);
			expect(calls(peer).slice(-6)).toEqual([
				LEVELS,
				PLACES,
				PLACE_DETAILS,
				LEVELS,
				PLACES,
				PLACE_DETAILS,
			]);
		});
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			servePlaces(peer, false);
			servePlaces(peer, false);
			expect((await readData(source, "always")).gathered.inconsistent).toBe(
				true,
			);
			expect(calls(peer).slice(-6)).toEqual([
				LEVELS,
				PLACES,
				PLACE_DETAILS,
				LEVELS,
				PLACES,
				PLACE_DETAILS,
			]);
		});
	});

	it("answers every table new over a Project side that holds nothing", async () => {
		const source = await namingSource();
		const nothing: ReadingProjectSide = {
			tables: async () => ({
				projectId: "lane",
				projectRevision: "0" as LookupRevision,
				definitions: [],
				rowsByTable: {},
			}),
			referencingApps: async () => ({}),
			siblings: async () => [],
			mayAdminister: async () => false,
			measureRows: async () => ({ dataBytes: 0, largestRowBytes: 0 }),
		};
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source, "when-source-reads", nothing);
		});
		const standings = data.gathered.tables.flatMap((table) =>
			table.standing === null ? [] : [table.standing.kind],
		);
		expect(standings).toEqual(["new"]);
		expect(
			data.gathered.tables.every((table) => table.projectTable === null),
		).toBe(true);
	});

	it("raises a table's findings only where the reader read it, and a read of a table CommCare HQ's list lacks", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		const resolver = () => mintingResolver(APP_ID);
		expect(
			readingProjectDataFindingsFor(data, PLAIN_READS, null, resolver()),
		).toEqual([]);
		const rich = data.gathered.tables.find(
			(table) => table.read.table.tag === "rich",
		);
		const findings = readingProjectDataFindingsFor(
			data,
			{ ...PLAIN_READS, unreadTables: ["gone", "rich"] },
			null,
			resolver(),
		);
		expect(
			findings.map((finding) => [finding.code, finding.detail.name]),
		).toEqual([
			[
				"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
				"gone",
			],
			...(rich?.findings ?? []).map((finding) => [
				finding.code,
				finding.detail.name,
			]),
		]);
		expect(rich?.findings.length).toBeGreaterThan(0);
	});
});

describe("the birth's two writers, in a birth's order", () => {
	it("writes the tables under the ids the read derived, so the gate finds them, and the places the organization step proves", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			servePlaces(peer);
			return readData(source, "always");
		});
		const binding = bindingOf(data, "plain");
		const levels = levelsFromHq(
			data.gathered.hqLevels,
			claimsUnder(mintingResolver(APP_ID)),
		);
		const doc = bornDoc(binding, levels.levels);
		const reads = { ...PLAIN_READS, readsPlaces: true };
		expect(
			readingProjectDataFindingsFor(data, reads, doc, mintingResolver(APP_ID)),
		).toEqual([]);

		const lookup = await birth(data, reads, doc);
		expect(lookup.kind).toBe("available");
		if (lookup.kind !== "available") throw new Error("no lookup context");
		const definition = lookup.definitions.find(
			(table) => table.id === binding.tableId,
		);
		expect(
			definition?.columns.map((column) => [column.wireName, column.id]),
		).toEqual([
			["code", binding.columns.code],
			["name", binding.columns.name],
		]);

		const table = await getLookupTable(SCOPE, binding.tableId);
		expect(
			table.rows.map((row) => [
				row.values[binding.columns.code as LookupColumnId],
				row.values[binding.columns.name as LookupColumnId],
			]),
		).toEqual([
			["001", "Clinic"],
			["002", "Hospital"],
		]);
		const places = await h
			.db()
			.selectFrom("app_locations")
			.select(["site_code", "hq_location_id"])
			.where("app_id", "=", APP_ID)
			.orderBy("site_code")
			.execute();
		expect(places).toEqual([
			{
				site_code: "north",
				hq_location_id: "834a246164014b729dae962085b8894c",
			},
			{
				site_code: "north_clinic",
				hq_location_id: "69fe0e9395c0468face474ec8be9ce05",
			},
			{
				site_code: "south",
				hq_location_id: "500152b7915c4cb596b54564a523bf70",
			},
		]);
	});

	it("refuses a Project table whose rows moved after the read, and leaves no row", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		const [code, name] = project.columns;
		await replaceLookupRows(SCOPE, {
			tableId: project.id,
			expectedTableRevision: project.tableRevision,
			rows: [{ [code.id]: "004", [name.id]: "Lab" }],
		});
		const before = await rowCounts();
		const moved = await getLookupTable(SCOPE, project.id);
		await expect(
			birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain"))),
		).rejects.toBeInstanceOf(BroughtInTableChangedError);
		expect(await rowCounts()).toEqual(before);
		expect(before.apps).toBe("0");
		expect(await getLookupTable(SCOPE, project.id)).toEqual(moved);
	});

	it("refuses a Project table whose definition alone moved after the read, and leaves no row", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		const [code] = project.columns;
		await updateLookupColumnLabel(SCOPE, {
			tableId: project.id,
			expectedTableRevision: project.tableRevision,
			columnId: code.id,
			label: "Site code",
		});
		const moved = await getLookupTable(SCOPE, project.id);
		/* The rows did not move: only a writer that compares the definition
		 * revision refuses this birth. */
		expect(moved.rowsRevision).toBe(project.rowsRevision);
		expect(moved.definitionRevision).not.toBe(project.definitionRevision);
		const before = await rowCounts();
		await expect(
			birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain"))),
		).rejects.toBeInstanceOf(BroughtInTableChangedError);
		expect(await rowCounts()).toEqual(before);
		expect(before.apps).toBe("0");
		expect(await getLookupTable(SCOPE, project.id)).toEqual(moved);
	});

	it("refuses a table the Project made of the tag after a read that found none, and leaves no row", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		expect(data.gathered.tables[0].standing?.kind).toBe("new");
		await seedProjectPlain();
		const before = await rowCounts();
		await expect(
			birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain"))),
		).rejects.toBeInstanceOf(BroughtInTableChangedError);
		expect(await rowCounts()).toEqual(before);
		const derived = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM lookup_tables
			WHERE id = ${broughtInLookupTableId(APP_ID, READING_ID, "plain")}
		`.execute(h.db());
		expect(derived.rows[0]?.count).toBe("0");
	});

	it("takes CommCare HQ's rows into a met, unmoved Project table answered use-commcare-hq, under its own ids, so the gate finds it", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		const binding = bindingOf(data, "plain");
		const [code, name] = project.columns;
		expect(binding).toEqual({
			tag: "plain",
			tableId: project.id,
			columns: { code: code.id, name: name.id },
		});
		const doc = bornDoc(binding);
		const lookup = await birth(data, PLAIN_READS, doc);
		if (lookup.kind !== "available") throw new Error("no lookup context");
		expect(
			lookup.definitions
				.find((table) => table.id === project.id)
				?.columns.map((column) => [column.wireName, column.id]),
		).toEqual([
			["code", code.id],
			["name", name.id],
		]);
		const adopted = await getLookupTable(SCOPE, project.id);
		expect(
			adopted.rows.map((row) => [row.values[code.id], row.values[name.id]]),
		).toEqual([
			["001", "Clinic"],
			["002", "Hospital"],
		]);
		expect(adopted.columns.map((column) => column.dataType)).toEqual([
			"text",
			"text",
		]);
		expect(adopted.hq).toMatchObject({
			server: SERVER,
			domain: DOMAIN,
			remoteId: PLAIN_ID,
			managedBy: "commcare-hq",
		});
	});

	it("refuses an adoption answered over a list of apps that read the table, once another app began reading it, and leaves the table as it was", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		const standing = data.gathered.tables[0].standing;
		expect(standing?.kind === "choice" && standing.apps).toEqual([]);
		/* Another app of the Project starts reading the table after the read: no
		 * revision of the table moves. */
		const reader = await h.seedApp({
			id: "stock-counts",
			project_id: PROJECT,
		});
		await withAppTx((tx) =>
			replaceLookupReferenceEdges(tx, {
				appId: reader,
				projectId: PROJECT,
				targets: { tableIds: [project.id], columnTargets: [] },
			}),
		);
		const before = await rowCounts();
		await expect(
			birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain"))),
		).rejects.toBeInstanceOf(LookupReviewMovedError);
		expect(await rowCounts()).toEqual(before);
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
	});

	it("commits a change's adoption with the change or not at all", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const changing = await h.seedApp({
			id: "changing-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const head = Number(
			(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", changing)
					.executeTakeFirstOrThrow()
			).mutation_seq,
		);
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		const write = readingProjectDataWrite(
			data,
			PLAIN_READS,
			bornDoc(bindingOf(data, "plain")),
			mintingResolver(APP_ID),
		);
		const projectRevision = async () =>
			(await getLookupManifest(SCOPE)).projectRevision;
		const change = (
			expectedHeadSeq: number,
			name: string,
			inTransaction?: () => Promise<void>,
		) =>
			applyBlueprintChange({
				appId: changing,
				userId: ACTOR,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				kind: "hq-changes",
				expectedHeadSeq,
				guard: {
					mutations: admitMutationBatch([{ kind: "setAppName", name }]),
				},
				projectDataWrite: ({ tx, projectId }) =>
					writeBroughtInLookupTablesInTransaction(
						tx,
						{ projectId, actorUserId: ACTOR, appId: changing },
						{
							origin: write.origin,
							tables: write.tables,
							readAt: write.tablesReadAt,
						},
					),
				...(inTransaction !== undefined && { inTransaction }),
			});

		/* Turned back at a moved head: the shared table is as it was. */
		const revisionBefore = await projectRevision();
		await expect(change(head + 1, "From CommCare HQ")).rejects.toBeInstanceOf(
			AppHeadMovedError,
		);
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
		expect(await projectRevision()).toBe(revisionBefore);

		/* Turned back by a failure after the table's write (the deployment's
		 * record): still as it was. */
		await expect(
			change(head, "From CommCare HQ", async () => {
				throw new Error("the record could not be written");
			}),
		).rejects.toThrow("the record could not be written");
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
		expect(await projectRevision()).toBe(revisionBefore);

		/* Taken: the adoption, the change and one advance of the Project, at one commit. */
		const committed = await change(head, "From CommCare HQ");
		expect(committed.seq).toBe(head + 1);
		const adopted = await getLookupTable(SCOPE, project.id);
		expect(adopted.hq).toMatchObject({
			domain: DOMAIN,
			managedBy: "commcare-hq",
		});
		expect(adopted.rows.map((row) => Object.values(row.values))).toEqual([
			["001", "Clinic"],
			["002", "Hospital"],
		]);
		expect(BigInt(await projectRevision())).toBe(
			BigInt(revisionBefore) + BigInt(1),
		);
	});

	it("writes nothing to a Project table answered use-project", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-project" },
		);
		const before = await rowCounts();
		const lookup = await birth(
			data,
			PLAIN_READS,
			bornDoc(bindingOf(data, "plain")),
		);
		expect(lookup.kind).toBe("available");
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
		expect(await rowCounts()).toEqual({ ...before, apps: "1" });
	});

	it("writes nothing to an equal table an app of the Project publishes as this very table, and refuses it once that mapping is gone", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedEqualPlain();
		const mapping = await seedSiblingMapping(project.id);
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		expect(data.gathered.tables[0].standing?.kind).toBe("same-equal");
		const reads = PLAIN_READS;
		const doc = bornDoc(bindingOf(data, "plain"));

		// The mapping superseded: the tag asks a choice now, and no answer was given.
		await h
			.db()
			.updateTable("app_deployment_resources")
			.set({ superseded_at: new Date("2026-11-10T08:00:00.000Z") })
			.where("id", "=", mapping)
			.execute();
		const before = await rowCounts();
		await expect(birth(data, reads, doc)).rejects.toBeInstanceOf(
			BroughtInTableChangedError,
		);
		expect(await rowCounts()).toEqual(before);

		await h
			.db()
			.updateTable("app_deployment_resources")
			.set({ superseded_at: null })
			.where("id", "=", mapping)
			.execute();
		expect((await birth(data, reads, doc)).kind).toBe("available");
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
	});

	it("refreshes a table managed from this project space, giving a field it lacks the id the binding derived", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const first = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		await birth(first, PLAIN_READS, bornDoc(bindingOf(first, "plain")));
		const managed = bindingOf(first, "plain");

		const second = await withHttpPeer(async (peer) => {
			serveWithRegion(peer);
			return readData(source, "when-source-reads", undefined, SECOND);
		});
		expect(second.gathered.tables[0].standing?.kind).toBe("same-managed");
		const binding = bindingOf(second, "plain");
		const region = broughtInLookupColumnId(
			SECOND.appId,
			SECOND.readingId,
			"plain",
			"region",
		);
		expect(binding).toEqual({
			tag: "plain",
			tableId: managed.tableId,
			columns: { ...managed.columns, region },
		});
		await birth(second, PLAIN_READS, bornDoc(binding, [], SECOND.appId));
		const table = await getLookupTable(SCOPE, managed.tableId);
		expect(table.columns.map((column) => [column.wireName, column.id])).toEqual(
			[
				["code", managed.columns.code],
				["name", managed.columns.name],
				["region", region],
			],
		);
		expect(
			table.rows.map((row) => row.values[region as LookupColumnId]),
		).toEqual(["north", "south"]);
	});

	it("refreshes a table managed from this project space whose rows alone changed, leaving its definition where it was", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const first = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		await birth(first, PLAIN_READS, bornDoc(bindingOf(first, "plain")));
		const managed = bindingOf(first, "plain");
		const before = await getLookupTable(SCOPE, managed.tableId);

		const second = await withHttpPeer(async (peer) => {
			serve(peer, LIST, retained("lookups/lookup-tables.json"));
			serveJson(
				peer,
				rowsPath(PLAIN_ID),
				page([
					hqRow("afee9d3436974abab80b9ecd5b7f0656", "plain", {
						code: "001",
						name: "Health centre",
					}),
					hqRow("098753f4f32d423f9b2f93223bb42ada", "plain", {
						code: "002",
						name: "Hospital",
					}),
				]),
			);
			serveRich(peer);
			return readData(source, "when-source-reads", undefined, SECOND);
		});
		expect(second.gathered.tables[0].standing?.kind).toBe("same-managed");
		const binding = bindingOf(second, "plain");
		expect(binding).toEqual(managed);
		await birth(second, PLAIN_READS, bornDoc(binding, [], SECOND.appId));
		const table = await getLookupTable(SCOPE, managed.tableId);
		// A refresh from the same remote table whose fields and kept columns
		// are as they were changes the rows alone; an adopt would stamp the
		// definition too.
		expect(table.definitionRevision).toBe(before.definitionRevision);
		expect(table.rowsRevision).not.toBe(before.rowsRevision);
		expect(
			table.rows.map(
				(row) => row.values[managed.columns.name as LookupColumnId],
			),
		).toEqual(["Health centre", "Hospital"]);
	});

	it("refuses a use-commcare-hq answer that is no longer offered once the person is no admin, though neither revision moved", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedProjectPlain();
		const source = await namingSource();
		const data = underTableChoices(
			await withHttpPeer(async (peer) => {
				serveTables(peer);
				return readData(source);
			}),
			{ plain: "use-commcare-hq" },
		);
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const before = await rowCounts();
		await expect(
			birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain"))),
		).rejects.toBeInstanceOf(BroughtInTableChangedError);
		expect(await rowCounts()).toEqual(before);
		expect(await getLookupTable(SCOPE, project.id)).toEqual(project);
	});
});

describe("a birth that would write over what the Project holds now", () => {
	/** The Project's own `plain`: CommCare HQ's two fields and 248 columns of its own, 250 in all. */
	async function seedWidePlain(): Promise<LookupTableSnapshot> {
		const created = await createLookupTable(SCOPE, {
			name: "Clinics",
			tag: "plain",
			columns: [
				{ wireName: "code", label: "Code", dataType: "text" },
				{ wireName: "name", label: "Name", dataType: "text" },
				...Array.from({ length: 248 }, (_, index) => ({
					wireName: `extra_${index}`,
					label: `Extra ${index}`,
					dataType: "text" as const,
				})),
			],
		});
		return getLookupTable(SCOPE, created.id);
	}

	/** Another app of the Project that reads each of `plain`'s own columns. */
	async function readOwnColumns(table: LookupTableSnapshot): Promise<void> {
		await h.seedApp({ id: SIBLING_APP, owner: ACTOR, project_id: PROJECT });
		await withAppTx((tx) =>
			replaceLookupReferenceEdges(tx, {
				appId: SIBLING_APP,
				projectId: PROJECT,
				targets: {
					tableIds: [table.id],
					columnTargets: table.columns
						.filter((column) => column.wireName.startsWith("extra_"))
						.map((column) => ({ tableId: table.id, columnId: column.id })),
				},
			}),
		);
	}

	it("adopts CommCare HQ's table where its fields and the columns apps still read pass 250, keeping each column an app reads", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const project = await seedWidePlain();
		const source = await namingSource();
		/* An app reads the Project's own columns: CommCare HQ's three fields with
		 * them make 251 columns, which the table holds. */
		await readOwnColumns(project);
		const data = await withHttpPeer(async (peer) => {
			serveWithRegion(peer);
			return readData(source);
		});
		const standing = data.gathered.tables[0].standing;
		if (standing?.kind !== "choice") throw new Error("plain asks no choice");
		expect(standing.options["use-commcare-hq"].offered).toBe(true);
		const answered = underTableChoices(data, { plain: "use-commcare-hq" });
		await birth(answered, PLAIN_READS, bornDoc(bindingOf(answered, "plain")));
		const adopted = await getLookupTable(SCOPE, project.id);
		expect(adopted.hq?.managedBy).toBe("commcare-hq");
		expect(adopted.columns).toHaveLength(251);
		const kept = new Set(
			project.columns
				.filter((column) => column.wireName.startsWith("extra_"))
				.map((column) => column.id),
		);
		expect(
			adopted.columns.filter((column) => kept.has(column.id)),
		).toHaveLength(248);
	});

	it("refuses a table a refresh stamped after the reading's read though no revision moved, and stamps each table it writes with that read's date", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const first = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		await birth(first, PLAIN_READS, bornDoc(bindingOf(first, "plain")));
		const managed = bindingOf(first, "plain");
		const born = await getLookupTable(SCOPE, managed.tableId);
		expect(born.hq?.refreshedAt).toBe(
			first.gathered.tablesReadAt.toISOString(),
		);

		const second = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source, "when-source-reads", undefined, SECOND);
		});
		expect(second.gathered.tables[0].standing?.kind).toBe("same-managed");
		const read = second.gathered.tables[0].read;
		if (read.kind !== "read") throw new Error("plain was not read");
		/* A Refresh whose read began after the reading's finds CommCare HQ's table as it was:
		 * it stamps its date and moves no revision. */
		const receipt = await withAppTx(async (tx) =>
			refreshManagedLookupTableInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(tx, SCOPE, "edit"),
				{
					tableId: managed.tableId,
					content: managedLookupContentOf(read.table, read.rows),
					origin: {
						server: SERVER,
						domain: DOMAIN,
						remoteId: PLAIN_ID,
						canonical: { ...read.canonical },
					},
					at: new Date(second.gathered.tablesReadAt.getTime() + 1_000),
					mode: "refresh",
					olderReadYields: true,
				},
			),
		);
		expect(receipt.changed).toBe("nothing");
		const stamped = await getLookupTable(SCOPE, managed.tableId);
		expect(stamped.definitionRevision).toBe(born.definitionRevision);
		expect(stamped.rowsRevision).toBe(born.rowsRevision);
		expect(stamped.hq?.refreshedAt).not.toBe(born.hq?.refreshedAt);

		const before = await rowCounts();
		/* The refresh's own writer refuses it, under the table's lock. */
		await expect(
			birth(
				second,
				PLAIN_READS,
				bornDoc(bindingOf(second, "plain"), [], SECOND.appId),
			),
		).rejects.toBeInstanceOf(LookupReviewMovedError);
		expect(await rowCounts()).toEqual(before);
		expect(await getLookupTable(SCOPE, managed.tableId)).toEqual(stamped);
	});
});

describe("the columns CommCare HQ's content keeps, and the order the birth locks tables in", () => {
	it("names the columns an app reads, which the refresh keeps where CommCare HQ's fields lack them", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		const doc = bornDoc(bindingOf(data, "plain"));
		await birth(data, PLAIN_READS, doc);
		const { tableId, columns } = bindingOf(data, "plain");
		expect(await readKeptLookupColumnIds(h.db(), PROJECT, [tableId])).toEqual(
			{},
		);
		await withAppTx((tx) =>
			replaceLookupReferenceEdges(tx, {
				appId: APP_ID,
				projectId: PROJECT,
				targets: {
					tableIds: [tableId],
					columnTargets: [{ tableId, columnId: columns.name }],
				},
			}),
		);
		expect(await readKeptLookupColumnIds(h.db(), PROJECT, [tableId])).toEqual({
			[tableId]: [columns.name],
		});

		const read = data.gathered.tables[0].read;
		if (read.kind !== "read") throw new Error("plain was not read");
		const receipt = await withAppTx(async (tx) =>
			refreshManagedLookupTableInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(tx, SCOPE, "edit"),
				{
					tableId,
					content: { fields: ["code"], rows: [{ code: "001" }] },
					origin: {
						server: SERVER,
						domain: DOMAIN,
						remoteId: PLAIN_ID,
						canonical: { ...read.canonical, digest: "f".repeat(64) },
					},
					/* Read after the birth, whose write is dated by its own read. */
					at: new Date(),
					mode: "refresh",
					olderReadYields: true,
				},
			),
		);
		expect(receipt.keptGoneColumns.map((column) => column.id)).toEqual([
			columns.name,
		]);
		expect(receipt.removedColumns).toEqual([]);
	});

	it("names the columns an accepted design protects, by column and by whole table, which the refresh keeps alike", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const data = await withHttpPeer(async (peer) => {
			serveTables(peer);
			return readData(source);
		});
		await birth(data, PLAIN_READS, bornDoc(bindingOf(data, "plain")));
		const { tableId, columns } = bindingOf(data, "plain");
		const read = data.gathered.tables[0].read;
		if (read.kind !== "read") throw new Error("plain was not read");
		const project = await getLookupTable(SCOPE, tableId);
		const lineage = await h.seedDesignLineage({
			project_id: PROJECT,
			owner_user_id: ACTOR,
		});
		const materializationId = crypto.randomUUID();
		await h
			.db()
			.insertInto("design_lookup_materializations")
			.values({
				id: materializationId,
				design_session_id: lineage.designSessionId,
				design_revision_id: lineage.designRevisionId,
				design_revision_digest: lineage.designRevisionDigest,
				project_id: PROJECT,
				project_revision: project.projectRevision,
				result_digest: "a".repeat(64),
				mapping: JSON.stringify({}),
				created_by_run_id: "run-reading-protection",
			})
			.execute();
		const protect = (columnId: LookupColumnId | null) =>
			h
				.db()
				.insertInto("design_lookup_protections")
				.values({
					materialization_id: materializationId,
					project_id: PROJECT,
					table_id: tableId,
					column_id: columnId,
				})
				.execute();
		/** CommCare HQ's `plain` with `code` alone, as a refresh writes it. */
		const refreshToCode = (digest: string) =>
			withAppTx(async (tx) =>
				refreshManagedLookupTableInTransaction(
					tx,
					await authorizeLookupWriteInTransaction(tx, SCOPE, "edit"),
					{
						tableId,
						content: { fields: ["code"], rows: [{ code: "001" }] },
						origin: {
							server: SERVER,
							domain: DOMAIN,
							remoteId: PLAIN_ID,
							canonical: { ...read.canonical, digest },
						},
						/* Read after the birth, whose write is dated by its own read. */
						at: new Date(),
						mode: "refresh",
						olderReadYields: true,
					},
				),
			);

		await protect(columns.name);
		expect(await readKeptLookupColumnIds(h.db(), PROJECT, [tableId])).toEqual({
			[tableId]: [columns.name],
		});
		expect(
			(await refreshToCode("f".repeat(64))).keptGoneColumns.map(
				(column) => column.id,
			),
		).toEqual([columns.name]);

		await h
			.db()
			.deleteFrom("design_lookup_protections")
			.where("materialization_id", "=", materializationId)
			.execute();
		await protect(null);
		// A whole table's protection keeps every column; the one CommCare HQ's
		// fields name is counted once (`columnsAfterHqFills`).
		expect(await readKeptLookupColumnIds(h.db(), PROJECT, [tableId])).toEqual({
			[tableId]: [columns.code, columns.name],
		});
		const receipt = await refreshToCode("e".repeat(64));
		expect(receipt.keptGoneColumns.map((column) => column.id)).toEqual([
			columns.name,
		]);
		expect(receipt.removedColumns).toEqual([]);
	});

	it("refreshes two Project tables in id order, so a writer that takes them in that order never deadlocks with it", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		// `zones` has the lower id and the later tag.
		const low = lookupTableIdSchema.parse(
			"019a8000-0000-7000-8000-000000000001",
		);
		const high = lookupTableIdSchema.parse(
			"019a8000-0000-7000-8000-000000000002",
		);
		const source = await namingSource(["zones", "clinics"]);
		const reads = await withHttpPeer(async (peer) => {
			serveTwoTables(peer);
			const answer = await readHqLookupTablesForReading({
				creds: CREDS,
				domain: DOMAIN,
				referencedTags: async () => new Set(["zones", "clinics"]),
			});
			if ("success" in answer) throw new Error("the tables did not read");
			return answer.tables;
		});
		await withAppTx(async (tx) =>
			createManagedLookupTablesInTransaction(
				tx,
				await authorizeLookupWriteInTransaction(tx, SCOPE, "edit"),
				reads.map((read, at) => {
					if (read.kind !== "read") throw new Error("a table was not read");
					const tag = read.table.tag;
					return {
						binding: {
							tag,
							tableId: tag === "zones" ? low : high,
							columns: {
								code: lookupColumnIdSchema.parse(
									`019a8000-0000-7000-8000-0000000000a${at}`,
								),
							},
						},
						name: tag,
						content: managedLookupContentOf(read.table, read.rows),
						origin: {
							server: SERVER,
							domain: DOMAIN,
							remoteId: read.table.id,
							canonical: { ...read.canonical },
						},
					};
				}),
				AT,
			),
		);
		const data = await withHttpPeer(async (peer) => {
			serveTwoTables(peer);
			return readData(source, "when-source-reads", undefined, SECOND);
		});
		expect(
			data.gathered.tables.map((table) => [
				table.read.table.tag,
				table.standing?.kind,
			]),
		).toEqual([
			["zones", "same-managed"],
			["clinics", "same-managed"],
		]);
		const write = readingProjectDataWrite(
			data,
			{
				lookupFields: { clinics: ["code"], zones: ["code"] },
				unreadTables: [],
				declaredTables: [],
				readsPlaces: false,
			},
			buildDoc({ appName: "Two tables", modules: [] }),
			mintingResolver(SECOND.appId),
		);

		/* Another app's autosave takes the tables FOR KEY SHARE in id order. It
		 * holds `zones` (the lower id) until the birth waits on it, then asks
		 * for `clinics`. A birth that took `clinics` first deadlocks with it. */
		let locked!: () => void;
		const holding = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const keyShare = (
			tx: Parameters<Parameters<typeof withAppTx>[0]>[0],
			id: string,
		) =>
			sql`SELECT id FROM lookup_tables WHERE project_id = ${PROJECT} AND id = ${id} FOR KEY SHARE`.execute(
				tx,
			);
		const autosave = h
			.db()
			.transaction()
			.execute(async (tx) => {
				await keyShare(tx, low);
				locked();
				await vi.waitFor(
					async () => {
						const waiting = await sql<{ count: string }>`
							SELECT count(*)::text AS count FROM pg_stat_activity
							WHERE datname = current_database() AND wait_event_type = 'Lock'
						`.execute(h.db());
						expect(waiting.rows[0]?.count).toBe("1");
					},
					{ timeout: 5_000, interval: 20 },
				);
				await keyShare(tx, high);
			});
		await holding;
		// A plain transaction: a retry would hide the deadlock this test is for.
		const born = h
			.db()
			.transaction()
			.execute(async (tx) => {
				await insertBornApp(tx, SECOND.appId);
				await writeBroughtInLookupTablesInTransaction(
					tx,
					{ projectId: PROJECT, actorUserId: ACTOR, appId: SECOND.appId },
					{
						origin: write.origin,
						tables: write.tables,
						readAt: write.tablesReadAt,
					},
				);
			});
		const [saved, birthed] = await Promise.allSettled([autosave, born]);
		expect(saved).toEqual({ status: "fulfilled", value: undefined });
		expect(birthed).toEqual({ status: "fulfilled", value: undefined });
	});
});
