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
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import {
	retainedSourceBody,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { levelsFromHq } from "@/lib/commcare/reader/worldEntities";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { lookupContextForAuthoritativeWrite } from "@/lib/db/canonicalCommitKernel";
import { withAppTx } from "@/lib/db/pg";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, OrganizationLevel } from "@/lib/domain";
import type { LookupColumnId } from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import {
	createLookupTable,
	getLookupTable,
	replaceLookupRows,
	updateLookupColumnLabel,
} from "@/lib/lookup/service";
import type {
	LookupRevision,
	LookupScope,
	LookupTableSnapshot,
} from "@/lib/lookup/types";
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
	writeBroughtInLookupTablesInTransaction,
} from "../lookupTableStore";
import type { LookupTableBinding } from "../lookupTables";
import { writeBroughtInPlacesInTransaction } from "../placeStore";
import {
	postgresProjectSide,
	type ReadingProjectSide,
	readReadingProjectData,
} from "../read";
import { projectDataReview } from "../review";

const h = setupAppStateTestDb("reading_project_data_", {
	authSchema: "migrated",
	poolMax: 2,
});

const PROJECT = "reading-project";
const ACTOR = "reading-person";
const DOMAIN = "clinic";
const SERVER = "india";
const ORIGIN = { server: SERVER, domain: DOMAIN } as const;
const APP_ID = "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d";
const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";
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
const LIST = `/a/${DOMAIN}/api/lookup_table/v1/?limit=100`;
const LEVELS = `/a/${DOMAIN}/api/location_type/v1/?limit=1000`;
const PLACES = `/a/${DOMAIN}/api/location/v2/?limit=1000`;
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
	serve(peer, rowsPath(RICH_ID), retained("lookups/fixture-rows-rich.json"));
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
	serve(peer, PLACES, retained("places/locations.json"));
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
 * `rich` tables as the form builder declares a lookup table.
 */
async function namingSource(): Promise<HqAppSource> {
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
			[first]: attachments[first].replace(
				casedb,
				`${casedb}<instance src="jr://fixture/item-list:plain" id="plain"/><instance src="jr://fixture/item-list:rich" id="rich"/>`,
			),
		},
	});
}

function side(): ReadingProjectSide {
	return postgresProjectSide({
		projectId: PROJECT,
		actorUserId: ACTOR,
		appId: APP_ID,
		origin: ORIGIN,
	});
}

async function read(
	source: HqAppSource,
	places: "when-source-reads" | "always" = "when-source-reads",
	project: ReadingProjectSide = side(),
) {
	return readReadingProjectData({
		creds: CREDS,
		server: SERVER,
		domain: DOMAIN,
		appId: APP_ID,
		readingId: READING_ID,
		source,
		project,
		places,
	});
}

async function readData(
	source: HqAppSource,
	places: "when-source-reads" | "always" = "when-source-reads",
	project?: ReadingProjectSide,
): Promise<ReadingProjectData> {
	const answer = await read(source, places, project);
	if (answer.kind !== "read")
		throw new Error(`the read failed: ${JSON.stringify(answer.failure)}`);
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
	readsPlaces: false,
};

/** A survey whose question takes its choices from `plain`, under the levels given. */
function bornDoc(
	binding: LookupTableBinding,
	levels: readonly OrganizationLevel[] = [],
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
		appId: APP_ID,
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
): Promise<void> {
	await tx
		.insertInto("apps")
		.values({
			id: APP_ID,
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
	const write = readingProjectDataWrite(
		data,
		reads,
		doc,
		mintingResolver(APP_ID),
	);
	return withAppTx(async (tx) => {
		await insertBornApp(tx);
		await writeBroughtInLookupTablesInTransaction(
			tx,
			{ projectId: PROJECT, actorUserId: ACTOR, appId: APP_ID },
			{ origin: write.origin, tables: write.tables, at: AT },
		);
		await writeBroughtInPlacesInTransaction(
			tx,
			{ appId: APP_ID, projectId: PROJECT, actorUserId: ACTOR },
			{ origin: write.origin, places: write.places, at: AT },
		);
		const lookup = await lookupContextForAuthoritativeWrite(
			tx,
			PROJECT,
			extractLookupReferenceTargets(doc),
		);
		await applyOrganizationCommitIntegrity(tx, {
			appId: APP_ID,
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
			expect(data.gathered.placesPastLimit).toBeNull();
		});
	});

	it("stops a place list past Nova's limit at the page that names its total", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const source = await namingSource();
		const page = JSON.parse(retained("places/locations.json").body) as {
			meta: Record<string, unknown>;
		};
		page.meta.total_count = 10_001;
		page.meta.next = `/a/${DOMAIN}/api/location/v2/?limit=1000&offset=1000`;
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			serveJson(peer, LEVELS, levelAnswer(true));
			serveJson(peer, PLACES, page);
			const data = await readData(source, "always");
			expect(data.gathered.placesPastLimit).toEqual({ totalCount: 10_001 });
			expect(data.gathered.hqPlaces).toEqual([]);
			expect(calls(peer).filter((call) => call.startsWith(PLACES))).toEqual([
				PLACES,
			]);
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
			expect(calls(peer).slice(-4)).toEqual([LEVELS, PLACES, LEVELS, PLACES]);
		});
		await withHttpPeer(async (peer) => {
			serveTables(peer);
			servePlaces(peer, false);
			servePlaces(peer, false);
			expect(await read(source, "always")).toEqual({
				kind: "failed",
				failure: { kind: "hq-unavailable", request: "locations", status: 200 },
			});
			expect(calls(peer).slice(-4)).toEqual([LEVELS, PLACES, LEVELS, PLACES]);
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
			mintingResolver(APP_ID),
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
});
