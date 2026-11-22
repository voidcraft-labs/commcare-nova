/**
 * The pure rules of a bring-in's lookup tables, over CommCare HQ's own
 * answers retained under `proof/hq-reads/lookups/`, decoded by the production
 * readers through a controlled peer, each case changing the one value it is
 * about.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { HQ_LOOKUP_TABLE_ROWS_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
	readHqLookupTableRows,
} from "@/lib/commcare/hq/lookupTables";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import type { ReadOutcome } from "@/lib/commcare/reader/types";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupMemberIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import { columnLabelFor } from "@/lib/lookup/managedRules";
import type {
	LookupColumn,
	LookupFixtureRow,
	LookupHqOrigin,
	LookupRevision,
	LookupRowId,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { circumstanceFinding, type Finding } from "@/lib/publish/hqFindings";
import { canonicalLookupTable } from "../../../hqResourceBaseline";
import type { SiblingLookupMapping } from "../../../store";
import { manifestFinding } from "../findings";
import {
	assembleReadingProjectData,
	projectDataReadsOf,
	type ReaderProjectDataReads,
	type ReadingProjectData,
	readingProjectDataFindingsFor,
	underTableChoices,
} from "../index";
import { broughtInLookupColumnId, broughtInLookupTableId } from "../lookupIds";
import {
	candidateLookupTags,
	type HqLookupTableRead,
	type LookupTableBinding,
	type LookupTableStanding,
	lookupFixtureBudgetFinding,
	lookupTableFindings,
	lookupTableStanding,
	readerLookupCatalog,
	readingLookupSnapshot,
	resolveLookupBindings,
	resolveTableChoices,
} from "../lookupTables";
import { projectDataReview } from "../review";
import {
	type ReviewTable,
	reviewPlacesSchema,
	reviewTableSchema,
} from "../reviewTypes";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org";
const READS = path.join(process.cwd(), "proof/hq-reads");
const ORIGIN = { server: "india", domain: "clinic" } as const;
const IDS = {
	appId: "0b4f6a52-7c55-5a35-9d1e-3c2f8a1b4e6d",
	readingId: "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b",
} as const;

type ReadTable = Extract<HqLookupTableRead, { kind: "read" }>;

function retainedBody(relative: string): {
	status: number;
	headers: Record<string, string>;
	body: string;
} {
	return JSON.parse(readFileSync(path.join(READS, relative), "utf8"));
}

/** One table of the retained list's answer, as its JSON holds it. */
type AnsweredTable = { tag: string; fields: unknown[] };

/** The retained list, read by the production reader, its answer's tables changed by `edit` first. */
async function retainedTables(
	edit?: (objects: AnsweredTable[]) => void,
): Promise<readonly HqLookupTable[]> {
	return withHttpPeer(async (peer) => {
		const answer = retainedBody("lookups/lookup-tables.json");
		let body = answer.body;
		if (edit !== undefined) {
			const parsed = JSON.parse(body) as { objects: AnsweredTable[] };
			edit(parsed.objects);
			body = JSON.stringify(parsed);
		}
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/lookup_table/v1/?limit=1000",
				method: "GET",
			})
			.reply(answer.status, body, { headers: answer.headers });
		const tables = await listHqLookupTables(CREDS, "clinic");
		if ("success" in tables) throw new Error("the retained list did not read");
		return tables;
	});
}

async function retainedRows(
	table: HqLookupTable,
	relative: string,
): Promise<readonly HqFixtureRow[]> {
	const tableId = table.id;
	return withHttpPeer(async (peer) => {
		const answer = retainedBody(relative);
		peer
			.get(HOST)
			.intercept({
				path: `/a/clinic/api/fixture/v1/?fixture_type_id=${tableId}`,
				method: "GET",
			})
			.reply(answer.status, answer.body, { headers: answer.headers });
		const rows = await readHqLookupTableRows(CREDS, "clinic", table, {
			maxRows: LOOKUP_MAX_ROWS,
			maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
		});
		if ("success" in rows || "kind" in rows)
			throw new Error(`${relative} did not read`);
		return rows.rows;
	});
}

let plainTable: HqLookupTable;
let plainRows: readonly HqFixtureRow[];
let richTable: HqLookupTable;
let richRows: readonly HqFixtureRow[];

beforeAll(async () => {
	const tables = await retainedTables();
	const tagged = (tag: string) => {
		const table = tables.find((candidate) => candidate.tag === tag);
		if (table === undefined) throw new Error(`no retained table ${tag}`);
		return table;
	};
	plainTable = tagged("plain");
	richTable = tagged("rich");
	plainRows = await retainedRows(plainTable, "lookups/fixture-rows-plain.json");
	richRows = await retainedRows(richTable, "lookups/fixture-rows-rich.json");
});

function readOf(
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
): ReadTable {
	return {
		kind: "read",
		table,
		rows,
		canonical: canonicalLookupTable(table, rows),
	};
}

/** The retained `plain` read with one change. */
function plain(
	change: {
		table?: Partial<HqLookupTable>;
		rows?: readonly HqFixtureRow[];
	} = {},
): ReadTable {
	return readOf({ ...plainTable, ...change.table }, change.rows ?? plainRows);
}

function withCell(
	rows: readonly HqFixtureRow[],
	index: number,
	field: string,
	value: string | undefined,
) {
	return rows.map((row, at) => {
		if (at !== index) return row;
		const fields = { ...row.fields };
		if (value === undefined) delete fields[field];
		else fields[field] = value;
		return { ...row, fields };
	});
}

const NO_MEASURE = null;

/** A character XML 1.0 cannot carry. */
const NOT_A_CHARACTER = String.fromCharCode(0xffff);

function names(
	findings: readonly Finding[],
): readonly [string, string | undefined][] {
	return findings.map((finding) => [finding.code, finding.detail.name]);
}

// ---------------------------------------------------------------------------
// A Project table
// ---------------------------------------------------------------------------

