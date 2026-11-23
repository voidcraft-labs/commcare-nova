import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { describe, expect, it } from "vitest";
import { readSelectedHqLookupRows } from "@/lib/commcare/hq/lookupSource";
import {
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import { buildLookupWorkbook } from "@/lib/commcare/lookup/workbook";
import { inlineWorkbookReceipts } from "@/lib/commcare/lookup/workbookReceipt";
import { parseXml } from "@/lib/commcare/xmlParse";
import { readLookupReceipt } from "@/lib/deployment/largeLookupReceipt";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { qualifiedLookupValues } from "@/proof/targeted/documents/qualifiedLookupValues";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { emitCorpus } from "../emitCorpus";
import { hqAuthoredDocument, loadRetainedHqApp } from "../hqAuthored";
import { exportFindings } from "../publish";
import { type TargetState, withTargetPeer } from "../targetPeer";

const credentials = {
	username: "publisher",
	apiKey: "synthetic-key",
	server: "production" as const,
};
const domain = "nova-proof";
const alice = { kind: "user" as const, name: "alice", id: "worker-a" };
const team = { kind: "group" as const, name: "North Team", id: "group-north" };
const state: TargetState = {
	credentials,
	domain,
	flags: new Set(),
	caseSearchEnabled: false,
	appId: "qualified",
	commcareVersion: "2.57.0",
	cloudcareGranted: false,
	lookupOwners: [alice, team],
};

describe("the fixture upload capture reads the workbook sent by Nova", () => {
	it("reads rich rows and approved owner identities without exposing those identities on the REST list", async () => {
		const snapshot = qualifiedLookupValues().lookup;
		if (!snapshot) throw Error("Expected the qualified lookup witness.");
		const definition = snapshot.definitions[0];
		const originalRows = snapshot.rowsByTable.get(definition.id);
		if (!originalRows) throw Error("Expected the qualified rows.");
		const column = definition.columns[0].id;
		// HQ returns singleton values as scalar text on its fixture list; only
		// the selected detail carries their language and the row's own code.
		const rows = originalRows.map((row, i) =>
			i === 0
				? {
						...row,
						occurrences: {
							[column]: row.occurrences?.[column]?.slice(-1) ?? [],
						},
					}
				: row,
		);
		const rowsByTable = new Map([[definition.id, rows]]);
		const table = {
			...definition,
			workerAccess: "assigned" as const,
			columns: definition.columns.map((c) => ({
				...c,
				index: "indexed" as const,
			})),
		};
		const naming = lookupWireNaming([table]);
		const owners = new Map([
			[
				table.id,
				new Map(
					rows.map((r, i) => [
						r.id,
						{
							users: i === 0 ? ["ALICE"] : [],
							groups: i === 1 ? ["North Team"] : [],
							locations: [],
						},
					]),
				),
			],
		]);
		await withTargetPeer(state, async (peer) => {
			const send = () =>
				uploadLookupTableWorkbook(
					credentials,
					domain,
					buildLookupWorkbook(naming, rowsByTable, owners).bytes,
					{ replace: true },
				);
			expect(await send()).toMatchObject({ success: true });
			const stored = peer.snapshot().tables[0];
			expect(stored).toMatchObject({
				isGlobal: false,
				fields: [{ isIndexed: true }],
				rows: [{ owners: [alice] }, { owners: [team] }],
			});
			const listed = await listHqLookupTables(credentials, domain);
			if ("success" in listed) throw Error("Expected the native table list.");
			const read = await readSelectedHqLookupRows(
				credentials,
				domain,
				listed[0],
				{ maxRows: 10, maxBytes: 1_000_000 },
			);
			if ("success" in read || "kind" in read)
				throw Error(
					`Expected the selected rich row details: ${JSON.stringify(read)}; requests: ${JSON.stringify(peer.requests.map((r) => [r.method, r.path]))}`,
				);
			expect(read.rows.map((r) => r.itemAttributes)).toEqual([
				{ code: "north" },
				{ code: "east" },
			]);
			const col = table.columns[0].wireName;
			expect(read.rows.map((r) => r.fields[col])).toEqual([
				[{ value: "Nord", properties: { lang: "fr" } }],
				[
					{ value: "East", properties: { lang: "en" } },
					{ value: "Est", properties: { lang: "fr" } },
				],
			]);
			expect(read.rows.every((r) => !Object.hasOwn(r, "owners"))).toBe(true);
			const intended = inlineWorkbookReceipts(
				{ ...snapshot, definitions: [table], rowsByTable },
				new Set([table.id]),
			).get(table.id);
			if (!intended) throw Error("Expected the workbook's audience and rows.");
			const landed = await readLookupReceipt(
				credentials,
				domain,
				listed[0],
				intended,
			);
			expect(landed).toMatchObject({
				canonical: {
					rowCount: 2,
					isGlobal: false,
					rowsDigest: intended.digest,
				},
			});
			expect(
				await readLookupReceipt(credentials, domain, listed[0], {
					...intended,
					isGlobal: true,
				}),
			).toEqual({ kind: "unverified-target" });
			const changed = rows.map((row, i) =>
				i === 0 ? { ...row, attributes: {} } : row,
			);
			const changedIntent = inlineWorkbookReceipts(
				{
					...snapshot,
					definitions: [table],
					rowsByTable: new Map([[table.id, changed]]),
				},
				new Set([table.id]),
			).get(table.id);
			if (!changedIntent) throw Error("Expected the altered row control.");
			expect(
				await readLookupReceipt(credentials, domain, listed[0], changedIntent),
			).toEqual({ kind: "unverified-target" });
			owners
				.get(table.id)
				?.set(rows[1].id, { users: [], groups: ["north team"], locations: [] });
			expect(await send()).toMatchObject({
				success: false,
				mayHaveLanded: true,
			});
			expect(peer.snapshot().tables[0].id).toBe(stored.id);
			expect(peer.snapshot().tables[0].rows[1].owners ?? []).toEqual([]);
			expect(peer.unexpected).toEqual([]);
		});
	});
});

it.each(["hq-expressions", "hq-lookups", "hq-search"])(
	"keeps %s's lookup data in the original project space during admission",
	async (id) => {
		const app = await hqAuthoredDocument(loadRetainedHqApp(id));
		expect(app.lookup?.definitions.length).toBeGreaterThan(0);
		for (const table of app.lookup?.definitions ?? []) {
			expect(table.hq?.managedBy).toBe("commcare-hq");
			for (const row of app.lookup?.rowsByTable.get(table.id) ?? [])
				expect(lookupRowIdSchema.safeParse(row.id).success).toBe(true);
			expect(table.hq?.source?.distribution).toBe("global");
			expect(table.columns.every((c) => c.index === "unobserved")).toBe(true);
		}
	},
);

it.each(["hq-expressions", "hq-lookups", "hq-search"])(
	"emits %s's actual republish, local worker fixture and source-bound manual package",
	{ timeout: 45_000 },
	async (id) => {
		const retained = loadRetainedHqApp(id);
		const app = await hqAuthoredDocument(retained);
		const out = await mkdtemp(join(tmpdir(), "nova-lookup-source-emission-"));
		try {
			const { index } = await emitCorpus({
				out,
				seed: DEFAULT_CORPUS_SEED,
				sample: 0,
				fixed: [app],
				sampled: [],
				jobs: 1,
			});
			expect(index.census.fixed.refused).toEqual([]);
			expect(index.documents.map(({ id }) => id)).toEqual([id]);
			const root = join(out, id);
			const manual = new AdmZip(await readFile(join(root, "import-file.zip")));
			const guide = manual.readAsText("README.txt");
			expect(
				manual.getEntries().some((entry) => entry.entryName.endsWith(".xlsx")),
			).toBe(false);
			const archivePath = join(root, "local.ccz");
			const webOnly = app.doc.appSettings?.runsOnlyOn === "web-apps";
			expect(webOnly).toBe(id === "hq-search");
			if (webOnly)
				await expect(readFile(archivePath)).rejects.toMatchObject({
					code: "ENOENT",
				});
			const fixtures = webOnly
				? []
				: new AdmZip(await readFile(archivePath))
						.getEntries()
						.filter((entry) => entry.entryName.endsWith("suite.xml"))
						.flatMap((entry) =>
							findAll(
								(element) => element.name === "fixture",
								parseXml(entry.getData().toString("utf8")).children,
							),
						);
			const foreign = await exportFindings(
				{ ...app, compiledAtSeq: 1 },
				"hq-upload",
				"another-proof-space",
			);
			expect(foreign.length).toBeGreaterThan(0);
			for (const finding of foreign) {
				expect(finding).toMatchObject({
					code: "LOOKUP_WORKER_SOURCE_UNAVAILABLE",
					details: { delivery: "source-reference" },
				});
				const table = app.lookup?.definitions.find(
					(table) => table.id === finding.details?.tableId,
				);
				if (!table) throw Error("The held table has no source definition.");
				expect(guide).toContain(
					`“${table.tag}” uses the existing table in nova-proof`,
				);
				if (webOnly) continue;
				const xml = fixtures.filter(
					(fixture) => fixture.attribs.id === `item-list:${table.tag}`,
				);
				expect(xml).toHaveLength(1);
				const list = xml[0].children.filter(isTag);
				expect(list.map((node) => node.name)).toEqual([`${table.tag}_list`]);
				const rows = list[0].children
					.filter(isTag)
					.map((row) =>
						Object.fromEntries(
							row.children
								.filter(isTag)
								.map((field) => [field.name, textContent(field)]),
						),
					);
				const receipt = retained.fixtureRows?.[table.tag];
				if (!receipt?.body)
					throw Error("The retained source inventory is missing.");
				const { objects } = JSON.parse(receipt.body) as {
					objects: { fields: Record<string, string> }[];
				};
				expect(rows).toEqual(objects.map((row) => row.fields));
			}
			expect(guide).toContain("selected-table export");
			expect(guide).toContain("different data");
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	},
);

it("republishes the qualified worker lookup unchanged through the whole publish capture", {
	timeout: 45_000,
}, async () => {
	const app = qualifiedLookupValues();
	const out = await mkdtemp(join(tmpdir(), "nova-qualified-lookup-"));
	try {
		const { index } = await emitCorpus({
			out,
			seed: DEFAULT_CORPUS_SEED,
			sample: 0,
			fixed: [app],
			sampled: [],
			jobs: 1,
		});
		expect(index.census.fixed.refused).toEqual([]);
		expect(index.documents.map((d) => d.id)).toEqual([app.id]);
		const republish = JSON.parse(
			await readFile(
				join(out, app.id, "export", "minimum", "republish.json"),
				"utf8",
			),
		);
		expect(republish.confirmed).toBeUndefined();
		const [table] = republish.assumedResources.lookupTables;
		expect(
			table.rows.map(
				(row: { item_attributes: { code: string } }) =>
					row.item_attributes.code,
			),
		).toEqual(["north", "east"]);
		expect(
			table.rows.map(
				(row: {
					fields: { name: { field_list: { properties: { lang: string } }[] } };
				}) => row.fields.name.field_list.map((item) => item.properties.lang),
			),
		).toEqual([
			["en", "fr"],
			["en", "fr"],
		]);
	} finally {
		await rm(out, { recursive: true, force: true });
	}
});