let idCounter = 0;
function uuidV7(): string {
	idCounter += 1;
	return `019a0000-0000-7000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}
function tableId(): LookupTableId {
	return lookupTableIdSchema.parse(uuidV7());
}
function columnId(): LookupColumnId {
	return lookupColumnIdSchema.parse(uuidV7());
}

function column(
	wireName: string,
	dataType: LookupColumn["dataType"] = "text",
): LookupColumn {
	return { id: columnId(), wireName, label: `${wireName} label`, dataType };
}

interface ProjectTable {
	readonly table: LookupTableDefinition;
	readonly rows: readonly LookupFixtureRow[];
}

/** A Project table of the tag, its columns and its rows by wire name. */
function projectTable(
	tag: string,
	columns: readonly LookupColumn[],
	rows: readonly Readonly<Record<string, string | number>>[],
	hq?: LookupHqOrigin,
): ProjectTable {
	const table: LookupTableDefinition = {
		id: tableId(),
		name: `${tag} table`,
		tag,
		definitionRevision: "3" as LookupRevision,
		rowsRevision: "4" as LookupRevision,
		columns,
		...(hq === undefined ? {} : { hq }),
	};
	return {
		table,
		rows: rows.map((cells, index) => ({
			id: `019a0000-0000-7000-9000-${index.toString(16).padStart(12, "0")}` as LookupRowId,
			values: Object.fromEntries(
				columns.flatMap((each) =>
					Object.hasOwn(cells, each.wireName)
						? [[each.id, cells[each.wireName]]]
						: [],
				),
			),
		})),
	};
}

/** The Project table equal to the retained `plain`. */
function equalPlain(hq?: LookupHqOrigin): ProjectTable {
	return projectTable(
		"plain",
		[column("code"), column("name")],
		[
			{ code: "001", name: "Clinic" },
			{ code: "002", name: "Hospital" },
		],
		hq,
	);
}

function origin(
	domain: string,
	managedBy: "commcare-hq" | "nova",
): LookupHqOrigin {
	return {
		server: "india",
		domain,
		remoteId: "09948f8373da4c86a86b7707a0e9fbcd",
		managedBy,
		broughtInAt: "2026-10-01T00:00:00.000Z",
		refreshedAt: "2026-10-01T00:00:00.000Z",
		takenOverAt: managedBy === "nova" ? "2026-10-02T00:00:00.000Z" : null,
		takenOverBy: managedBy === "nova" ? "user-1" : null,
		goneColumnIds: [],
	};
}

function sibling(
	table: LookupTableDefinition,
	remoteId: string,
): SiblingLookupMapping {
	return {
		tableId: table.id,
		appId: "app-2",
		remoteId,
		pushedIdentity: "plain",
		ownership: "nova-created",
		adoptedAt: null,
		adoptedBy: null,
	};
}

const APPS = [{ appId: "app-2", appName: "Intake", deleted: false }];

function standingOf(
	read: ReadTable,
	existing: ProjectTable | null,
	options: {
		siblings?: readonly SiblingLookupMapping[];
		appReads?: readonly string[];
		mayAdminister?: boolean;
		apps?: typeof APPS;
		keptColumnIds?: readonly string[];
	} = {},
): LookupTableStanding {
	return lookupTableStanding({
		read,
		origin: ORIGIN,
		existing,
		apps: options.apps ?? APPS,
		siblings: options.siblings ?? [],
		appReads: options.appReads ?? ["code", "name"],
		mayAdminister: options.mayAdminister ?? true,
		keptColumnIds: options.keptColumnIds ?? [],
	});
}

function choiceOf(standing: LookupTableStanding) {
	if (standing.kind !== "choice")
		throw new Error(`expected a choice, got ${standing.kind}`);
	return standing;
}

// ---------------------------------------------------------------------------

describe("candidateLookupTags", () => {
	const tables = (tags: readonly string[]) =>
		tags.map((tag) => ({ ...plainTable, id: `${tag}-id`, tag }));

	it("names a tag a form's instance source, a suite expression or a search prompt holds, in the list's order", () => {
		const source = [
			'<instance id="anything" src="jr://fixture/item-list:clinics"/>',
			'"filter": "instance(\'item-list:districts\')/districts_list/districts"',
			'"itemset": {"instance_uri": "jr://fixture/item-list:regions"}',
		].join("\n");
		expect(
			candidateLookupTags(
				source,
				tables(["regions", "unused", "clinics", "districts"]),
			),
		).toEqual(["regions", "clinics", "districts"]);
	});

	it("names a tag that begins another's beside it", () => {
		expect(
			candidateLookupTags(
				"jr://fixture/item-list:clinics_old",
				tables(["clinics", "clinics_old"]),
			),
		).toEqual(["clinics", "clinics_old"]);
	});
});

describe("columnLabelFor", () => {
	it("keeps a name of 120 characters whole and cuts one of 121 and of 255 to 120", () => {
		const at = "a".repeat(120);
		expect(columnLabelFor(at)).toBe(at);
		expect(columnLabelFor("b".repeat(121))).toBe("b".repeat(120));
		expect(columnLabelFor("c".repeat(255))).toBe("c".repeat(120));
	});
});

describe("lookupTableFindings", () => {
	it("finds nothing in a plain table within every cap", () => {
		expect(
			lookupTableFindings(plain(), { dataBytes: 100, largestRowBytes: 60 }),
		).toEqual([]);
	});

	it("keeps verified rich fields and row details", () => {
		const rows = richRows.map((row, index) => ({
			...row,
			sortKey: index,
			itemAttributes: { zone: index === 0 ? "upland" : "coastal" },
		}));
		expect(
			lookupTableFindings(
				readOf({ ...richTable, isGlobal: true }, rows),
				NO_MEASURE,
			),
		).toEqual([]);
		expect(
			lookupTableFindings(
				readOf({ ...richTable, isGlobal: true }, richRows),
				NO_MEASURE,
			),
		).toHaveLength(1);
	});

	const CAPS =
		"expressions-and-data/table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64";
	const within = { dataBytes: 0, largestRowBytes: 0 };

	it("judges each cap exactly at it and one over it", () => {
		const row = plainRows[0];
		const rows = (n: number) => Array.from({ length: n }, () => row);
		expect(lookupTableFindings(plain({ rows: rows(5_000) }), within)).toEqual(
			[],
		);
		expect(
			names(lookupTableFindings(plain({ rows: rows(5_001) }), within)),
		).toEqual([[CAPS, "plain: 5,001 rows (Nova takes 5,000)"]]);

		const fields = (n: number) =>
			Array.from({ length: n }, (_, index) => `f${index}`);
		expect(
			lookupTableFindings(
				plain({ table: { fields: fields(250) }, rows: [] }),
				within,
			),
		).toEqual([]);
		expect(
			names(
				lookupTableFindings(
					plain({ table: { fields: fields(251) }, rows: [] }),
					within,
				),
			),
		).toEqual([[CAPS, "plain: 251 columns (Nova takes 250)"]]);

		const cell = (bytes: number) =>
			withCell(plainRows, 0, "name", "x".repeat(bytes));
		expect(
			lookupTableFindings(plain({ rows: cell(64 * 1024) }), within),
		).toEqual([]);
		expect(
			names(lookupTableFindings(plain({ rows: cell(64 * 1024 + 1) }), within)),
		).toEqual([
			[CAPS, "plain: a value of 64.1 KB (Nova takes 64 KB in one cell)"],
		]);

		expect(
			lookupTableFindings(plain(), {
				dataBytes: 0,
				largestRowBytes: 256 * 1024,
			}),
		).toEqual([]);
		expect(
			names(
				lookupTableFindings(plain(), {
					dataBytes: 0,
					largestRowBytes: 256 * 1024 + 1,
				}),
			),
		).toEqual([
			[CAPS, "plain: a row of 256.1 KB (Nova takes 256 KB in one row)"],
		]);

		expect(
			lookupTableFindings(plain(), {
				dataBytes: 8 * 1024 * 1024,
				largestRowBytes: 0,
			}),
		).toEqual([]);
		expect(
			names(
				lookupTableFindings(plain(), {
					dataBytes: 8 * 1024 * 1024 + 1,
					largestRowBytes: 0,
				}),
			),
		).toEqual([[CAPS, "plain: 8.1 MB of rows (Nova takes 8 MB in one table)"]]);
	});

	it("gives a table over the row limit the rows cap alone, with CommCare HQ's total", () => {
		expect(
			names(
				lookupTableFindings(
					{ kind: "over-row-limit", table: plainTable, totalCount: 12_400 },
					NO_MEASURE,
				),
			),
		).toEqual([[CAPS, "plain: 12,400 rows (Nova takes 5,000)"]]);
	});

	it("says rows CommCare HQ could not send are a fact of the project space", () => {
		const findings = lookupTableFindings(
			{ kind: "rows-unreadable", table: plainTable },
			NO_MEASURE,
		);
		expect(findings).toEqual([
			{
				code: "table-rows-unreadable",
				standing: "fix-in-hq",
				place: { kind: "lookup-table", tag: "plain" },
				subject: null,
				detail: { name: "plain" },
			},
		]);
	});

	it("judges the tag", () => {
		const tagged = (tag: string) =>
			names(lookupTableFindings(plain({ table: { tag } }), within));
		expect(tagged("Types")).toEqual([
			["expressions-and-data/tag-types", "types"],
		]);
		expect(tagged("my_casedb")).toEqual([
			["expressions-and-data/tag-containing-casedb-or-ledgerdb", "my_casedb"],
		]);
		expect(tagged("LedgerDB")).toEqual([
			["expressions-and-data/tag-containing-casedb-or-ledgerdb", "LedgerDB"],
		]);
		expect(tagged("locations")).toEqual([
			[
				"expressions-and-data/tag-equal-to-an-instance-name-commcare-owns",
				"locations",
			],
		]);
		expect(tagged("clínicas")).toEqual([
			[
				"expressions-and-data/tag-or-field-name-with-non-ascii-letters",
				"clínicas",
			],
		]);
		expect(tagged("health.sites")).toEqual([
			[
				"expressions-and-data/tag-or-field-name-holding-a-period",
				"health.sites",
			],
		]);
		expect(tagged("xmlsites")).toEqual([["unrecognized", "xmlsites"]]);
	});

	it("judges each field name, and two fields of one name", () => {
		const fielded = (fields: readonly string[]) =>
			names(
				lookupTableFindings(plain({ table: { fields }, rows: [] }), within),
			);
		expect(fielded(["code", "first.name"])).toEqual([
			["expressions-and-data/tag-or-field-name-holding-a-period", "first.name"],
		]);
		expect(fielded(["code", "nombre_ñ"])).toEqual([
			[
				"expressions-and-data/tag-or-field-name-with-non-ascii-letters",
				"nombre_ñ",
			],
		]);
		expect(fielded(["code", "has space"])).toEqual([
			["unrecognized", "has space"],
		]);
		// A field may take an instance name CommCare owns: only a tag is its instance's id.
		expect(fielded(["code", "locations"])).toEqual([]);
	});

	it("finds a field CommCare HQ's answer names twice, once, as something to change there", async () => {
		// The retained list with `plain`'s fields as the lookup table API
		// saves a list it is sent (`resources/v0_1.py::obj_create`): `code`
		// twice and `name` three times, read by the production reader.
		const crafted = await retainedTables((objects) => {
			const table = objects.find((one) => one.tag === "plain");
			if (table === undefined) throw new Error("no retained table plain");
			table.fields = ["code", "name", "code", "name", "name"].map(
				(field_name) => ({ field_name, properties: [] }),
			);
		});
		const table = crafted.find((one) => one.tag === "plain");
		if (table === undefined) throw new Error("the crafted list lost plain");
		expect(table.fields).toEqual(["code", "name", "code", "name", "name"]);
		const findings = lookupTableFindings(readOf(table, plainRows), within);
		expect(names(findings)).toEqual([
			["table-field-repeated", "plain (the field code)"],
			["table-field-repeated", "plain (the field name)"],
		]);
		expect(findings[0]).toMatchObject({ standing: "fix-in-hq", subject: null });
	});

	it("names each field holding a character XML cannot carry, beside the other findings", () => {
		const rows = withCell(
			withCell(plainRows, 1, "name", "Hos\u0001pital"),
			0,
			"code",
			NOT_A_CHARACTER,
		);
		const findings = lookupTableFindings(
			plain({ table: { tag: "Types" }, rows }),
			NO_MEASURE,
		);
		expect(names(findings)).toEqual([
			["expressions-and-data/tag-types", "types"],
			["table-cell-unrepresentable", "Types (the field code)"],
			["table-cell-unrepresentable", "Types (the field name)"],
		]);
		expect(findings[1]).toMatchObject({ standing: "fix-in-hq", subject: null });
	});

	it("finds a table with no field, which a field added in CommCare HQ settles, with or without rows", () => {
		for (const rows of [[], plainRows]) {
			const findings = lookupTableFindings(
				plain({ table: { fields: [] }, rows }),
				within,
			);
			expect(names(findings)).toEqual([["table-has-no-fields", "plain"]]);
			expect(findings[0]).toMatchObject({ standing: "fix-in-hq" });
		}
	});
});

describe("lookupTableStanding", () => {
	it("is new where the Project has no table of the tag", () => {
		expect(standingOf(plain(), null)).toEqual({ kind: "new" });
	});

	it("is the same table where the Project's is managed from this project space, equal or not", () => {
		const managed = projectTable(
			"plain",
			[column("code")],
			[],
			origin("clinic", "commcare-hq"),
		);
		expect(standingOf(plain(), managed)).toEqual({
			kind: "same-managed",
			table: managed.table,
		});
	});

	it("asks about an equal table no app of the Project accounts for", () => {
		const existing = equalPlain();
		const standing = choiceOf(standingOf(plain(), existing));
		expect(standing.differs).toEqual([]);
		expect(standing.managed).toEqual({ by: "nova" });
		expect(standing.options).toEqual({
			"use-commcare-hq": { offered: true, goneColumns: [], retypedColumns: [] },
			"use-project": { offered: true, goneColumns: [], retypedColumns: [] },
		});
	});

	it("is the same table where an app publishes it as this very table, and asks where the mapping is another table's", () => {
		const existing = equalPlain();
		expect(
			standingOf(plain(), existing, {
				siblings: [sibling(existing.table, plainTable.id)],
			}),
		).toEqual({ kind: "same-equal", table: existing.table });
		expect(
			standingOf(plain(), existing, {
				siblings: [sibling(existing.table, "another")],
			}).kind,
		).toBe("choice");
		const managedInNova = equalPlain(origin("elsewhere", "nova"));
		expect(
			standingOf(plain(), managedInNova, {
				siblings: [sibling(managedInNova.table, plainTable.id)],
			}).kind,
		).toBe("same-equal");
	});

	it("never offers CommCare HQ's table over one another project space manages, whoever asks", () => {
		const existing = equalPlain(origin("other-space", "commcare-hq"));
		for (const mayAdminister of [true, false]) {
			const standing = choiceOf(
				standingOf(plain(), existing, {
					siblings: [sibling(existing.table, plainTable.id)],
					mayAdminister,
				}),
			);
			expect(standing.differs).toEqual([]);
			expect(standing.managed).toEqual({
				by: "commcare-hq",
				domain: "other-space",
			});
			expect(standing.options["use-commcare-hq"]).toEqual({
				offered: false,
				why: "managed-elsewhere",
				name: "other-space",
			});
		}
	});

	it("compares ordered field occurrences and their details, and keeps Project member identities in either binding", () => {
		const existing=equalPlain();
		const [code,name]=existing.table.columns;
		const lang={id:lookupMemberIdSchema.parse(uuidV7()),wireName:"lang",label:"Language"};
		const district={id:lookupMemberIdSchema.parse(uuidV7()),wireName:"district",label:"District"};
		const table={...existing.table, attributes:[district], columns:[code, {...name,repeated:true as const,properties:[lang]}]};
		const hq=plain({table:{itemAttributes:["district"],fieldProperties:{name:["lang"]}},rows:plainRows.map((row,i)=>({
			...row,itemAttributes:{district:`zone-${i}`},fields:{code:row.fields.code,name:[
				{value:"One",properties:{lang:"en"}},{value:"Une",properties:{lang:"fr"}}
			]} }))});
		const rows=existing.rows.map((row,i)=>({...row,values:{[code.id]:row.values[code.id]},attributes:{[district.id]:`zone-${i}`},occurrences:{[name.id]:[
			{text:"One",properties:{[lang.id]:"en"}},{text:"Une",properties:{[lang.id]:"fr"}}
		]}}));
		for (const siblings of [[],[sibling(table,hq.table.id)]]) {
			const standing=standingOf(hq,{table,rows},{siblings});
			expect(standing.kind).toBe(siblings.length ? "same-equal" : "choice");
			const [bound]=resolveLookupBindings([hq],{plain:standing},{plain:"use-project"},IDS);
			expect(bound.memberIds).toEqual({attributes:{district:district.id},properties:{name:{lang:lang.id}}});
		}
		const reversed=rows.map(row=>({...row,occurrences:{[name.id]:[...row.occurrences[name.id]].reverse()}}));
		const reassigned=rows.map(row=>({...row,attributes:{[district.id]:"changed"}}));
		const relabeled=rows.map(row=>({...row,occurrences:{[name.id]:row.occurrences[name.id].map(it=>({...it,properties:{[lang.id]:"changed"}}))}}));
		for(const different of [reversed,reassigned,relabeled])
			expect(choiceOf(standingOf(hq,{table,rows:different},{siblings:[sibling(table,hq.table.id)]})).differs).toEqual(["rows"]);
	});

	it("reads a missing cell as equal to an empty one", () => {
		const read = plain({ rows: withCell(plainRows, 1, "name", undefined) });
		const missing = projectTable(
			"plain",
			[column("code"), column("name")],
			[{ code: "001", name: "Clinic" }, { code: "002" }],
		);
		const empty = projectTable(
			"plain",
			[column("code"), column("name")],
			[
				{ code: "001", name: "Clinic" },
				{ code: "002", name: "" },
			],
		);
		expect(choiceOf(standingOf(read, missing)).differs).toEqual([]);
		expect(choiceOf(standingOf(read, empty)).differs).toEqual([]);
		expect(choiceOf(standingOf(plain(), empty)).differs).toEqual(["rows"]);
	});

	it("finds rows in another order different", () => {
		const reordered = projectTable(
			"plain",
			[column("code"), column("name")],
			[
				{ code: "002", name: "Hospital" },
				{ code: "001", name: "Clinic" },
			],
		);
		expect(choiceOf(standingOf(plain(), reordered)).differs).toEqual(["rows"]);
	});

	it("finds a typed column a difference, and names it among the columns that become text", () => {
		const typed = projectTable(
			"plain",
			[column("code", "int"), column("name")],
			[
				{ code: 1, name: "Clinic" },
				{ code: 2, name: "Hospital" },
			],
		);
		const standing = choiceOf(standingOf(plain(), typed));
		expect(standing.differs).toEqual(["columns", "rows"]);
		expect(standing.options["use-commcare-hq"]).toEqual({
			offered: true,
			goneColumns: [],
			retypedColumns: ["code label"],
		});
	});

	it("names the columns CommCare HQ's table lacks that stay for the apps reading the table", () => {
		const wider = projectTable(
			"plain",
			[column("code"), column("name"), column("zone")],
			[
				{ code: "001", name: "Clinic" },
				{ code: "002", name: "Hospital" },
			],
		);
		expect(
			choiceOf(standingOf(plain(), wider)).options["use-commcare-hq"],
		).toEqual({
			offered: true,
			goneColumns: ["zone label"],
			retypedColumns: [],
		});
		expect(
			choiceOf(standingOf(plain(), wider, { apps: [] })).options[
				"use-commcare-hq"
			],
		).toEqual({ offered: true, goneColumns: [], retypedColumns: [] });
	});

	it("does not offer CommCare HQ's table where the columns apps still read would take it past 250, and offers it at 250", () => {
		/* CommCare HQ's two fields, and columns of the Project's no field names. */
		const wide = (extra: number) =>
			projectTable(
				"plain",
				[
					column("code"),
					column("name"),
					...Array.from({ length: extra }, (_, at) => column(`kept_${at}`)),
				],
				[],
			);
		const keptOf = (table: ProjectTable) =>
			table.table.columns.map((each) => each.id);
		const over = wide(249);
		expect(
			choiceOf(standingOf(plain(), over, { keptColumnIds: keptOf(over) }))
				.options["use-commcare-hq"],
		).toEqual({ offered: false, why: "too-many-columns", name: "251" });
		// A field's own column is CommCare HQ's, counted once.
		const at = wide(248);
		expect(
			choiceOf(standingOf(plain(), at, { keptColumnIds: keptOf(at) })).options[
				"use-commcare-hq"
			].offered,
		).toBe(true);
		// A column no app reads and no design protects is removed, not kept.
		expect(
			choiceOf(standingOf(plain(), over, { keptColumnIds: [] })).options[
				"use-commcare-hq"
			].offered,
		).toBe(true);
		// Whoever may not administer is told that first.
		expect(
			choiceOf(
				standingOf(plain(), over, {
					keptColumnIds: keptOf(over),
					mayAdminister: false,
				}),
			).options["use-commcare-hq"],
		).toEqual({ offered: false, why: "needs-admin", name: null });
	});

	it("asks for an admin to take CommCare HQ's table", () => {
		expect(
			choiceOf(standingOf(plain(), equalPlain(), { mayAdminister: false }))
				.options["use-commcare-hq"],
		).toEqual({ offered: false, why: "needs-admin", name: null });
	});

	it("does not offer the Project's table where the app reads a column it lacks", () => {
		const narrow = projectTable(
			"plain",
			[column("code")],
			[{ code: "001" }, { code: "002" }],
		);
		expect(
			choiceOf(standingOf(plain(), narrow, { appReads: ["name", "code"] }))
				.options["use-project"],
		).toEqual({
			offered: false,
			why: "app-reads-a-missing-column",
			name: "name",
		});
		expect(
			choiceOf(standingOf(plain(), narrow, { appReads: ["code"] })).options[
				"use-project"
			],
		).toEqual({ offered: true, goneColumns: [], retypedColumns: [] });
	});

	it("asks about an equal, accounted-for table a publish would refuse for a trailing space, and takes it without that cell", () => {
		const read = plain({ rows: withCell(plainRows, 0, "name", "Clinic ") });
		const spaced = projectTable(
			"plain",
			[column("code"), column("name")],
			[
				{ code: "001", name: "Clinic " },
				{ code: "002", name: "Hospital" },
			],
		);
		const standing = choiceOf(
			standingOf(read, spaced, {
				siblings: [sibling(spaced.table, plainTable.id)],
			}),
		);
		expect(standing.differs).toEqual([]);
		expect(standing.options["use-project"]).toEqual({
			offered: false,
			why: "fails-a-project-space-rule",
			name: null,
		});
		const clean = equalPlain();
		expect(
			standingOf(plain(), clean, {
				siblings: [sibling(clean.table, plainTable.id)],
			}).kind,
		).toBe("same-equal");
	});

	it("does not offer a Project table holding a character XML cannot carry", () => {
		const broken = projectTable(
			"plain",
			[column("code"), column("name")],
			[{ code: "001", name: "Cl\u0001inic" }],
		);
		expect(
			choiceOf(standingOf(plain(), broken)).options["use-project"],
		).toEqual({
			offered: false,
			why: "fails-a-project-space-rule",
			name: null,
		});
	});
});

describe("resolveLookupBindings", () => {
	it("binds each standing as its answer says", () => {
		const read = plain();
		const managed = projectTable(
			"plain",
			[column("name")],
			[],
			origin("clinic", "commcare-hq"),
		);
		const equal = equalPlain();
		const derived = (field: string) =>
			broughtInLookupColumnId(IDS.appId, IDS.readingId, "plain", field);
		const bind = (
			standing: LookupTableStanding,
			choices: Record<string, "use-commcare-hq" | "use-project"> | null,
		) => resolveLookupBindings([read], { plain: standing }, choices, IDS)[0];

		expect(bind({ kind: "new" }, null)).toEqual({
			tag: "plain",
			tableId: broughtInLookupTableId(IDS.appId, IDS.readingId, "plain"),
			columns: { code: derived("code"), name: derived("name") },
		});
		const filled = {
			tag: "plain",
			tableId: managed.table.id,
			columns: { code: derived("code"), name: managed.table.columns[0].id },
		};
		expect(bind({ kind: "same-managed", table: managed.table }, null)).toEqual(
			filled,
		);

		const asItStands = {
			tag: "plain",
			tableId: equal.table.id,
			columns: {
				code: equal.table.columns[0].id,
				name: equal.table.columns[1].id,
			},
		};
		expect(bind({ kind: "same-equal", table: equal.table }, null)).toEqual(
			asItStands,
		);

		const choice = choiceOf(
			standingOf(read, {
				...equal,
				table: { ...equal.table, columns: [equal.table.columns[1]] },
			}),
		);
		const projectFilled = {
			tag: "plain",
			tableId: equal.table.id,
			columns: { code: derived("code"), name: equal.table.columns[1].id },
		};
		expect(bind(choice, null)).toEqual(projectFilled);
		expect(bind(choice, {})).toEqual(projectFilled);
		expect(bind(choice, { plain: "use-commcare-hq" })).toEqual(projectFilled);
		expect(bind(choice, { plain: "use-project" })).toEqual({
			tag: "plain",
			tableId: equal.table.id,
			columns: { name: equal.table.columns[1].id },
		});
	});

	it("refuses a read with no standing", () => {
		expect(() => resolveLookupBindings([plain()], {}, null, IDS)).toThrow(
			new Error("A lookup table was bound with no standing (read 1 of 1)."),
		);
	});
});

describe("readerLookupCatalog", () => {
	it("holds a text column per field in CommCare HQ's order, and a table as it stands with its own", () => {
		const binding = resolveLookupBindings(
			[plain()],
			{ plain: { kind: "new" } },
			null,
			IDS,
		)[0];
		const typed = projectTable(
			"sites",
			[column("site", "int"), column("label")],
			[],
		);
		const catalog = readerLookupCatalog([
			{ binding, name: "plain", fields: ["name", "code"] },
			{
				binding: {
					tag: "sites",
					tableId: typed.table.id,
					columns: {
						site: typed.table.columns[0].id,
						label: typed.table.columns[1].id,
					},
				},
				name: "ignored",
				fields: ["site"],
				asItStands: typed.table,
			},
		]);
		expect(catalog.definitions.get(binding.tableId)).toEqual({
			id: binding.tableId,
			name: "plain",
			tag: "plain",
			columns: [
				{
					id: binding.columns.name,
					wireName: "name",
					label: "name",
					dataType: "text",
				},
				{
					id: binding.columns.code,
					wireName: "code",
					label: "code",
					dataType: "text",
				},
			],
		});
		expect(catalog.definitions.get(typed.table.id)).toEqual({
			id: typed.table.id,
			name: "sites table",
			tag: "sites",
			columns: typed.table.columns,
		});
		expect(catalog.table("plain")?.tableId).toBe(binding.tableId);
		expect(catalog.table("plain")?.column("code")).toBe(binding.columns.code);
		expect(catalog.table("plain")?.column("constructor")).toBeUndefined();
		expect(catalog.table("unbound")).toBeUndefined();
		expect(catalog.definitions.size).toBe(2);
	});

	it("refuses a binding with no column for one of its fields, naming the field by its place", () => {
		const id = tableId();
		expect(() =>
			readerLookupCatalog([
				{
					binding: { tag: "plain", tableId: id, columns: {} },
					name: "plain",
					fields: ["code"],
				},
			]),
		).toThrow(
			new Error(
				`The lookup table bound to ${id} has no column for its field 1.`,
			),
		);
	});
});

function reviewOf(tag: string, standing: LookupTableStanding): ReviewTable {
	return {
		tag,
		standing: standing.kind,
		hqDigest: plain().canonical.digest,
		projectTable:
			standing.kind === "new"
				? null
				: {
						tableId: standing.table.id,
						definitionRevision: "3",
						rowsRevision: "4",
					},
		choice:
			standing.kind === "choice"
				? {
						differs: standing.differs,
						apps: standing.apps,
						options: standing.options,
					}
				: null,
	};
}

describe("the review's schemas", () => {
	it("take what a review answers and refuse anything else", () => {
		const choice = choiceOf(
			standingOf(plain(), equalPlain(), { mayAdminister: false }),
		);
		for (const table of [
			reviewOf("plain", choice),
			reviewOf("plain", { kind: "new" }),
		]) {
			expect(
				reviewTableSchema.parse(JSON.parse(JSON.stringify(table))),
			).toEqual(table);
		}
		const review = reviewOf("plain", choice);
		expect(reviewTableSchema.safeParse({ ...review, extra: 1 }).success).toBe(
			false,
		);
		expect(
			reviewTableSchema.safeParse({ ...review, hqDigest: "nope" }).success,
		).toBe(false);
		expect(
			reviewTableSchema.safeParse({
				...review,
				projectTable: { ...review.projectTable, rowsRevision: "-1" },
			}).success,
		).toBe(false);
		const places = { count: 12, digest: "a".repeat(64) };
		expect(reviewPlacesSchema.parse(places)).toEqual(places);
		expect(
			reviewPlacesSchema.safeParse({ count: -1, digest: "a".repeat(64) })
				.success,
		).toBe(false);
	});
});

describe("resolveTableChoices", () => {
	it("says which choices are missing, unknown and not offered, and takes a full set", () => {
		const offered = choiceOf(standingOf(plain(), equalPlain()));
		const narrowed = choiceOf(
			standingOf(plain(), equalPlain(), { mayAdminister: false }),
		);
		const tables = [
			reviewOf("open", offered),
			reviewOf("admin", narrowed),
			reviewOf("fresh", { kind: "new" }),
		];
		expect(resolveTableChoices(tables, {})).toEqual({
			ok: false,
			missing: ["open", "admin"],
			notOffered: [],
			unknown: [],
		});
		expect(
			resolveTableChoices(tables, {
				open: "keep-both",
				admin: "use-commcare-hq",
				fresh: "use-project",
				gone: "use-project",
			}),
		).toEqual({
			ok: false,
			missing: [],
			notOffered: ["admin"],
			unknown: ["fresh", "gone", "open"],
		});
		expect(
			resolveTableChoices(tables, {
				open: "use-commcare-hq",
				admin: "use-project",
			}),
		).toEqual({
			ok: true,
			choices: { open: "use-commcare-hq", admin: "use-project" },
		});
	});
});

// ---------------------------------------------------------------------------
// A reading's project data, gathered and judged
// ---------------------------------------------------------------------------

const PROJECT_ID = "project-1";
const PROJECT_REVISION = "7" as LookupRevision;
const CAPS_ENTRY =
	"expressions-and-data/table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64";

/** What a read gathers over `reads` and the Project's `tables`, through the production assembly. */
function gather(
	reads: readonly HqLookupTableRead[],
	project: {
		readonly tables?: readonly ProjectTable[];
		readonly siblings?: readonly SiblingLookupMapping[];
		readonly mayAdminister?: boolean;
		readonly keptColumns?: Readonly<Record<string, readonly string[]>>;
	} = {},
): ReadingProjectData {
	const tables = project.tables ?? [];
	return assembleReadingProjectData({
		origin: ORIGIN,
		...IDS,
		tablesReadAt: new Date("2026-11-10T09:00:00.000Z"),
		tables: reads,
		hqTags: reads.map((read) => read.table.tag),
		project: {
			projectId: PROJECT_ID,
			projectRevision: PROJECT_REVISION,
			definitions: tables.map((each) => each.table),
			rowsByTable: Object.fromEntries(
				tables.map((each) => [each.table.id, each.rows]),
			),
			apps: Object.fromEntries(tables.map((each) => [each.table.id, APPS])),
			keptColumns: project.keptColumns ?? {},
			siblings: project.siblings ?? [],
			mayAdminister: project.mayAdminister ?? true,
		},
		measured: new Map(),
		places: null,
		placesUnread: null,
	});
}

function bindingOf(data: ReadingProjectData, tag: string): LookupTableBinding {
	const binding = data.gathered.tables.find(
		(table) => table.read.table.tag === tag,
	)?.binding;
	if (binding === undefined || binding === null)
		throw new Error(`${tag} is not bound`);
	return binding;
}

/** The fields the document reads, by tag, and nothing of places. */
function readsOf(
	lookupFields: Readonly<Record<string, readonly string[]>>,
): ReaderProjectDataReads {
	return {
		lookupFields,
		unreadTables: [],
		declaredTables: [],
		readsPlaces: false,
	};
}

const PLAIN_READS = readsOf({ plain: ["code", "name"] });

/** A survey whose one question takes its choices from the table, value `code`, label `name`. */
function selectDoc(binding: LookupTableBinding): BlueprintDoc {
	return buildDoc({
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
}

const EMPTY_DOC = buildDoc({ appName: "Nothing read" });

function findingsFor(
	data: ReadingProjectData,
	reads: ReaderProjectDataReads,
	doc: BlueprintDoc | null,
): readonly Finding[] {
	return readingProjectDataFindingsFor(
		data,
		reads,
		doc,
		mintingResolver(IDS.appId),
	);
}

describe("readingLookupSnapshot", () => {
	it("holds a table that comes in as CommCare HQ's under its binding's columns, in CommCare HQ's order", () => {
		const read = plain({ rows: withCell(plainRows, 1, "name", undefined) });
		const data = gather([read]);
		const binding = bindingOf(data, "plain");
		const snapshot = readingLookupSnapshot(data, PLAIN_READS);
		expect(snapshot.projectId).toBe(PROJECT_ID);
		expect(snapshot.projectRevision).toBe(PROJECT_REVISION);
		expect(snapshot.definitions).toEqual([
			{
				id: broughtInLookupTableId(IDS.appId, IDS.readingId, "plain"),
				name: "plain",
				tag: "plain",
				definitionRevision: "0",
				columns: [
					{
						id: binding.columns.code,
						wireName: "code",
						label: "code",
						index: "unobserved",
						dataType: "text",
					},
					{
						id: binding.columns.name,
						wireName: "name",
						index: "unobserved",
						repeated: true,
						label: "name",
						dataType: "text",
					},
				],
			},
		]);
		expect(snapshot.rowsByTable.get(binding.tableId)).toEqual([
			{
				id: plainRows[0].id,
				occurrences: {
					[binding.columns.name]: [{ text: "Clinic", properties: {} }],
				},
				values: {
					[binding.columns.code]: "001",
				},
			},
			{ id: plainRows[1].id, values: { [binding.columns.code]: "002" } },
		]);
	});

	it("holds a table bound as it stands with the Project's definition and rows", () => {
		const existing = equalPlain();
		const data = gather([plain()], {
			tables: [existing],
			siblings: [sibling(existing.table, plainTable.id)],
		});
		expect(data.gathered.tables[0].standing?.kind).toBe("same-equal");
		const snapshot = readingLookupSnapshot(data, PLAIN_READS);
		expect(snapshot.definitions).toEqual([existing.table]);
		expect(snapshot.rowsByTable.get(existing.table.id)).toEqual(existing.rows);
		expect(snapshot.projectRevision).toBe(PROJECT_REVISION);
	});

	it("holds a choice as CommCare HQ's until it is answered use-project", () => {
		const existing = equalPlain();
		const data = gather([plain()], { tables: [existing] });
		const asRead = readingLookupSnapshot(data, PLAIN_READS);
		expect(asRead.definitions[0].columns.map((each) => each.label)).toEqual([
			"code",
			"name",
		]);
		expect(asRead.definitions[0].id).toBe(existing.table.id);
		const answered = readingLookupSnapshot(
			underTableChoices(data, { plain: "use-project" }),
			PLAIN_READS,
		);
		expect(answered.definitions).toEqual([existing.table]);
	});
});

/** A table of `rows` rows and `columns` text columns, as a snapshot holds one. */
function bigTable(
	tag: string,
	rows: number,
	columns: number,
): {
	readonly table: LookupTableDefinition;
	readonly rows: LookupFixtureRow[];
} {
	const ids = Array.from({ length: columns }, () => columnId());
	return {
		table: {
			id: tableId(),
			name: tag,
			tag,
			definitionRevision: "1" as LookupRevision,
			columns: ids.map((id, index) => ({
				id,
				wireName: `c${index}`,
				label: `c${index}`,
				dataType: "text" as const,
			})),
		},
		rows: Array.from({ length: rows }, (_, row) => ({
			id: `row-${row}` as LookupRowId,
			values: Object.fromEntries(ids.map((id) => [id, `v${row}`])),
		})),
	};
}

function snapshotOf(tables: readonly ReturnType<typeof bigTable>[]) {
	return {
		projectId: PROJECT_ID,
		projectRevision: PROJECT_REVISION,
		definitions: tables.map((each) => each.table),
		rowsByTable: new Map(tables.map((each) => [each.table.id, each.rows])),
	};
}

describe("lookupFixtureBudgetFinding", () => {
	it("gives the caps entry at the app for tables over one app's rows together, each within a table's cap", () => {
		const tables = ["a", "b", "c"].map((tag) => bigTable(tag, 4_000, 1));
		expect(lookupFixtureBudgetFinding(snapshotOf(tables))).toEqual(
			manifestFinding(
				CAPS_ENTRY,
				{ kind: "app" },
				"12,000 lookup table rows (Nova takes 10,000 in one app)",
			),
		);
	});

	it("gives it for two tables of 5,000 rows over one app's values, and nothing for two within it", () => {
		expect(
			lookupFixtureBudgetFinding(
				snapshotOf(["a", "b"].map((tag) => bigTable(tag, 5_000, 11))),
			),
		).toEqual(
			manifestFinding(
				CAPS_ENTRY,
				{ kind: "app" },
				"110,000 lookup table values (Nova takes 100,000 in one app)",
			),
		);
		expect(
			lookupFixtureBudgetFinding(
				snapshotOf(["a", "b"].map((tag) => bigTable(tag, 5_000, 2))),
			),
		).toBeNull();
	});
});

describe("readingProjectDataFindingsFor, a table's rows as a question's choices", () => {
	const choicesFinding = (field: string) =>
		circumstanceFinding(
			"table-choices-unusable",
			{ kind: "lookup-table", tag: "plain" },
			{ name: `plain (the field ${field})` },
		);
	const judged = (rows: readonly HqFixtureRow[]) => {
		const data = gather([plain({ rows })]);
		return findingsFor(data, PLAIN_READS, selectDoc(bindingOf(data, "plain")));
	};

	it("finds nothing where the rows can be the choices", () => {
		expect(judged(plainRows)).toEqual([]);
	});

	it("names the value column of a table with no rows", () => {
		expect(judged([])).toEqual([choicesFinding("code")]);
	});

	it("names the column of a blank value, a value with white space, a repeated value and a blank label", () => {
		expect(judged(withCell(plainRows, 0, "code", ""))).toEqual([
			choicesFinding("code"),
		]);
		expect(judged(withCell(plainRows, 0, "code", "0 01"))).toEqual([
			choicesFinding("code"),
		]);
		expect(judged(withCell(plainRows, 1, "code", "001"))).toEqual([
			choicesFinding("code"),
		]);
		expect(judged(withCell(plainRows, 1, "name", "  "))).toEqual([
			choicesFinding("name"),
		]);
	});

	it("gives one finding for a table two rules refuse, naming the first rule's column", () => {
		const rows = withCell(withCell(plainRows, 0, "code", ""), 1, "name", "");
		expect(judged(rows)).toEqual([choicesFinding("code")]);
	});

	it("judges a Project table bound as it stands with the Project's own cells", () => {
		const broken = projectTable(
			"plain",
			[column("code"), column("name")],
			[
				{ code: "001", name: "Cl\u0001inic" },
				{ code: "002", name: "Hospital" },
			],
		);
		const data = underTableChoices(gather([plain()], { tables: [broken] }), {
			plain: "use-project",
		});
		expect(
			findingsFor(data, PLAIN_READS, selectDoc(bindingOf(data, "plain"))),
		).toEqual([
			circumstanceFinding(
				"table-cell-unrepresentable",
				{ kind: "lookup-table", tag: "plain" },
				{ name: "plain (the field name)" },
			),
		]);
	});

	it("raises a table's own findings where the reader read it, and a read of a table CommCare HQ lacks", () => {
		const data = gather([plain(), readOf(richTable, richRows)]);
		expect(findingsFor(data, PLAIN_READS, null)).toEqual([]);
		const reads = {
			lookupFields: { plain: ["code"] },
			unreadTables: ["gone", "rich"],
			declaredTables: [],
			readsPlaces: false,
		};
		expect(names(findingsFor(data, reads, null))).toEqual([
			[
				"expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant",
				"gone",
			],
			...names(lookupTableFindings(readOf(richTable, richRows), NO_MEASURE)),
		]);
	});

	it("raises a form that cannot open for a table it only declares that CommCare HQ lacks, and nothing for one CommCare HQ holds", () => {
		const data = gather([plain(), readOf(richTable, richRows)]);
		const reads = {
			lookupFields: {},
			unreadTables: [],
			declaredTables: ["gone", "rich"],
			readsPlaces: false,
		};
		const findings = findingsFor(data, reads, null);
		expect(names(findings)).toEqual([
			[
				"expressions-and-data/declared-unreferenced-fixture-instance-the-project-space-does",
				"gone",
			],
		]);
		expect(findings[0]?.place).toEqual({ kind: "lookup-table", tag: "gone" });
		expect(findings[0]?.standing).toBe("fix-in-hq");
	});

	it("finds a table managed from this project space whose refresh would keep it past 250 columns, and binds nothing", () => {
		const managed = projectTable(
			"plain",
			[
				column("code"),
				column("name"),
				...Array.from({ length: 249 }, (_, at) => column(`kept_${at}`)),
			],
			[],
			origin("clinic", "commcare-hq"),
		);
		const kept = managed.table.columns.slice(2).map((each) => each.id);
		const over = gather([plain()], {
			tables: [managed],
			keptColumns: { [managed.table.id]: kept },
		});
		const [table] = over.gathered.tables;
		expect(names(table.findings)).toEqual([
			[
				CAPS_ENTRY,
				"plain: 251 columns with the ones apps still read (Nova takes 250)",
			],
		]);
		expect(table.standing).toBeNull();
		expect(table.binding).toBeNull();
		expect(over.lookups.table("plain")).toBeUndefined();
		const within = gather([plain()], {
			tables: [managed],
			keptColumns: { [managed.table.id]: kept.slice(1) },
		});
		expect(within.gathered.tables[0].standing?.kind).toBe("same-managed");
		expect(within.gathered.tables[0].findings).toEqual([]);
	});
});

describe("projectDataReadsOf", () => {
	it("reads an account's unread tags and places, and a document's tables through the bindings", () => {
		const data = gather([plain()]);
		const binding = bindingOf(data, "plain");
		const work = {
			nodes: 0,
			syntaxReads: 0,
			rebuilds: 0,
			units: 0,
			byKind: { parse: 0, propose: 0, print: 0, compare: 0, visit: 0 },
			limit: 0,
		};
		const claims = {
			counts: {},
			handOffs: [],
			records(): never {
				throw new Error("counts alone");
			},
		};
		const account: ReadOutcome = {
			kind: "account",
			findings: [],
			work,
			claims,
			defects: [],
			unreadTables: [
				{ tag: "rich", place: { kind: "lookup-table", tag: "rich" } },
				{ tag: "gone", place: { kind: "app" } },
				{ tag: "rich", place: { kind: "app" } },
				{
					tag: "rich",
					place: { kind: "lookup-table", tag: "rich" },
					declaredOnly: true,
				},
				{
					tag: "spare",
					place: { kind: "lookup-table", tag: "spare" },
					declaredOnly: true,
				},
			],
			readsLocations: true,
		};
		// A tag something reads is read, wherever else a form only declares it.
		expect(projectDataReadsOf(data, account)).toEqual({
			lookupFields: {},
			unreadTables: ["gone", "rich"],
			declaredTables: ["spare"],
			readsPlaces: true,
		});
		const read: ReadOutcome = {
			kind: "read",
			draft: {
				doc: selectDoc(binding),
				identities: {
					modules: [],
					forms: [],
					keyedCreates: [],
					columnFieldWords: [],
					entries: [],
				},
				declaration: { kind: "none", blocking: [] },
				facts: {
					webAppsOnInHq: false,
					mediaReferences: [],
					unheldMedia: [],
					pendingMedia: [],
					unreadTables: [
						{ tag: "gone", place: { kind: "lookup-table", tag: "gone" } },
					],
					foldedTranslationKeys: [],
					forms: [],
					sameStateRewrites: [],
					entryFactsRefused: [],
					childCasesUnread: [],
					rewrites: [],
					expressionRounds: 0,
				},
			},
			work,
			claims,
			defects: [],
		};
		expect(projectDataReadsOf(data, read)).toEqual({
			lookupFields: { plain: ["code", "name"] },
			unreadTables: ["gone"],
			declaredTables: [],
			readsPlaces: false,
		});
	});
});

describe("underTableChoices", () => {
	it("binds each answered tag as its answer says, with the catalog, and changes nothing else", () => {
		const existing = projectTable(
			"plain",
			[column("code", "int"), column("name")],
			[{ code: 1, name: "Clinic" }],
		);
		const fresh = plain({ table: { tag: "fresh", id: "fresh-id" } });
		const data = gather([plain(), fresh], { tables: [existing] });
		const under = underTableChoices(data, { plain: "use-project" });
		const [answered, untouched] = under.gathered.tables;
		expect(answered.choice).toBe("use-project");
		expect(answered.binding).toEqual({
			tag: "plain",
			tableId: existing.table.id,
			columns: {
				code: existing.table.columns[0].id,
				name: existing.table.columns[1].id,
			},
		});
		expect(answered.standing).toBe(data.gathered.tables[0].standing);
		expect(untouched).toBe(data.gathered.tables[1]);
		expect(under.lookups.definitions.get(existing.table.id)?.columns).toEqual(
			existing.table.columns,
		);
		expect(under.lookups.table("fresh")?.tableId).toBe(
			data.lookups.table("fresh")?.tableId,
		);
		const { tables: _tables, ...rest } = under.gathered;
		const { tables: _before, ...restBefore } = data.gathered;
		expect(rest).toEqual(restBefore);
		expect(under.organization).toBe(data.organization);
		expect(under.placesRead).toBe(data.placesRead);
		expect(data.gathered.tables[0].choice).toBeNull();
		expect(() => underTableChoices(data, { fresh: "use-project" })).toThrow(
			new Error("Answers were given for 1 lookup table(s) that ask no choice."),
		);
	});
});

describe("projectDataReview", () => {
	const review = (
		data: ReadingProjectData,
		reads: ReaderProjectDataReads,
		doc: BlueprintDoc,
	) => projectDataReview(data, reads, doc, mintingResolver(IDS.appId));

	it("answers what its schemas take: a choice exactly where a choice stands, a Project table exactly where one was met", () => {
		const existing = equalPlain();
		const fresh = plain({ table: { tag: "fresh", id: "fresh-id" } });
		const data = gather([plain(), fresh], { tables: [existing] });
		const answer = review(
			data,
			readsOf({ fresh: ["code"], plain: ["code", "name"] }),
			EMPTY_DOC,
		);
		expect(answer.places).toBeNull();
		expect(answer.tables.map((table) => [table.tag, table.standing])).toEqual([
			["fresh", "new"],
			["plain", "choice"],
		]);
		expect(answer.tables[1].projectTable).toEqual({
			tableId: existing.table.id,
			definitionRevision: "3",
			rowsRevision: "4",
		});
		const replacement = plain({
			rows: plainRows.map((row, index) => ({
				...row,
				id: `replacement-${index}`,
			})),
		});
		const replaced = review(
			gather([replacement], { tables: [existing] }),
			readsOf({ plain: ["code", "name"] }),
			EMPTY_DOC,
		);
		expect(replaced.tables[0].hqDigest).not.toBe(answer.tables[1].hqDigest);
		for (const table of answer.tables) {
			expect(
				reviewTableSchema.parse(JSON.parse(JSON.stringify(table))),
			).toEqual(table);
			expect(table.choice !== null).toBe(table.standing === "choice");
			expect(table.projectTable === null).toBe(table.standing === "new");
		}
	});

	it("judges a choice's offers with the fields the reader read", () => {
		const narrow = projectTable(
			"plain",
			[column("code")],
			[{ code: "001" }, { code: "002" }],
		);
		const data = gather([plain()], { tables: [narrow] });
		expect(
			data.gathered.tables[0].standing?.kind === "choice" &&
				data.gathered.tables[0].standing.options["use-project"].offered,
		).toBe(true);
		const [table] = review(data, PLAIN_READS, EMPTY_DOC).tables;
		expect(table.choice?.options["use-project"]).toEqual({
			offered: false,
			why: "app-reads-a-missing-column",
			name: "name",
		});
	});

	it("offers no use-project for a Project table holding a character XML cannot carry, or rows a question that reads it cannot take", () => {
		const failing = {
			offered: false,
			why: "fails-a-project-space-rule",
			name: null,
		};
		const broken = projectTable(
			"plain",
			[column("code"), column("name")],
			[{ code: "001", name: "Cl\u0001inic" }],
		);
		const brokenData = gather([plain()], { tables: [broken] });
		expect(
			review(brokenData, PLAIN_READS, selectDoc(bindingOf(brokenData, "plain")))
				.tables[0].choice?.options["use-project"],
		).toEqual(failing);

		const repeated = projectTable(
			"plain",
			[column("code"), column("name")],
			[
				{ code: "001", name: "Clinic" },
				{ code: "001", name: "Hospital" },
			],
		);
		const repeatedData = gather([plain()], { tables: [repeated] });
		expect(
			review(
				repeatedData,
				PLAIN_READS,
				selectDoc(bindingOf(repeatedData, "plain")),
			).tables[0].choice?.options["use-project"],
		).toEqual(failing);
		expect(
			review(repeatedData, PLAIN_READS, EMPTY_DOC).tables[0].choice?.options[
				"use-project"
			],
		).toEqual({ offered: true, goneColumns: [], retypedColumns: [] });
	});

	it("offers no use-project where two choices at their larger forms pass one app's values together, and both within it", () => {
		const projectOf = (tag: string, columns: number) => {
			const extra = Array.from({ length: columns - 2 }, (_, index) =>
				column(`extra${index}`),
			);
			return projectTable(
				tag,
				[column("code"), column("name"), ...extra],
				Array.from({ length: 5_000 }, (_, row) => ({
					code: `c${row}`,
					name: `n${row}`,
					...Object.fromEntries(extra.map((each) => [each.wireName, "x"])),
				})),
			);
		};
		const reads = readsOf({ alpha: ["code", "name"], beta: ["code", "name"] });
		const hqReads = [
			plain({ table: { tag: "alpha", id: "alpha-id" } }),
			plain({ table: { tag: "beta", id: "beta-id" } }),
		];
		const useProject = (columns: number) =>
			review(
				gather(hqReads, {
					tables: [projectOf("alpha", columns), projectOf("beta", columns)],
				}),
				reads,
				EMPTY_DOC,
			).tables.map((table) => table.choice?.options["use-project"]);
		expect(useProject(11)).toEqual([
			{ offered: false, why: "fails-a-project-space-rule", name: null },
			{ offered: false, why: "fails-a-project-space-rule", name: null },
		]);
		expect(useProject(2)).toEqual([
			{ offered: true, goneColumns: [], retypedColumns: [] },
			{ offered: true, goneColumns: [], retypedColumns: [] },
		]);
	});
});
